// GZip cases (docs/FORMATS.md, section 12).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { gzip } from "../src/formats/gzip.format";
import { parseGzip } from "../src/formats/gzip-parse";
import { env, type Env } from "./fake";
import { lorem } from "./lib/zip";

const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [gzip], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const text = lorem(200000);
const header = (name: string, comment: string, mtime: number, extra?: Uint8Array) => {
  const flags = 8 | (comment ? 16 : 0) | (extra ? 4 : 0);
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 8, flags]), Buffer.from(new Uint32Array([mtime]).buffer), Buffer.from([0, 3]), ...(extra ? [Buffer.from([extra.length, 0]), extra] : []), Buffer.from(name + "\0"), Buffer.from(comment ? comment + "\0" : "")]);
};
/** A gzip member with a name, comment and mtime at a low level. */
const named = (data: string, name = "notes.txt", comment = "hello", mtime = 1700000000, extra?: Uint8Array) => {
  const g = gzipSync(data, { level: 1 });
  return Buffer.concat([header(name, comment, mtime, extra), g.subarray(10)]);
};

test("GZ-01: a text file shrinks and decompresses to the same bytes", async () => {
  const e = make();
  const p = await e.file("a.txt.gz", gzipSync(text, { level: 1 }));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(gunzipSync(readFileSync(p)).toString()).toBe(text);
});

test("GZ-02: name, mtime, comment and extra field are stripped by default and kept with keepMetadata", async () => {
  const src = named(text, "notes.txt", "hello", 1700000000, Buffer.from("AB\x02\x00xy", "latin1"));
  const a = make();
  const pa = await a.file("a.gz", src);
  await a.engine.optimizeFile(pa);
  const ga = parseGzip(new Uint8Array(readFileSync(pa)));
  expect([ga.name, ga.comment, ga.extra, ga.mtime]).toEqual([null, null, null, 0]);
  const k = make({ archive: { keepMetadata: true } });
  const pk = await k.file("a.gz", src);
  expect((await k.engine.optimizeFile(pk)).status).toBe("optimized");
  const gk = parseGzip(new Uint8Array(readFileSync(pk)));
  expect([Buffer.from(gk.name!).toString(), Buffer.from(gk.comment!).toString(), gk.mtime, gk.extra?.length]).toEqual(["notes.txt", "hello", 1700000000, 6]);
});

test("GZ-03: multi-member files (also BGZF-like) are skipped", async () => {
  const e = make();
  const p = await e.file("a.gz", Buffer.concat([gzipSync(text, { level: 1 }), gzipSync("second member " + text.slice(0, 5000), { level: 1 })]));
  const before = readFileSync(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("multi-member");
  expect(readFileSync(p).equals(before)).toBe(true);
});

test("GZ-04: trailing garbage after the member is skipped untouched", async () => {
  const e = make();
  const p = await e.file("a.gz", Buffer.concat([gzipSync(text, { level: 1 }), Buffer.from("garbage!garbage!garbage!")]));
  const before = readFileSync(p);
  expect((await e.engine.optimizeFile(p)).status).toBe("skipped");
  expect(readFileSync(p).equals(before)).toBe(true);
});

test("GZ-05: a .tgz is recompressed as gzip only; the tar inside is byte-equal", async () => {
  const tar = Buffer.alloc(512 * 6);
  tar.write("file.txt");
  tar.write(text.slice(0, 1000), 512);
  const e = make();
  const p = await e.file("a.tgz", gzipSync(tar, { level: 1 }));
  const before = readFileSync(p).length;
  const r = await e.engine.optimizeFile(p);
  expect(r.status === "optimized" ? readFileSync(p).length : before).toBeLessThanOrEqual(before);
  expect(gunzipSync(readFileSync(p)).equals(tar)).toBe(true);
});

test("GZ-06: a truncated file or a corrupt stream is untouched", async () => {
  const e = make();
  const g = gzipSync(text, { level: 1 });
  const cut = await e.file("cut.gz", g.subarray(0, g.length - 30));
  const bad = Buffer.from(g);
  bad[bad.length - 5] ^= 0xff;
  const crc = await e.file("crc.gz", bad);
  for (const p of [cut, crc]) {
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

test("COMMON-08 for gzip: the oracle rejects different data and lost header fields", async () => {
  const e = make({ archive: { keepMetadata: true } });
  const orig = await e.file("o.gz", named(text));
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {} };
  const prepared = await gzip.oracle.prepare!(orig, ctx);
  expect(await gzip.oracle.same(prepared, await e.file("d.gz", named(text.replace("a", "b"))), ctx)).toContain("differ");
  expect(await gzip.oracle.same(prepared, await e.file("n.gz", gzipSync(text)), ctx)).toContain("header");
  expect(await gzip.oracle.same(prepared, await e.file("ok.gz", named(text)), ctx)).toBe(true);
});

test("a second run changes nothing (idempotence)", async () => {
  const e = make({ skipOptimized: false });
  const p = await e.file("a.gz", gzipSync(text, { level: 1 }));
  await e.engine.optimizeFile(p);
  const once = readFileSync(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(readFileSync(p).equals(once)).toBe(true);
});
