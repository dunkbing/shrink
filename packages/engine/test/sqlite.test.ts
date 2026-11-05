// SQLite cases (docs/FORMATS.md, section 13) with the real sqlite3.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Engine } from "../src/optimize";
import { formats as sqliteFormats } from "../src/formats/sqlite.format";
import { env, type Env } from "./fake";
import { fakeTool, fragmentedDb, sqlite } from "./lib/web";

const have = Bun.which("sqlite3") !== null;
const t = have ? test : test.skip;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: sqliteFormats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const q = (p: string, sql: string) => Bun.spawnSync(["sqlite3", p, sql]).stdout.toString().trim();

t("SQL-01 and SQL-02: a fragmented database shrinks; schema, view, trigger, index and pragmas survive", async () => {
  const e = make();
  const p = e.dir + "/a.sqlite";
  fragmentedDb(p);
  const dump = Bun.spawnSync(["sqlite3", p, ".dump"]).stdout.toString();
  const before = statSync(p).size;
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(statSync(p).size).toBeLessThan(before);
  expect(Bun.spawnSync(["sqlite3", p, ".dump"]).stdout.toString()).toBe(dump);
  expect(q(p, "PRAGMA integrity_check")).toBe("ok");
  expect(q(p, "PRAGMA user_version")).toBe("7");
  expect(q(p, "PRAGMA application_id")).toBe("1234");
  expect(q(p, "SELECT count(*) FROM sqlite_master WHERE type IN ('table','index','view','trigger')")).toBe("5");
});

t("SQL-03: a database with a -wal, -shm or -journal file next to it is skipped", async () => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const e = make();
    const p = e.dir + "/a.sqlite";
    fragmentedDb(p);
    writeFileSync(p + suffix, "x");
    const bytes = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("in use");
    expect(readFileSync(p)).toEqual(bytes);
  }
});

t("SQL-03 (WAL mode): a WAL-mode database is left alone", async () => {
  const e = make();
  const p = e.dir + "/w.sqlite";
  fragmentedDb(p, "PRAGMA journal_mode=WAL;");
  const bytes = readFileSync(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(readFileSync(p)).toEqual(bytes);
});

t("SQL-04: an encrypted or non-SQLite file with a database name is skipped as not a database", async () => {
  const e = make();
  const noise = new Uint8Array(8192).map((_, i) => (i * 7919 + (i >> 3) * 31) & 255);
  const p = await e.file("enc.db", noise);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("not a valid");
  expect(readFileSync(p)).toEqual(Buffer.from(noise));
});

t("SQL-05: auto_vacuum mode is kept", async () => {
  const e = make();
  const p = e.dir + "/av.sqlite";
  sqlite(p, "PRAGMA auto_vacuum=2; CREATE TABLE t(a); WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<3000) INSERT INTO t SELECT zeroblob(100) FROM c; DELETE FROM t WHERE rowid % 2 = 0;");
  expect(q(p, "PRAGMA auto_vacuum")).toBe("2");
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged"]).toContain(r.status);
  expect(q(p, "PRAGMA auto_vacuum")).toBe("2");
  expect(q(p, "PRAGMA integrity_check")).toBe("ok");
});

t("SQL-06: a truncated or corrupt database is left untouched", async () => {
  const e = make();
  const src = e.dir + "/src.sqlite";
  fragmentedDb(src);
  const full = readFileSync(src);
  const cut = await e.file("cut.sqlite", full.subarray(0, full.length - 5000));
  const flipped = Buffer.from(full);
  for (let i = 4096 * 3; i < 4096 * 3 + 200; i++) flipped[i] ^= 0xff;
  const bad = await e.file("bad.sqlite", flipped);
  for (const p of [cut, bad]) {
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(["skipped", "unchanged"]).toContain(r.status);
    expect(readFileSync(p)).toEqual(before);
  }
  expect((await e.engine.optimizeFile(cut)).reason ?? "").toContain("damaged");
});

t("COMMON-08 (SQLite): a tool that drops a row or changes user_version is rejected", async () => {
  const e = make();
  const p = e.dir + "/a.sqlite";
  fragmentedDb(p);
  const bytes = readFileSync(p);
  for (const [label, sql] of [["row", "DELETE FROM loose WHERE a=1;"], ["pragma", "PRAGMA user_version=8;"], ["value", "UPDATE t SET name='zz' WHERE id=3;"]]) {
    // VACUUM INTO runs for real, then the output is altered; every other call (the oracle's) goes to the real sqlite3
    const liar = await fakeTool(
      e.dir,
      `liar-${label}`,
      `const real = Bun.which("sqlite3");
if (!String(args[2]).includes("VACUUM INTO")) pass(real, args);
if (run(real, args).status !== 0) process.exit(1);
run(real, [/VACUUM INTO '(.*)'/.exec(args[2])[1], ${JSON.stringify(sql)}]);`,
    );
    const engine = new Engine({ formats: sqliteFormats, cacheDir: e.dir + "/c-" + label, tempDir: e.dir + "/tmp", settings: { toolPaths: { sqlite3: liar } } });
    const r = await engine.optimizeFile(p);
    expect(r.steps[0], label).toMatchObject({ outcome: "rejected" });
    expect(readFileSync(p)).toEqual(bytes);
  }
});

t("COMMON (SQLite): idempotent, never larger, tiny file skipped, level 7 page-size step", async () => {
  const e = make({ level: 7 });
  const p = e.dir + "/a.sqlite";
  fragmentedDb(p);
  const r1 = await e.engine.optimizeFile(p);
  expect(r1.after).toBeLessThanOrEqual(r1.before);
  const bytes = readFileSync(p);
  const r2 = await e.engine.optimizeFile(p);
  expect(r2.status).not.toBe("optimized");
  expect(readFileSync(p)).toEqual(bytes);
  const tiny = await e.file("t.sqlite", "SQLite format 3\0");
  expect((await e.engine.optimizeFile(tiny)).status).toBe("skipped");
  expect((await e.engine.optimizeFile(await e.file("e.sqlite", ""))).status).toBe("skipped");
});
