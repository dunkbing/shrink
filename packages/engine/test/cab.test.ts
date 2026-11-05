// CAB cases (docs/FORMATS.md section 12, tier 3).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cab } from "../src/formats/cab.format";
import { parseCab } from "../src/formats/cab-parse";
import { env, type Env } from "./fake";
import { makeCab } from "./lib/cab";
import { lorem, noise } from "./lib/zip";

const tool = !!Bun.which("cabextract");
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [cab], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const a = lorem(150000, 2), b = lorem(40000, 9);

/** File name to bytes, as cabextract extracts them. */
function extract(p: Buffer | string) {
  const dir = mkdtempSync(join(tmpdir(), "shrink-cab-"));
  const file = typeof p === "string" ? p : join(dir, "in.cab");
  if (typeof p !== "string") Bun.write(file, p);
  return Bun.spawn(["cabextract", "-q", "-d", dir, file]).exited.then(() => ({ dir, text: (n: string) => readFileSync(join(dir, n)).toString() }));
}

test.skipIf(!tool)("CAB-01: an MSZIP cabinet gets better blocks; file table and extracted bytes are equal", async () => {
  const e = make();
  const p = await e.file("a.cab", makeCab([{ files: [{ name: "a.txt", data: a }, { name: "dir\\b.txt", data: b }], history: true }]));
  const before = parseCab(new Uint8Array(readFileSync(p)));
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const after = parseCab(new Uint8Array(readFileSync(p)));
  expect(after.files).toEqual(before.files);
  const x = await extract(p);
  expect(x.text("a.txt")).toBe(a);
  expect(x.text("dir/b.txt")).toBe(b);
});

test.skipIf(!tool)("CAB-02: a stored folder becomes MSZIP, an incompressible one stays stored", async () => {
  const e = make();
  const p = await e.file("s.cab", makeCab([{ type: 0, files: [{ name: "t.txt", data: a }] }, { type: 0, files: [{ name: "n.bin", data: noise(5000) }] }]));
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const c = parseCab(new Uint8Array(readFileSync(p)));
  expect(c.folders.map((f) => f.type & 15)).toEqual([1, 0]);
  expect((await extract(p)).text("t.txt")).toBe(a);
});

test("CAB-03: multi-cabinet sets, reserve areas and trailing data are skipped untouched", async () => {
  const e = make();
  const base = makeCab([{ files: [{ name: "a.txt", data: a }] }]);
  const next = makeCab([{ files: [{ name: "a.txt", data: a }] }], { flags: 2 });
  const reserve = makeCab([{ files: [{ name: "a.txt", data: a }] }], { flags: 4 });
  for (const [n, buf] of [["next.cab", next], ["res.cab", reserve], ["tail.cab", Buffer.concat([base, Buffer.from("signature!")])]] as const) {
    const p = await e.file(n, buf);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(readFileSync(p).equals(buf)).toBe(true);
  }
});

test("COMMON-05 for cab: truncated and corrupt cabinets are untouched and reported damaged", async () => {
  const e = make();
  const src = makeCab([{ files: [{ name: "a.txt", data: a }] }]);
  const bad = Buffer.from(src);
  bad[bad.length - 30] ^= 0xff;
  for (const [n, buf] of [["cut.cab", src.subarray(0, src.length - 50)], ["hdr.cab", src.subarray(0, 40)], ["bad.cab", bad]] as const) {
    const p = await e.file(n, buf);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(readFileSync(p).equals(buf)).toBe(true);
  }
});

test.skipIf(!tool)("COMMON-08 for cab: the oracle rejects other bytes, other names and other sizes", async () => {
  const e = make();
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {}, tools: { locate: async (n: string) => (Bun.which(n) ? [Bun.which(n)!] : null) }, run: async (t: string, args: string[]) => {
    const r = Bun.spawnSync([Bun.which(t)!, ...args]);
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } };
  const files = (x: string, name = "a.txt") => [{ name, data: x }];
  const prepared = await cab.oracle.prepare!(await e.file("o.cab", makeCab([{ files: files(a) }])), ctx);
  expect(await cab.oracle.same(prepared, await e.file("d.cab", makeCab([{ files: files(a.replace("alpha", "omega")) }])), ctx)).toContain("differ");
  expect(await cab.oracle.same(prepared, await e.file("n.cab", makeCab([{ files: files(a, "z.txt") }])), ctx)).toContain("file table");
  expect(await cab.oracle.same(prepared, await e.file("s.cab", makeCab([{ files: files(a + "x") }])), ctx)).toContain("file table");
  expect(await cab.oracle.same(prepared, await e.file("ok.cab", makeCab([{ files: files(a), level: 9 }])), ctx)).toBe(true);
});

test("a second run changes nothing (idempotence)", async () => {
  const e = make({ skipOptimized: false });
  const p = await e.file("a.cab", makeCab([{ files: [{ name: "a.txt", data: a }] }]));
  await e.engine.optimizeFile(p);
  const once = readFileSync(p);
  expect((await e.engine.optimizeFile(p)).status).toBe("unchanged");
  expect(readFileSync(p).equals(once)).toBe(true);
});
