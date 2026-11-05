// BMP and ICO/CUR cases (docs/FORMATS.md, sections 5 and 7).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Engine } from "../src";
import { decodeBmp, sameBitmap } from "../src/formats/bmp-decode";
import { bmp } from "../src/formats/bmp.format";
import { ico } from "../src/formats/ico.format";
import { png } from "../src/formats/png.format";
import { env, type Env } from "./fake";
import { bands, makeBmp, makeIco, makeIconDib } from "./lib/raster";
import { makePng } from "./lib/png";

const envs: Env[] = [];
const make = (formats = [bmp, ico, png], settings = {}) => (envs.push(env({ formats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const dec = (b: Uint8Array | Buffer) => decodeBmp(new Uint8Array(b));
const magick = Bun.which("magick") !== null;
/** ImageMagick's own decode of a BMP: an independent witness for the strict reader. */
const imRgba = (path: string) => new Uint8Array(Bun.spawnSync(["magick", `bmp:${path}`, "-depth", "8", "rgba:-"]).stdout);
const colours = (w: number, h: number, n: number, bpp: 24 | 32 = 24) => makeBmp({ width: w, height: h, bpp, rgba: bands(w, h, n) });

test("BMP-01: a 24-bit picture with few colours is repacked with a palette and keeps every pixel", async () => {
  const bytes = colours(120, 60, 12);
  const e = make();
  const p = await e.file("a.bmp", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const after = readFileSync(p);
  expect(after.length).toBeLessThan(bytes.length / 3);
  expect(sameBitmap(dec(bytes), dec(after))).toBe(true);
  expect(dec(after).bpp).toBeLessThanOrEqual(8);
  if (magick) expect(Array.from(imRgba(p))).toEqual(Array.from(dec(bytes).rgba));
});

test("BMP-01b: a photo-like 24-bit picture (more than 256 colours) is left as 24-bit and never grows", async () => {
  const rgba = Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => (i % 4 === 3 ? 255 : ((i * 2654435761) >>> 8) & 255));
  const bytes = makeBmp({ width: 64, height: 64, bpp: 24, rgba });
  const e = make();
  const p = await e.file("a.bmp", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.after).toBeLessThanOrEqual(r.before);
  expect(sameBitmap(dec(bytes), dec(readFileSync(p)))).toBe(true);
});

test("BMP-02: 32-bit with real alpha is untouched; 32-bit with an unused alpha byte becomes smaller", async () => {
  const rgba = bands(40, 40, 300);
  const withAlpha = rgba.slice();
  for (let i = 0; i < 40 * 40; i++) withAlpha[i * 4 + 3] = i % 7 === 0 ? 100 : 255;
  const e = make();
  const a = await e.file("alpha.bmp", makeBmp({ width: 40, height: 40, bpp: 32, rgba: withAlpha }));
  const before = readFileSync(a);
  expect((await e.engine.optimizeFile(a)).status).toBe("unchanged");
  expect(readFileSync(a)).toEqual(before);
  // alpha byte 0 everywhere = no alpha channel
  const noAlpha = makeBmp({ width: 40, height: 40, bpp: 32, rgba });
  for (let i = 0; i < 40 * 40; i++) noAlpha[14 + 40 + i * 4 + 3] = 0;
  const b = await e.file("noalpha.bmp", noAlpha);
  const r = await e.engine.optimizeFile(b);
  expect(r.status).toBe("optimized");
  expect(sameBitmap(dec(noAlpha), dec(readFileSync(b)))).toBe(true);
  expect(dec(readFileSync(b)).bpp).toBeLessThan(32);
});

test("BMP-03: RLE8 and RLE4 pictures decode; a flat picture is repacked into RLE", async () => {
  // 8x2 RLE8: row 0 (bottom): 8 x index 1; row 1: 4 x 0 then 4 x 2
  const rle8 = makeBmp({ width: 8, height: 2, bpp: 8, palette: [[0, 0, 0], [255, 0, 0], [0, 0, 255]], compression: 1, raw: Uint8Array.from([8, 1, 0, 0, 4, 0, 4, 2, 0, 0, 0, 1]) });
  const d8 = dec(rle8);
  expect(Array.from(d8.rgba.subarray(0, 4))).toEqual([0, 0, 0, 255]);
  expect(Array.from(d8.rgba.subarray(16, 20))).toEqual([0, 0, 255, 255]);
  expect(Array.from(d8.rgba.subarray(32, 36))).toEqual([255, 0, 0, 255]);
  // RLE4, absolute mode for 3 pixels (indexes 1,2,1) then an encoded run of 5 x 2
  const rle4 = makeBmp({ width: 8, height: 1, bpp: 4, palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]], compression: 2, raw: Uint8Array.from([0, 3, 0x12, 0x10, 5, 0x22, 0, 1]) });
  const d4 = dec(rle4);
  expect(Array.from(d4.rgba.subarray(4, 8))).toEqual([0, 255, 0, 255]);
  expect(Array.from(d4.rgba.subarray(28, 32))).toEqual([0, 255, 0, 255]);
  if (magick) {
    const e = make();
    expect(Array.from(imRgba(await e.file("r8.bmp", rle8)))).toEqual(Array.from(d8.rgba));
    expect(Array.from(imRgba(await e.file("r4.bmp", rle4)))).toEqual(Array.from(d4.rgba));
  }
  // a wide flat picture: RLE8 beats raw 8-bit
  const w = 400, h = 100, rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(i % w < 200 ? [10, 20, 30, 255] : [200, 100, 50, 255], i * 4);
  const flat = makeBmp({ width: w, height: h, bpp: 24, rgba });
  const e = make();
  const p = await e.file("flat.bmp", flat);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const out = dec(readFileSync(p));
  expect(out.compression === 1 || out.compression === 2 || out.bpp === 1).toBe(true);
  expect(sameBitmap(dec(flat), out)).toBe(true);
});

test("BMP-04: top-down and bottom-up files decode to the same picture and both repack", async () => {
  const rgba = bands(50, 30, 6);
  const up = makeBmp({ width: 50, height: 30, bpp: 24, rgba });
  const down = makeBmp({ width: 50, height: 30, bpp: 24, rgba, topDown: true });
  expect(sameBitmap(dec(up), dec(down))).toBe(true);
  const e = make();
  const p = await e.file("down.bmp", down);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(sameBitmap(dec(down), dec(readFileSync(p)))).toBe(true);
});

test("BMP-05: an OS/2 (12-byte header) bitmap is read and repacked", async () => {
  const rgba = bands(30, 20, 5);
  const os2 = makeBmp({ width: 30, height: 20, bpp: 24, rgba, header: 12 });
  expect(Array.from(dec(os2).rgba)).toEqual(Array.from(rgba));
  const e = make();
  const p = await e.file("os2.bmp", os2);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(sameBitmap(dec(os2), dec(readFileSync(p)))).toBe(true);
});

test("BMP-06: a colour space with endpoints is skipped; sRGB in a V5 header is repacked", async () => {
  const rgba = bands(30, 20, 5);
  const e = make();
  const cal = await e.file("cal.bmp", makeBmp({ width: 30, height: 20, bpp: 24, rgba, header: 124, colourSpace: 0, endpoints: true }));
  const r = await e.engine.optimizeFile(cal);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("colour space");
  const v5 = makeBmp({ width: 30, height: 20, bpp: 24, rgba, header: 124 });
  const p = await e.file("v5.bmp", v5);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(sameBitmap(dec(v5), dec(readFileSync(p)))).toBe(true);
});

test("BMP-07: truncated and damaged bitmaps are left alone; so are empty, tiny and misnamed files", async () => {
  const bytes = colours(60, 40, 6);
  const e = make();
  const cut = await e.file("cut.bmp", bytes.subarray(0, bytes.length - 100));
  const r = await e.engine.optimizeFile(cut);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(readFileSync(cut)).toEqual(Buffer.from(bytes.subarray(0, bytes.length - 100)));
  const bad = bytes.slice();
  bad[14 + 16] = 9; // an unknown compression
  expect((await e.engine.optimizeFile(await e.file("bad.bmp", bad))).status).toBe("skipped");
  expect((await e.engine.optimizeFile(await e.file("tiny.bmp", bytes.subarray(0, 10)))).reason).toBe("too small");
  expect((await e.engine.optimizeFile(await e.file("pic.png", bytes))).reason).toContain("extension");
});

test("BMP-08: a result that changes one pixel is rejected by the check and the file is untouched", async () => {
  const bytes = colours(80, 40, 10);
  const liar = { ...bmp, steps: [{ id: "bmp.liar", async run(_: string, out: string) { await Bun.write(out, makeBmp({ width: 80, height: 40, bpp: 8, idx: new Uint8Array(80 * 40), palette: [[1, 2, 3]] })); } }] };
  const e = make([liar]);
  const p = await e.file("a.bmp", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

// ---- ICO / CUR

const icon = (w: number, bpp: 24 | 32 = 32) => makeIconDib(w, w, bands(w, w, 9), bpp);
const flatPng = (w: number, chunks: [string, Uint8Array][] = []) => makePng({ width: w, height: w, colorType: 6, bitDepth: 8, compression: 0, chunks });
const oxipng = Bun.which("oxipng") !== null;
const t = oxipng ? test : test.skip;

t("ICO-01: PNG-compressed sizes are recompressed and every entry keeps its pixels", async () => {
  const bytes = makeIco([{ data: flatPng(32), w: 32, h: 32 }, { data: flatPng(48), w: 48, h: 48 }]);
  const e = make();
  const p = await e.file("a.ico", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  const s = await ico.oracle.prepare!(p, {} as any);
  expect((s as any).entries.length).toBe(2);
});

test("ICO-02 and ICO-03: BMP-based 32-bit images stay valid, every resolution is kept", async () => {
  const bytes = makeIco([{ data: icon(16), w: 16, h: 16 }, { data: icon(32), w: 32, h: 32 }, { data: icon(24, 24), w: 24, h: 24, bits: 24 }]);
  const e = make();
  const p = await e.file("a.ico", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).not.toBe("failed");
  expect(readFileSync(p).length).toBeLessThanOrEqual(bytes.length);
  expect((await ico.oracle.same(await ico.oracle.prepare!(p, {} as any), p, {} as any))).toBe(true);
  expect(readFileSync(p)[4]).toBe(3);
});

t("ICO-04: a cursor keeps its hotspot", async () => {
  const bytes = makeIco([{ data: flatPng(32), w: 32, h: 32, hotspot: [5, 7] }], 2);
  const e = make();
  const p = await e.file("a.cur", bytes);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const out = readFileSync(p);
  expect(out[2]).toBe(2);
  expect(out[6 + 4] | (out[6 + 5] << 8)).toBe(5);
  expect(out[6 + 6] | (out[6 + 7] << 8)).toBe(7);
});

test("ICO-05: a PNG with a colour profile inside is skipped", async () => {
  const bytes = makeIco([{ data: flatPng(32, [["gAMA", new Uint8Array([0, 1, 0x86, 0xa0])]]), w: 32, h: 32 }]);
  const e = make();
  const r = await e.engine.optimizeFile(await e.file("a.ico", bytes));
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("colour profile");
});

test("ICO-06: a truncated icon is left alone", async () => {
  const bytes = makeIco([{ data: icon(32), w: 32, h: 32 }]);
  const e = make();
  const p = await e.file("a.ico", bytes.subarray(0, bytes.length - 40));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
});

test("ICO-07: the AND mask makes pixels transparent and the check sees it", async () => {
  const w = 16;
  const mask = Array.from({ length: w * w }, (_, i) => i % 5 === 0);
  const dib = makeIconDib(w, w, bands(w, w, 4), 24, mask);
  const info = (await ico.oracle.prepare!(await make().file("m.ico", makeIco([{ data: dib, w, h: w }])), {} as any)) as any;
  expect(info.images[0].alpha).toBe(true);
  expect(info.images[0].rgba[3]).toBe(0);
  expect(info.images[0].rgba[7]).toBe(255);
});

t("ICO-08: a result with a changed pixel inside an entry is rejected", async () => {
  const bytes = makeIco([{ data: flatPng(32), w: 32, h: 32 }]);
  const tampered = makePng({ width: 32, height: 32, colorType: 6, bitDepth: 8, compression: 9, data: Uint8Array.from({ length: 32 * 32 * 4 }, (_, i) => (i * 3) & 255) });
  const e = make([ico]);
  const tp = await e.file("t.png", tampered);
  const liar = new Engine({ formats: [ico], cacheDir: e.dir + "/c2", tempDir: e.dir + "/tmp", settings: { toolPaths: { oxipng: ["sh", "-c", `cp "${tp}" "$7"`] } } });
  const p = await e.file("a.ico", bytes);
  const r = await liar.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});
