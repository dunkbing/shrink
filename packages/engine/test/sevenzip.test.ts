// 7z cases (docs/FORMATS.md, section 12) against the real 7zz.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sevenzip } from "../src/formats/sevenzip.format";
import { env, type Env } from "./fake";
import { lorem, noise } from "./lib/zip";

const have = Bun.which("7zz") !== null;
const t = have ? test : test.skip;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [sevenzip], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const sz = (...a: string[]) => Bun.spawnSync(["7zz", ...a], { stdout: "pipe", stderr: "pipe" });

/** A folder with text, a binary, an empty dir and a symlink, packed with the given 7z switches. */
function build(e: Env, name: string, switches: string[], extra: (dir: string) => void = () => {}) {
  const src = join(e.dir, "src-" + name);
  mkdirSync(join(src, "empty"), { recursive: true });
  mkdirSync(join(src, "sub"), { recursive: true });
  for (let i = 0; i < 8; i++) writeFileSync(join(src, `f${i}.txt`), lorem(30000, i + 1));
  writeFileSync(join(src, "sub", "r.bin"), noise(4000));
  symlinkSync("f0.txt", join(src, "link"));
  utimesSync(join(src, "f1.txt"), 1600000000, 1600000000);
  extra(src);
  const out = join(e.dir, name);
  const r2 = Bun.spawnSync(["7zz", "a", "-t7z", "-snl", ...switches, out, "."], { cwd: src, stdout: "pipe", stderr: "pipe" });
  expect(r2.exitCode).toBe(0);
  return out;
}
const listing = (p: string) => sz("l", "-slt", p).stdout.toString().replace(/^.*?----------\n/s, "").replace(/Packed Size = .*\n|Method = .*\n|Block = .*\n/g, "");

t("7Z-01: a weakly packed archive is repacked smaller; the listing is equal", async () => {
  const e = make({ level: 7 });
  const p = build(e, "a.7z", ["-mx=1", "-ms=off"]);
  const before = listing(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(listing(p)).toBe(before);
  expect(sz("t", p).exitCode).toBe(0);
});

t("7Z-02: a solid archive and a non-solid one both repack with equal listings", async () => {
  const e = make({ level: 7 });
  for (const s of ["-ms=on", "-ms=off"]) {
    const p = build(e, `s${s}.7z`, ["-mx=3", s]);
    const before = listing(p);
    await e.engine.optimizeFile(p);
    expect(listing(p)).toBe(before);
  }
});

t("7Z-03: an encrypted archive is skipped", async () => {
  const e = make({ level: 7 });
  const p = build(e, "enc.7z", ["-mx=1", "-pSecret", "-mhe=on"]);
  const h = build(e, "enc2.7z", ["-mx=1", "-pSecret"]);
  for (const f of [p, h]) {
    const before = readFileSync(f);
    const r = await e.engine.optimizeFile(f);
    expect(r.status).toBe("skipped");
    expect(readFileSync(f).equals(before)).toBe(true);
  }
});

t("7Z-04: a multi-volume part is skipped", async () => {
  const e = make({ level: 7 });
  const src = join(e.dir, "mv");
  mkdirSync(src);
  writeFileSync(join(src, "big.bin"), noise(60000));
  Bun.spawnSync(["7zz", "a", "-t7z", "-v20k", join(e.dir, "mv.7z"), "."], { cwd: src });
  const part = join(e.dir, "mv.7z.001");
  const before = readFileSync(part);
  const r = await e.engine.optimizeFile(part);
  expect(r.status).toBe("skipped");
  expect(readFileSync(part).equals(before)).toBe(true);
});

t("7Z-05: executable filters (BCJ) are kept when they help", async () => {
  const e = make({ level: 9 });
  const bin = new Uint8Array(readFileSync("/bin/ls"));
  const p = build(e, "x.7z", ["-mx=1", "-mf=off"], (src) => writeFileSync(join(src, "ls"), bin));
  const before = readFileSync(p).length;
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(readFileSync(p).length).toBeLessThan(before);
});

t("a truncated or corrupt 7z is untouched", async () => {
  const e = make({ level: 7 });
  const p = build(e, "d.7z", ["-mx=1"]);
  const b = readFileSync(p);
  const cut = await e.file("cut.7z", b.subarray(0, b.length - 100));
  const bad = Buffer.from(b);
  bad[200] ^= 0xff;
  const flip = await e.file("flip.7z", bad);
  for (const f of [cut, flip]) {
    const r = await e.engine.optimizeFile(f);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
  }
});

t("COMMON-08 for 7z: the oracle rejects a different file, a dropped file and a changed attribute", async () => {
  const e = make({ level: 7 });
  const orig = build(e, "o.7z", ["-mx=1"]);
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {}, tools: { locate: async () => ["7zz"] }, run: async (tool: string, args: string[]) => { const r = Bun.spawnSync([tool, ...args], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; } };
  const prepared = await sevenzip.oracle.prepare!(orig, ctx);
  const src = join(e.dir, "alt");
  const variants: Record<string, (d: string) => void> = {
    changed: (d) => writeFileSync(join(d, "f2.txt"), lorem(30000, 99)),
    dropped: (d) => Bun.spawnSync(["rm", join(d, "f3.txt")]),
    mode: (d) => Bun.spawnSync(["chmod", "700", join(d, "f4.txt")]),
  };
  for (const [k, f] of Object.entries(variants)) {
    Bun.spawnSync(["rm", "-rf", src]);
    Bun.spawnSync(["mkdir", "-p", src]);
    Bun.spawnSync(["7zz", "x", "-snl", `-o${src}`, orig]);
    f(src);
    const out = join(e.dir, `${k}.7z`);
    Bun.spawnSync(["7zz", "a", "-snl", out, "."], { cwd: src });
    expect(await sevenzip.oracle.same(prepared, out, ctx)).not.toBe(true);
  }
});
