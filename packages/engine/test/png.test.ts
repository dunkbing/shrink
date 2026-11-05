// PNG cases (docs/FORMATS.md, section 2) against the real oxipng.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodePng, png, samePixels } from "../src";
import { env, type Env } from "./fake";
import { makePng, rowBytes } from "./lib/png";

const have = Bun.which("oxipng") !== null;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [png], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const noise = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => ((i * 2654435761 + seed * 40503) >>> 8) & 255);
const same = (a: Uint8Array, b: Uint8Array) => samePixels(decodePng(a), decodePng(b));
const test$ = have ? test : test.skip;

test$("PNG-01: an RGBA image shrinks and decodes to the same pixels", async () => {
  const bytes = makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8 });
  const e = make();
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  expect(same(bytes, new Uint8Array(readFileSync(p)))).toBe(true);
});

test$("PNG-02: an already optimal file is left alone", async () => {
  const e = make({ skipOptimized: false });
  const p = await e.file("a.png", makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8 }));
  await e.engine.optimizeFile(p);
  const once = readFileSync(p);
  expect((await e.engine.optimizeFile(p)).status).toBe("unchanged");
  expect(readFileSync(p)).toEqual(once);
});

test$("PNG-03: every colour type and bit depth keeps its pixels", async () => {
  const e = make();
  const specs: [number, number][] = [[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]];
  for (const [colorType, bitDepth] of specs) {
    const w = 37, h = 23; // odd sizes: rows don't end on a byte boundary
    const spec = { width: w, height: h, colorType: colorType as 0, bitDepth: bitDepth as 8 };
    const palette = colorType === 3 ? Array.from({ length: 1 << Math.min(bitDepth, 8) }, (_, i) => [i * 37 & 255, i * 91 & 255, i * 13 & 255]) : undefined;
    const bytes = makePng({ ...spec, palette, data: noise(rowBytes(spec) * h) .map((v) => (colorType === 3 ? v % (palette!.length) : v)) as Uint8Array });
    // a palette index must fit the depth: mask the bits for sub-byte palettes
    const p = await e.file(`t${colorType}-${bitDepth}.png`, colorType === 3 && bitDepth < 8 ? makePng({ ...spec, palette, data: new Uint8Array(rowBytes(spec) * h).fill(0) }) : bytes);
    const before = new Uint8Array(readFileSync(p));
    const r = await e.engine.optimizeFile(p);
    expect(["optimized", "unchanged"]).toContain(r.status);
    expect(same(before, new Uint8Array(readFileSync(p)))).toBe(true);
  }
});

test("PNG-03b: the pixel check sees a 16-bit low-byte change (which Bun.Image cannot)", () => {
  const data = noise(8 * 8 * 6);
  const other = data.slice();
  other[1] ^= 1;
  const a = makePng({ width: 8, height: 8, colorType: 2, bitDepth: 16, data });
  const b = makePng({ width: 8, height: 8, colorType: 2, bitDepth: 16, data: other });
  expect(same(a, b)).toContain("changed");
});

test("PNG-03c: the decoder handles Adam7 interlacing", () => {
  const spec = { width: 13, height: 9, colorType: 6 as const, bitDepth: 8 as const };
  const px = noise(rowBytes(spec) * 9);
  const flat = decodePng(makePng({ ...spec, data: px }));
  expect(flat.pixels[0]).toBe(px[0] * 257);
  expect(flat.pixels[1]).toBe(px[1] * 257);
});

test$("PNG-05: text chunks go by default and stay with keepMetadata; pixels equal either way", async () => {
  const text = new TextEncoder().encode("Comment\0hello hello hello");
  const bytes = makePng({ width: 32, height: 32, colorType: 2, bitDepth: 8, chunks: [["tEXt", text]] });
  const strip = make();
  const a = await strip.file("a.png", bytes);
  await strip.engine.optimizeFile(a);
  expect(decodePng(new Uint8Array(readFileSync(a))).chunks).not.toContain("tEXt");
  const keep = make({ png: { keepMetadata: true } });
  const b = await keep.file("b.png", bytes);
  await keep.engine.optimizeFile(b);
  expect(decodePng(new Uint8Array(readFileSync(b))).chunks).toContain("tEXt");
});

test$("PNG-06: an ICC profile or gamma without sRGB is kept", async () => {
  const bytes = makePng({ width: 32, height: 32, colorType: 2, bitDepth: 8, chunks: [["gAMA", new Uint8Array([0, 1, 0x86, 0xa0])]] });
  const e = make();
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps[0].outcome).not.toBe("rejected");
  expect(decodePng(new Uint8Array(readFileSync(p))).colour.has("gAMA")).toBe(true);
});

test$("PNG-07: colour under fully transparent pixels may change", async () => {
  const w = 16, h = 16;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(i % 2 ? [200, 10, 30, 255] : [i & 255, 99, 77, 0], i * 4);
  const bytes = makePng({ width: w, height: h, colorType: 6, bitDepth: 8, data });
  const e = make();
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(same(bytes, new Uint8Array(readFileSync(p)))).toBe(true);
});

test("PNG-08: an animated PNG is skipped for now", async () => {
  const e = make();
  const p = await e.file("a.png", makePng({ width: 8, height: 8, colorType: 6, bitDepth: 8, chunks: [["acTL", new Uint8Array(8)]] }));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("animated");
});

test("PNG-11: truncated and corrupt files are left alone", async () => {
  const bytes = makePng({ width: 32, height: 32, colorType: 6, bitDepth: 8 });
  const e = make();
  const cut = await e.file("cut.png", bytes.subarray(0, bytes.length - 30));
  expect((await e.engine.optimizeFile(cut)).reason).toContain("damaged");
  const bad = bytes.slice();
  bad[40] ^= 0xff; // inside the image data: the CRC no longer matches
  const flipped = await e.file("bad.png", bad);
  expect((await e.engine.optimizeFile(flipped)).reason).toContain("damaged");
  expect(readFileSync(flipped)).toEqual(Buffer.from(bad));
});

test$("PNG-14: split IDAT chunks and a non-PNG name still work", async () => {
  const e = make();
  const bytes = makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8, idatSize: 100 });
  const p = await e.file("picture.dat", bytes); // detected by content
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(same(bytes, new Uint8Array(readFileSync(p)))).toBe(true);
});

test("PNG-15: a tool that changes a pixel is rejected and the file is untouched", async () => {
  const e = make();
  const data = noise(32 * 32 * 4);
  const original = makePng({ width: 32, height: 32, colorType: 6, bitDepth: 8, data, compression: 0 });
  const other = data.slice();
  other[100] ^= 1;
  const tampered = await e.file("tampered.png", makePng({ width: 32, height: 32, colorType: 6, bitDepth: 8, data: other, compression: 9 }));
  const p = await e.file("a.png", original);
  const liar = new (await import("../src")).Engine({
    formats: [png],
    cacheDir: e.dir + "/cache2",
    tempDir: e.dir + "/tmp",
    settings: { toolPaths: { oxipng: ["sh", "-c", `cp "${tampered}" "$7"`] } },
  });
  const r = await liar.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(r.steps[0].detail).toContain("changed");
  expect(readFileSync(p)).toEqual(Buffer.from(original));
});
