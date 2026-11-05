// DEB and AR cases (docs/FORMATS.md section 12).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { ar, deb } from "../src/formats/deb.format";
import { parseArMembers } from "../src/formats/deb-ar";
import { env, type Env } from "./fake";
import { lorem } from "./lib/zip";
import { testCtx } from "./lib/ctx";

const xzTool = !!Bun.which("xz");
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [deb, ar], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const field = (v: string | number, n: number) => String(v).padEnd(n, " ");
function writeAr(members: [string, Uint8Array | string][], mtime = 1700000000): Buffer {
  const parts: Buffer[] = [Buffer.from("!<arch>\n")];
  for (const [name, d] of members) {
    const data = Buffer.from(d);
    parts.push(Buffer.from(field(name + "/", 16) + field(mtime, 12) + field(0, 6) + field(0, 6) + field("100644", 8) + field(data.length, 10) + "`\n"), data);
    if (data.length & 1) parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}
const control = lorem(20000, 3), payload = lorem(400000, 5);
const xzOf = (s: string, preset = "-0") => Buffer.from(Bun.spawnSync(["xz", "-c", preset], { stdin: Buffer.from(s) }).stdout);
const makeDeb = (useXz = xzTool) =>
  writeAr([
    ["debian-binary", "2.0\n"],
    ["control.tar.gz", gzipSync(control, { level: 1 })],
    [useXz ? "data.tar.xz" : "data.tar.gz", useXz ? xzOf(payload) : gzipSync(payload, { level: 1 })],
  ]);

test("DEB-01: control and data members are recompressed, names, headers and decompressed bytes preserved", async () => {
  const e = make();
  const src = makeDeb();
  const p = await e.file("a.deb", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const after = parseArMembers(new Uint8Array(readFileSync(p)));
  const before = parseArMembers(new Uint8Array(src));
  expect(after.map((m) => m.name)).toEqual(before.map((m) => m.name));
  expect(after[0].data).toEqual(before[0].data);
  expect(gunzipSync(after[1].data).toString()).toBe(control);
  if (xzTool) expect(Buffer.from(Bun.spawnSync(["xz", "-dc"], { stdin: after[2].data }).stdout).toString()).toBe(payload);
  for (let i = 0; i < 3; i++) expect(Buffer.from(after[i].header.subarray(16, 48)).toString()).toBe(Buffer.from(before[i].header.subarray(16, 48)).toString());
});

test("AR-01: a generic ar of plain files gets its gz members recompressed; a library of objects is not claimed", async () => {
  const e = make();
  const p = await e.file("a.ar", writeAr([["notes.txt", "hello\n"], ["big.txt.gz", gzipSync(payload, { level: 1 })]]));
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(parseArMembers(new Uint8Array(readFileSync(p)))[0].data).toEqual(new Uint8Array(Buffer.from("hello\n")));
  const lib = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);
  expect(ar.detect(new Uint8Array(writeAr([["a.o", lib]])), "lib.a")).toBe(false);
  expect(deb.detect(new Uint8Array(makeDeb(false)), "a.deb")).toBe(true);
  expect(ar.detect(new Uint8Array(makeDeb(false)), "a.deb")).toBe(false);
});

test("COMMON-05 for deb: truncated archive, truncated member and corrupt gzip member are untouched", async () => {
  const e = make();
  const src = makeDeb(false);
  const bad = Buffer.from(src);
  bad[bad.length - 40] ^= 0xff; // inside the data gzip stream
  for (const [n, b] of [["cut.deb", src.subarray(0, src.length - 100)], ["hdr.deb", src.subarray(0, 100)], ["bad.deb", bad]] as const) {
    const p = await e.file(n, b);
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

test("COMMON-08 for deb: the oracle rejects changed members, names, headers and counts", async () => {
  const e = make();
  const ctx = testCtx({ settings: e.engine.settings, dir: e.dir, tools: { locate: async () => (Bun.which("xz") ? [Bun.which("xz")!] : null) } });
  const prepared = await deb.oracle.prepare!(await e.file("o.deb", makeDeb(false)), ctx);
  const gz = (s: string) => gzipSync(s, { level: 9 });
  const mk = (name: string, ctl: string, mtime = 1700000000, extra: [string, string][] = []) => e.file(`${Math.random()}.deb`, writeAr([["debian-binary", "2.0\n"], [name, gz(ctl)], ["data.tar.gz", gz(payload)], ...extra], mtime));
  expect(await deb.oracle.same(prepared, await mk("control.tar.gz", control.replace("a", "b")), ctx)).toContain("differ");
  expect(await deb.oracle.same(prepared, await mk("other.tar.gz", control), ctx)).toContain("named differently");
  expect(await deb.oracle.same(prepared, await mk("control.tar.gz", control, 5), ctx)).toContain("header");
  expect(await deb.oracle.same(prepared, await mk("control.tar.gz", control, 1700000000, [["extra", "x"]]), ctx)).toContain("count");
  expect(await deb.oracle.same(prepared, await mk("control.tar.gz", control), ctx)).toBe(true);
});

test.skipIf(!xzTool)("COMMON-08 for deb: an xz member with different decompressed bytes is rejected", async () => {
  const e = make();
  const ctx = testCtx({ settings: e.engine.settings, dir: e.dir, tools: { locate: async () => [Bun.which("xz")!] } });
  const prepared = await deb.oracle.prepare!(await e.file("o.deb", makeDeb()), ctx);
  const alt = writeAr([["debian-binary", "2.0\n"], ["control.tar.gz", gzipSync(control, { level: 1 })], ["data.tar.xz", xzOf(payload.replace("a", "b"))]]);
  expect(await deb.oracle.same(prepared, await e.file("alt.deb", alt), ctx)).toContain("differ");
});
