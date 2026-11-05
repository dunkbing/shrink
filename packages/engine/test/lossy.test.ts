// The lossy steps (docs/FORMATS.md: JPEG-13, PNG-10, WEBP-02): off by default, smaller and similar when on, a too-lossy result is rejected.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodePng, jpeg, png, webp, type Format, type Step } from "../src";
import { compare, rasterOf, rasterOfPng, ssimPlane, type Raster } from "../src/formats/lossy";
import { env, type Env } from "./fake";
import { exif, icc as jpegIcc, makeJpeg } from "./lib/jpeg";
import { testCtx } from "./lib/ctx";
import { makePng } from "./lib/png";
import { parseJpeg } from "../src";

const envs: Env[] = [];
const make = (formats: Format[], settings = {}) => (envs.push(env({ formats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

/** A smooth, photo-like picture (gradients, a soft disc, faint noise) as 8-bit RGBA. */
function picture(w: number, h: number, alpha = false): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  let r = 7;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      r = (r * 1103515245 + 12345) >>> 0;
      const n = ((r >>> 16) & 3) - 1;
      const disc = Math.hypot(x - w / 2, y - h / 2) < h / 3 ? 60 : 0;
      const o = (y * w + x) * 4;
      d[o] = Math.min(255, 110 + 90 * Math.sin(x / 23) + disc + n);
      d[o + 1] = Math.min(255, 120 + 90 * Math.cos(y / 19) + n);
      d[o + 2] = Math.min(255, 40 + (x + y) / 3 + disc / 2 + n);
      d[o + 3] = alpha ? (x < w / 8 ? 0 : y > h - h / 8 ? 140 : 255) : 255;
    }
  return d;
}
/** A screenshot-like picture (flat panels, anti-aliased discs, text-like lines, one gradient): what palette quantisation is for. */
function screenshot(w: number, h: number, alpha = false): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = [30, 40, 60];
      if (y < 24) c = [60, 90, 200];
      else if (x > 20 && x < w - 20 && y > 40 && y < h - 20) c = y % 12 < 3 && x > 40 ? [120, 120, 130] : [240, 240, 245];
      if (x > w - 70 && x < w - 20 && y > 40 && y < 70) c = [x * 3 % 256, 100, 200 - ((x * 3) % 128)];
      const disc = Math.hypot(x - 60, y - h / 2) - 22;
      if (disc < 1) c = mix(c, [220, 80, 60], Math.min(1, Math.max(0, 1 - disc)));
      const o = (y * w + x) * 4;
      d.set([...c, alpha ? (x < w / 8 ? 0 : y > h - h / 8 ? 140 : 255) : 255], o);
    }
  return d;
}
const pngOf = (w: number, h: number, alpha = false) => makePng({ width: w, height: h, colorType: 6, bitDepth: 8, data: screenshot(w, h, alpha), compression: 6 });
const floor = 0.98;
const ssimOf = async (a: Uint8Array, b: Uint8Array) => {
  const x = await rasterOf(a), y = await rasterOf(b);
  expect(compare(x, y, floor).problem).toBeNull();
  return compare(x, y, floor).ssim;
};

test("the similarity measure: identical is 1, noise and shifts are lower, size differences are reported", () => {
  const w = 40, h = 30;
  const a: Raster = { width: w, height: h, rgba: picture(w, h) };
  expect(compare(a, a, floor).ssim).toBeCloseTo(1, 6);
  const noisy: Raster = { width: w, height: h, rgba: picture(w, h).map((v, i) => (i % 4 === 3 ? v : (v + ((i * 7919) % 90)) & 255)) };
  expect(compare(a, noisy, floor).ssim).toBeLessThan(0.9);
  expect(compare(a, { width: w + 1, height: h, rgba: new Uint8Array((w + 1) * h * 4) }, floor).problem).toContain("size");
  const flat = new Float32Array(16 * 16).fill(100);
  expect(ssimPlane(flat, flat, 16, 16)).toBeCloseTo(1, 6);
  expect(ssimPlane(new Float32Array(3 * 3).fill(10), new Float32Array(3 * 3).fill(10), 3, 3)).toBeCloseTo(1, 6);
});

test("the similarity measure treats alpha as part of the picture", () => {
  const w = 32, h = 32;
  const a: Raster = { width: w, height: h, rgba: picture(w, h, true) };
  const opaque: Raster = { width: w, height: h, rgba: picture(w, h) };
  expect(compare(a, opaque, floor).problem).toContain("transparency");
  const moved = new Uint8Array(a.rgba);
  for (let i = 0; i < w * h; i++) moved[i * 4 + 3] = moved[i * 4 + 3] === 0 ? 255 : moved[i * 4 + 3];
  expect(compare(a, { ...a, rgba: moved }, floor).problem).toContain("transparent");
});

