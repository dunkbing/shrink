// 7z cases (docs/FORMATS.md, section 12) against the real 7zz.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sevenzip, unixMode } from "../src/formats/sevenzip.format";
import { env, type Env } from "./fake";
import { posix } from "./lib/platform";
import { lorem, noise } from "./lib/zip";

// 7zz (Homebrew, 7-Zip.org), or 7z / 7zip (Debian, Windows)
const SZ = ["7zz", "7z", "7zip"].find((n) => Bun.which(n)) ?? "7zz";
const have = Bun.which(SZ) !== null;
const t = have ? test : test.skip;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [sevenzip], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const sz = (...a: string[]) => Bun.spawnSync([SZ, ...a], { stdout: "pipe", stderr: "pipe" });

/** A folder with text, a binary, an empty dir and a symlink, packed with the given 7z switches. */
function build(e: Env, name: string, switches: string[], extra: (dir: string) => void = () => {}) {
  const src = join(e.dir, "src-" + name);
  mkdirSync(join(src, "empty"), { recursive: true });
  mkdirSync(join(src, "sub"), { recursive: true });
  for (let i = 0; i < 8; i++) writeFileSync(join(src, `f${i}.txt`), lorem(30000, i + 1));
  writeFileSync(join(src, "sub", "r.bin"), noise(4000));
  if (posix) symlinkSync("f0.txt", join(src, "link"));
  utimesSync(join(src, "f1.txt"), 1600000000, 1600000000);
  if (posix) chmodSync(join(src, "f2.txt"), 0o664); // group-writable: a plain extraction under umask 022 would lose it
  if (posix) chmodSync(join(src, "f3.txt"), 0o755);
  extra(src);
  const out = join(e.dir, name);
  const r2 = Bun.spawnSync([SZ, "a", "-t7z", "-snl", ...switches, out, "."], { cwd: src, stdout: "pipe", stderr: "pipe" });
  expect(r2.exitCode).toBe(0);
  return out;
}
const listing = (p: string) => sz("l", "-slt", p).stdout.toString().replace(/\r\n/g, "\n").replace(/^.*?----------\n/s, "").replace(/Packed Size = .*\n|Method = .*\n|Block = .*\n/g, "");

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
  Bun.spawnSync([SZ, "a", "-t7z", "-v20k", join(e.dir, "mv.7z"), "."], { cwd: src });
  const part = join(e.dir, "mv.7z.001");
  const before = readFileSync(part);
  const r = await e.engine.optimizeFile(part);
  expect(r.status).toBe("skipped");
  expect(readFileSync(part).equals(before)).toBe(true);
});

t("7Z-05: executable filters (BCJ) are kept when they help", async () => {
  const e = make({ level: 9 });
  const bin = new Uint8Array(readFileSync(process.execPath)).subarray(1 << 20, (1 << 20) + 400000) // some real machine code;
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
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {}, tools: { locate: async () => [SZ] }, run: async (tool: string, args: string[]) => { const r = Bun.spawnSync([tool === "7zz" ? SZ : tool, ...args], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; } };
  const prepared = await sevenzip.oracle.prepare!(orig, ctx);
  const src = join(e.dir, "alt");
  const variants: Record<string, (d: string) => void> = {
    changed: (d) => writeFileSync(join(d, "f2.txt"), lorem(30000, 99)),
    dropped: (d) => rmSync(join(d, "f3.txt")),
    ...(posix ? { mode: (d: string) => chmodSync(join(d, "f4.txt"), 0o700) } : {}),
  };
  for (const [k, f] of Object.entries(variants)) {
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
    const x = Bun.spawnSync([SZ, "x", "-snl", `-o${src}`, orig], { stdout: "pipe", stderr: "pipe" });
    f(src);
    const out = join(e.dir, `${k}.7z`);
    const a = Bun.spawnSync([SZ, "a", "-snl", out, "."], { cwd: src, stdout: "pipe", stderr: "pipe" });
    expect(await sevenzip.oracle.same(prepared, out, ctx), `${k}: x=${x.exitCode} a=${a.exitCode} orig=${(listing(orig).match(/(Path|CRC) = .*/g) ?? []).join(" ")} new=${(listing(out).match(/(Path|CRC) = .*/g) ?? []).join(" ")}`).not.toBe(true);
  }
});

t("an archive without stored times repacks, and unix modes survive the repack", async () => {
  const e = make({ level: 7 });
  const p = build(e, "nt.7z", ["-mx=1", "-mtm=off"]);
  expect(listing(p)).toContain("Modified = \n");
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  if (posix) {
    expect(listing(p)).toContain("-rw-rw-r--");
    expect(listing(p)).toContain("-rwxr-xr-x");
  }
});

test("unixMode reads the attribute text", () => {
  expect(unixMode("A -rw-rw-r--")).toBe(0o664);
  expect(unixMode("A -rwsr-xr-x")).toBe(0o4755);
  expect(unixMode("D drwxrwxrwt")).toBe(0o1777);
  expect(unixMode("A")).toBeNull();
});
