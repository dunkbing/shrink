// TAR cases (docs/FORMATS.md, section 12).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { png } from "../src/formats/png.format";
import { tar } from "../src/formats/tar.format";
import { parseTar } from "../src/formats/tar-parse";
import { env, type Env } from "./fake";
import { makePng } from "./lib/png";
import { lorem } from "./lib/zip";

const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [tar, png], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const oct = (v: number, n: number) => Buffer.from(v.toString(8).padStart(n - 1, "0") + "\0");
/** One tar header + data, written by hand (ustar). */
function entry(name: string, data: Uint8Array | string, o: { type?: string; mode?: number; uid?: number; mtime?: number; link?: string } = {}) {
  const d = Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  oct(o.mode ?? 0o644, 8).copy(h, 100);
  oct(o.uid ?? 1000, 8).copy(h, 108);
  oct(1000, 8).copy(h, 116);
  oct(d.length, 12).copy(h, 124);
  oct(o.mtime ?? 1700000000, 12).copy(h, 136);
  h.fill(32, 148, 156);
  h[156] = (o.type ?? "0").charCodeAt(0);
  h.write(o.link ?? "", 157);
  h.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const v of h) sum += v;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, d, Buffer.alloc((512 - (d.length % 512)) % 512)]);
}
const paxRecord = (k: string, v: string) => {
  let len = k.length + v.length + 3;
  len += String(len).length;
  if (String(len).length !== String(k.length + v.length + 3 + String(len).length).length) len++;
  return `${len} ${k}=${v}\n`;
};
const end = Buffer.alloc(1024);
const img = makePng({ width: 64, height: 64, colorType: 2, bitDepth: 8, compression: 0 });
const sample = () =>
  Buffer.concat([
    entry("dir/", "", { type: "5", mode: 0o755 }),
    entry("dir/a.txt", lorem(3000), { mtime: 1600000000, uid: 42 }),
    entry("dir/pic.png", img, { mode: 0o600 }),
    entry("link", "", { type: "2", link: "dir/a.txt" }),
    end,
  ]);

test("TAR-01: with recurse off the tar is untouched", async () => {
  const e = make();
  const p = await e.file("a.tar", sample());
  const before = readFileSync(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(readFileSync(p).equals(before)).toBe(true);
});

test("TAR-02: with recurse on, members are optimised and headers (mode, uid, mtime) stay", async () => {
  const e = make({ archive: { recurse: true } });
  const src = sample();
  const p = await e.file("a.tar", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const a = parseTar(new Uint8Array(src)).entries, b = parseTar(new Uint8Array(readFileSync(p))).entries;
  expect(b.map((x) => [x.name, x.type, x.mode, x.uid, x.gid, x.mtime, x.linkname])).toEqual(a.map((x) => [x.name, x.type, x.mode, x.uid, x.gid, x.mtime, x.linkname]));
  expect(b[2].size).toBeLessThan(a[2].size);
  expect(b[1].size).toBe(a[1].size);
});

test("TAR-03: long names and pax headers survive", async () => {
  const long = "very/long/".repeat(20) + "file.png";
  const pax = paxRecord("path", long) + paxRecord("mtime", "1700000000.5");
  const src = Buffer.concat([entry("PaxHeaders/x", pax, { type: "x" }), entry("short", img), entry("././@LongLink", long + "\0", { type: "L" }), entry("trunc", lorem(2000)), end]);
  const e = make({ archive: { recurse: true } });
  const p = await e.file("a.tar", src);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const b = parseTar(new Uint8Array(readFileSync(p))).entries;
  expect(b.map((x) => x.name)).toEqual([long, long]);
  expect(b[0].pax.mtime).toBe("1700000000.5");
});

test("TAR-04: special files are carried over unchanged", async () => {
  const src = Buffer.concat([entry("fifo", "", { type: "6" }), entry("dev", "", { type: "3" }), entry("hard", "", { type: "1", link: "x" }), entry("f.png", img), end]);
  const e = make({ archive: { recurse: true } });
  const p = await e.file("a.tar", src);
  await e.engine.optimizeFile(p);
  expect(parseTar(new Uint8Array(readFileSync(p))).entries.map((x) => x.type)).toEqual(["6", "3", "1", "0"]);
});

test("a damaged or truncated tar is skipped untouched", async () => {
  const e = make({ archive: { recurse: true } });
  const src = sample();
  const cut = await e.file("cut.tar", src.subarray(0, 1400));
  const bad = Buffer.from(src);
  bad[10] ^= 1; // the first header's checksum no longer matches
  const flip = await e.file("flip.tar", bad);
  for (const p of [cut, flip]) {
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(["skipped"]).toContain(r.status);
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

test("COMMON-08 for tar: the oracle rejects changed data, dropped entries and changed headers", async () => {
  const e = make({ archive: { recurse: true } });
  const orig = await e.file("o.tar", sample());
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {} };
  const prepared = await tar.oracle.prepare!(orig, ctx);
  const variants: Record<string, Buffer> = {
    data: Buffer.concat([entry("dir/", "", { type: "5", mode: 0o755 }), entry("dir/a.txt", lorem(3000).replace("a", "b"), { mtime: 1600000000, uid: 42 }), entry("dir/pic.png", img, { mode: 0o600 }), entry("link", "", { type: "2", link: "dir/a.txt" }), end]),
    dropped: Buffer.concat([entry("dir/", "", { type: "5", mode: 0o755 }), end]),
    mode: Buffer.concat([entry("dir/", "", { type: "5", mode: 0o700 }), entry("dir/a.txt", lorem(3000), { mtime: 1600000000, uid: 42 }), entry("dir/pic.png", img, { mode: 0o600 }), entry("link", "", { type: "2", link: "dir/a.txt" }), end]),
  };
  for (const [k, v] of Object.entries(variants)) expect(await tar.oracle.same(prepared, await e.file(`${k}.tar`, v), ctx)).not.toBe(true);
  expect(await tar.oracle.same(prepared, await e.file("same.tar", sample()), ctx)).toBe(true);
});