// ---------------------------------------------------------------- JPEG-13

const cjpeg = Bun.which("cjpeg") !== null;
const tj = cjpeg ? test : test.skip;
const jpegSource = async () => icc3(await makeJpegFrom(256, 192));
async function makeJpegFrom(w: number, h: number): Promise<Uint8Array> {
  return new Uint8Array(await new Bun.Image(pngOf(w, h)).jpeg({ quality: 97 }).bytes());
}
const icc3 = (b: Uint8Array) => jpegIcc(exif(b, 6));

tj("JPEG-13: lossy off never recompresses; the pixels stay equal", async () => {
  const bytes = await jpegSource();
  const e = make([jpeg]);
  const p = await e.file("a.jpg", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps.find((s) => s.id === "jpeg.recompress")).toMatchObject({ outcome: "skipped", detail: "lossy steps are off" });
  expect(r.lossy).toBeUndefined();
  expect(Bun.hash(await new Bun.Image(new Uint8Array(readFileSync(p))).png({ compressionLevel: 1 }).bytes())).toBe(Bun.hash(await new Bun.Image(bytes).png({ compressionLevel: 1 }).bytes()));
});

tj("JPEG-13: lossy on gives a clearly smaller file above the SSIM floor, flagged lossy, with orientation and profile kept", async () => {
  const bytes = await jpegSource();
  const e = make([jpeg], { lossy: { ssim: floor }, jpeg: { lossy: true } });
  const p = await e.file("a.jpg", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.lossy).toBe(true);
  expect(r.steps.find((s) => s.id === "jpeg.recompress")).toMatchObject({ outcome: "kept", lossy: true });
  const after = new Uint8Array(readFileSync(p));
  expect(after.length).toBeLessThan(bytes.length * 0.95);
  expect(await ssimOf(bytes, after)).toBeGreaterThanOrEqual(floor);
  const a = parseJpeg(bytes), b = parseJpeg(after);
  expect([b.width, b.height, b.orientation]).toEqual([a.width, a.height, a.orientation]);
  expect(Buffer.compare(a.icc!, b.icc!)).toBe(0);
});

tj("JPEG-13: a higher floor gives a larger (or no) result than a lower one", async () => {
  const bytes = await jpegSource();
  const sizes: number[] = [];
  for (const ssim of [0.95, 0.995]) {
    const e = make([jpeg], { lossy: { ssim }, jpeg: { lossy: true } });
    const p = await e.file("a.jpg", bytes);
    await e.engine.optimizeFile(p);
    sizes.push(readFileSync(p).length);
  }
  expect(sizes[0]).toBeLessThanOrEqual(sizes[1]);
});

tj("JPEG-13: a too-lossy or tampered result is rejected and the file is untouched", async () => {
  const bytes = await jpegSource();
  const bad = icc3(new Uint8Array(await new Bun.Image(pngOf(256, 192)).jpeg({ quality: 4 }).bytes()));
  const liar: Step = { id: "jpeg.liar", lossy: true, run: async (_i, o) => void (await Bun.write(o, bad)) };
  const e = make([{ ...jpeg, steps: [liar] }], { jpeg: { lossy: true } });
  const p = await e.file("a.jpg", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps[0].outcome).toBe("rejected");
  expect(r.steps[0].detail).toContain("below the floor");
  expect(r.status).toBe("unchanged");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
  // other kinds of damage: a different size, a lost profile
  const prepared = await jpeg.oracle.prepare!(p, testCtx({ settings: { jpeg: { lossy: true } } }));
  const small = await new Bun.Image(pngOf(128, 96)).jpeg({ quality: 90 }).bytes();
  const f1 = await e.file("small.jpg", small);
  expect(await jpeg.oracle.similar!(prepared, f1, testCtx())).toContain("size");
  const f2 = await e.file("noicc.jpg", exif(await makeJpegFrom(256, 192), 6));
  expect(await jpeg.oracle.similar!(prepared, f2, testCtx())).toBe("ICC profile changed");
});

// ---------------------------------------------------------------- PNG-10

const pngquant = Bun.which("pngquant") !== null;
const tp = pngquant ? test : test.skip;

tp("PNG-10: lossy off never quantises", async () => {
  const bytes = pngOf(256, 192);
  const e = make([png]);
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps.find((s) => s.id === "png.pngquant")).toMatchObject({ outcome: "skipped", detail: "lossy steps are off" });
  expect(r.lossy).toBeUndefined();
  expect(decodePng(new Uint8Array(readFileSync(p))).pixels).toEqual(decodePng(bytes).pixels);
});

