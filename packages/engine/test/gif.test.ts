// GIF cases (docs/FORMATS.md, section 3) against the real gifsicle.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeGif, gif, sameGif } from "../src";
import { env, type Env } from "./fake";
import { makeGif, palette, stripes } from "./lib/gif";

const have = Bun.which("gifsicle") !== null;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [gif], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const t = have ? test : test.skip;
/** Flat shapes on a plain background, with a small square at x: what an unoptimised animation frame looks like. */
const scene = (w: number, h: number, x: number) => {
  const px = new Uint8Array(w * h).fill(1);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (xx < w / 3) px[yy * w + xx] = 2;
  for (let yy = 5; yy < 15; yy++) for (let xx = x; xx < x + 10; xx++) px[yy * w + xx] = 3;
  return px;
};
const decode = (b: Uint8Array | Buffer) => decodeGif(new Uint8Array(b));

test("the test writer and the strict decoder agree, and gifsicle reads the writer's files", () => {
  const px = stripes(40, 30, 16);
  const bytes = makeGif({ width: 40, height: 30, palette: palette(16), frames: [{ pixels: px }] });
  const info = decode(bytes);
  expect(info.frames.length).toBe(1);
  const p = palette(16);
  for (let i = 0; i < 40 * 30; i++) expect(Array.from(info.frames[0].rgba.subarray(i * 4, i * 4 + 4))).toEqual([...p[px[i]], 255]);
  if (have) expect(Bun.spawnSync(["gifsicle", "--info", "-"], { stdin: bytes }).exitCode).toBe(0);
});

t("GIF-01: a static GIF shrinks and keeps its pixels", async () => {
  const bytes = makeGif({ width: 120, height: 90, palette: palette(256), frames: [{ pixels: scene(120, 90, 30) }] });
  const e = make();
  const p = await e.file("a.gif", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(sameGif(decode(bytes), decode(readFileSync(p)))).toBe(true);
});

t("GIF-02: an animation keeps its frames, delays and loop count", async () => {
  const frames = Array.from({ length: 6 }, (_, i) => ({ pixels: scene(80, 60, 5 + i * 8), delay: 5 + i }));
  const bytes = makeGif({ width: 80, height: 60, palette: palette(256), frames, loop: 3 });
  const e = make();
  const p = await e.file("a.gif", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = decode(readFileSync(p));
  expect(out.frames.map((f) => f.delay)).toEqual([5, 6, 7, 8, 9, 10]);
  expect(out.loop).toBe(3);
  expect(sameGif(decode(bytes), out)).toBe(true);
});

t("GIF-03: transparency and disposal methods are kept", async () => {
  const w = 50, h = 40;
  const base = stripes(w, h, 8);
  const overlay = new Uint8Array(w * h).fill(9); // index 9 is transparent
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) overlay[y * w + x] = 3;
  for (const disposal of [0, 1, 2, 3]) {
    const bytes = makeGif({ width: w, height: h, palette: palette(16), loop: 0, frames: [{ pixels: base, delay: 4, disposal }, { pixels: overlay, delay: 4, disposal, transparent: 9 }, { pixels: base, delay: 4 }] });
    const e = make();
    const p = await e.file(`d${disposal}.gif`, bytes);
    await e.engine.optimizeFile(p);
    expect(sameGif(decode(bytes), decode(readFileSync(p)))).toBe(true);
  }
});

t("GIF-04: comments go by default and stay with keepMetadata; the loop count stays", async () => {
  const bytes = makeGif({ width: 60, height: 40, palette: palette(16), loop: 0, comment: "made by hand ".repeat(5), frames: [{ pixels: stripes(60, 40, 16), delay: 3 }, { pixels: stripes(60, 40, 16, 2), delay: 3 }] });
  const strip = make();
  const a = await strip.file("a.gif", bytes);
  await strip.engine.optimizeFile(a);
  expect(decode(readFileSync(a)).comments).toBe(0);
  expect(decode(readFileSync(a)).loop).toBe(0);
  const keep = make({ gif: { keepMetadata: true } });
  const b = await keep.file("b.gif", bytes);
  await keep.engine.optimizeFile(b);
  expect(decode(readFileSync(b)).comments).toBe(1);
});

t("GIF-05: an interlaced GIF keeps its pixels", async () => {
  const bytes = makeGif({ width: 70, height: 50, palette: palette(32), frames: [{ pixels: stripes(70, 50, 32), interlace: true }] });
  const e = make();
  const p = await e.file("a.gif", bytes);
  await e.engine.optimizeFile(p);
  expect(sameGif(decode(bytes), decode(readFileSync(p)))).toBe(true);
});

t("GIF-06: local colour tables and a global table with unused entries", async () => {
  const bytes = makeGif({
    width: 64, height: 48, palette: palette(128), loop: 0,
    frames: [{ pixels: stripes(64, 48, 8), delay: 2, localPalette: palette(8).map((c) => c.map((v) => 255 - v)) }, { pixels: stripes(64, 48, 8, 3), delay: 2 }],
  });
  const e = make();
  const p = await e.file("a.gif", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged"]).toContain(r.status);
  expect(sameGif(decode(bytes), decode(readFileSync(p)))).toBe(true);
});

t("GIF-07: a truncated GIF is left alone", async () => {
  const bytes = makeGif({ width: 80, height: 60, palette: palette(32), frames: [{ pixels: stripes(80, 60, 32) }, { pixels: stripes(80, 60, 32, 2) }] });
  const e = make();
  const p = await e.file("cut.gif", bytes.subarray(0, bytes.length - 80));
  expect((await e.engine.optimizeFile(p)).reason).toContain("damaged");
});

t("GIF-08: sub-rectangle frames (as other tools write them) work", async () => {
  const w = 60, h = 40;
  const bytes = makeGif({ width: w, height: h, palette: palette(16), loop: 0, frames: [{ pixels: stripes(w, h, 16), delay: 5 }, { pixels: stripes(20, 10, 16, 5), left: 15, top: 12, width: 20, height: 10, delay: 5 }] });
  const e = make();
  const p = await e.file("a.gif", bytes);
  await e.engine.optimizeFile(p);
  expect(sameGif(decode(bytes), decode(readFileSync(p)))).toBe(true);
});