tp("PNG-10: lossy on gives an indexed, much smaller file above the floor, flagged lossy, alpha kept", async () => {
  const bytes = pngOf(256, 192, true);
  const e = make([png], { png: { lossy: true } });
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.lossy).toBe(true);
  expect(r.steps.find((s) => s.id === "png.pngquant")).toMatchObject({ outcome: "kept", lossy: true });
  const after = new Uint8Array(readFileSync(p));
  expect(after.length).toBeLessThan(bytes.length * 0.6);
  const b = decodePng(after);
  expect(b.colorType).toBe(3);
  const x = rasterOfPng(decodePng(bytes)), y = rasterOfPng(b);
  expect(compare(x, y, floor).problem).toBeNull();
  expect(compare(x, y, floor).ssim).toBeGreaterThanOrEqual(floor);
  expect(y.rgba[3]).toBe(0); // the transparent corner is still transparent
});

tp("PNG-10: a PNG with a colour profile is not quantised", async () => {
  const bytes = makePng({ width: 128, height: 96, colorType: 6, bitDepth: 8, data: screenshot(128, 96), chunks: [["gAMA", new Uint8Array([0, 1, 0x86, 0xa0])]] });
  const e = make([png], { png: { lossy: true } });
  const r = await e.engine.optimizeFile(await e.file("a.png", bytes));
  expect(r.steps.find((s) => s.id === "png.pngquant")?.detail).toContain("colour profile");
});

tp("PNG-10: a too-lossy or tampered result is rejected and the file is untouched", async () => {
  const bytes = pngOf(256, 192);
  // 4 colours: far below the floor
  const bad = new Uint8Array(await new Bun.Image(bytes).png({ palette: true, colors: 4, dither: false }).bytes());
  const liar: Step = { id: "png.liar", lossy: true, run: async (_i, o) => void (await Bun.write(o, bad)) };
  const e = make([{ ...png, steps: [liar] }], { png: { lossy: true } });
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(r.steps[0].detail).toContain("below the floor");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
  // a lost alpha channel
  const prepared = await png.oracle.prepare!(p, testCtx());
  const f = await e.file("opaque.png", pngOf(256, 192, false));
  const withAlpha = await e.file("alpha.png", pngOf(256, 192, true));
  const pa = await png.oracle.prepare!(withAlpha, testCtx());
  expect(await png.oracle.similar!(pa, f, testCtx())).toContain("transparency");
  expect(prepared).toBeDefined();
});

// ---------------------------------------------------------------- WEBP-02

const cwebp = Bun.which("cwebp") !== null;
const tw = cwebp ? test : test.skip;
const webpSource = async (alpha = false) => {
  const dir = e0();
  await Bun.write(`${dir}/in.png`, pngOf(256, 192, alpha));
  const r = Bun.spawnSync(["cwebp", "-quiet", "-q", "98", "-metadata", "none", `${dir}/in.png`, "-o", `${dir}/out.webp`]);
  expect(r.exitCode).toBe(0);
  return new Uint8Array(readFileSync(`${dir}/out.webp`));
};
const e0 = () => make([webp]).dir;

tw("WEBP-02: a lossy WebP is recompressed only with webp.lossy, smaller, above the floor, alpha kept", async () => {
  const bytes = await webpSource(true);
  const off = make([webp]);
  const p0 = await off.file("a.webp", bytes);
  const r0 = await off.engine.optimizeFile(p0);
  expect(r0.steps.find((s) => s.id === "webp.recompress")).toMatchObject({ outcome: "skipped", detail: "lossy steps are off" });
  expect(readFileSync(p0)).toEqual(Buffer.from(bytes));
  const on = make([webp], { webp: { lossy: true } });
  const p = await on.file("a.webp", bytes);
  const r = await on.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.lossy).toBe(true);
  const after = new Uint8Array(readFileSync(p));
  expect(after.length).toBeLessThan(bytes.length * 0.95);
  const x = await rasterOf(bytes), y = await rasterOf(after);
  expect(compare(x, y, floor).problem).toBeNull();
  expect(compare(x, y, floor).ssim).toBeGreaterThanOrEqual(floor);
  expect(y.rgba[3]).toBe(0);
});

tw("WEBP-02: a too-lossy or tampered result is rejected and the file is untouched", async () => {
  const bytes = await webpSource();
  // the same size, but a different picture
  const bad = new Uint8Array(await new Bun.Image(makePng({ width: 256, height: 192, colorType: 2, bitDepth: 8, data: new Uint8Array(256 * 192 * 3).fill(128) })).webp({ quality: 80 }).bytes());
  const liar: Step = { id: "webp.liar", lossy: true, run: async (_i, o) => void (await Bun.write(o, bad)) };
  const e = make([{ ...webp, steps: [liar] }], { webp: { lossy: true } });
  const p = await e.file("a.webp", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(r.steps[0].detail).toContain("below the floor");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});
