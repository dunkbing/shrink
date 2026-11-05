// APNG cases (docs/FORMATS.md, PNG-08) against the real oxipng.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Engine } from "../src";
import { decodeApng, sameApng } from "../src/formats/apng-decode";
import { png } from "../src/formats/png.format";
import { env, type Env } from "./fake";
import { makeApng, type ApngFrame } from "./lib/raster";
import { copyTool } from "./lib/platform";

const have = Bun.which("oxipng") !== null;
const t = have ? test : test.skip;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [png], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const dec = (b: Uint8Array | Buffer) => decodeApng(new Uint8Array(b));

const solid = (w: number, h: number, c: number[]) => Uint8Array.from({ length: w * h * 4 }, (_, i) => c[i % 4]!);
/** A moving square on a gradient background. */
const scene = (w: number, h: number, x: number) => {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) px.set(xx >= x && xx < x + 8 && y > 4 && y < 12 ? [250, 20, 20, 255] : [xx * 3, y * 4, 128, 255], (y * w + xx) * 4);
  return px;
};
const anim = (n = 5, extra: Partial<ApngFrame> = {}): ApngFrame[] => Array.from({ length: n }, (_, i) => ({ w: 48, h: 32, rgba: scene(48, 32, i * 6), delayNum: 3 + i, delayDen: 50, ...extra }));

t("PNG-08a: frames, delays and loop count survive recompression", async () => {
  const bytes = makeApng({ w: 48, h: 32, frames: anim(6), plays: 3 });
  const e = make();
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const a = dec(bytes), b = dec(readFileSync(p));
  expect(sameApng(a, b)).toBe(true);
  expect(b.numPlays).toBe(3);
  expect(b.frames.map((f) => f.delayNum)).toEqual([3, 4, 5, 6, 7, 8]);
  expect(b.hidden).toBe(false);
});

t("PNG-08b: blend and dispose operations and sub-rectangles are kept", async () => {
  const w = 40, h = 30;
  const half = solid(10, 10, [255, 0, 0, 128]);
  const frames: ApngFrame[] = [
    { w, h, rgba: scene(w, h, 0), dispose: 0, blend: 0 },
    { w: 10, h: 10, x: 5, y: 5, rgba: half, dispose: 2, blend: 1 },
    { w: 10, h: 10, x: 20, y: 10, rgba: half, dispose: 1, blend: 1 },
    { w: 10, h: 10, x: 20, y: 10, rgba: solid(10, 10, [0, 255, 0, 255]), dispose: 0, blend: 0 },
  ];
  const bytes = makeApng({ w, h, frames });
  const a = dec(bytes);
  expect(new Set(a.shown).size).toBe(4); // each step shows something different
  const e = make();
  const p = await e.file("a.png", bytes);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const b = dec(readFileSync(p));
  expect(sameApng(a, b)).toBe(true);
  expect(b.frames.map((f) => [f.dispose, f.blend, f.x, f.y, f.width])).toEqual(frames.map((f) => [f.dispose ?? 0, f.blend ?? 0, f.x ?? 0, f.y ?? 0, f.w]));
});

test("PNG-08c: composing follows the spec: OVER blends, PREVIOUS restores, BACKGROUND clears", () => {
  const w = 4, h = 1;
  const bytes = makeApng({
    w, h,
    frames: [
      { w, h, rgba: solid(w, h, [0, 0, 255, 255]) },
      { w: 1, h: 1, x: 0, rgba: Uint8Array.from([255, 0, 0, 255]), dispose: 2 },
      { w: 1, h: 1, x: 1, rgba: Uint8Array.from([255, 0, 0, 255]), dispose: 1 },
      { w: 1, h: 1, x: 3, rgba: Uint8Array.from([255, 0, 0, 0]), blend: 1 },
    ],
  });
  const a = dec(bytes);
  const full = (px: number[][]) => new Bun.CryptoHasher("sha256").update(Uint16Array.from(px.flatMap((p) => p.map((v) => v * 257)))).digest("hex");
  const B = [0, 0, 255, 255], R = [255, 0, 0, 255];
  expect(a.shown[0]).toBe(full([B, B, B, B]));
  expect(a.shown[1]).toBe(full([R, B, B, B]));
  expect(a.shown[2]).toBe(full([B, R, B, B])); // frame 1 disposed to previous
  expect(a.shown[3]).toBe(full([B, [0, 0, 0, 0], B, B])); // frame 2 disposed to transparent; frame 3 adds nothing
});

t("PNG-08d: a hidden default image stays hidden and unchanged", async () => {
  const w = 48, h = 32;
  const fallback = solid(w, h, [10, 200, 10, 255]);
  const bytes = makeApng({ w, h, frames: anim(3), hidden: true, defaultImage: fallback });
  const a = dec(bytes);
  expect(a.hidden).toBe(true);
  const e = make();
  const p = await e.file("a.png", bytes);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const b = dec(readFileSync(p));
  expect(b.hidden).toBe(true);
  expect(sameApng(a, b)).toBe(true);
  expect(b.defaultHash).toBe(a.defaultHash);
});

test("PNG-08e: the check notices a changed delay, loop count, frame count or default image", () => {
  const base = makeApng({ w: 48, h: 32, frames: anim(3), plays: 2 });
  const a = dec(base);
  expect(sameApng(a, dec(makeApng({ w: 48, h: 32, frames: anim(3), plays: 2 })))).toBe(true);
  expect(sameApng(a, dec(makeApng({ w: 48, h: 32, frames: anim(3), plays: 1 })))).toBe("loop count changed");
  expect(sameApng(a, dec(makeApng({ w: 48, h: 32, frames: anim(3, { delayNum: 9 }), plays: 2 })))).toContain("delay");
  expect(sameApng(a, dec(makeApng({ w: 48, h: 32, frames: anim(2), plays: 2 })))).toContain("frame count");
  expect(sameApng(a, dec(makeApng({ w: 48, h: 32, frames: anim(3), plays: 2, hidden: true, defaultImage: scene(48, 32, 0) })))).toContain("default image");
  // 3/50 and 6/100 are the same delay
  const x = anim(3).map((f) => ({ ...f, delayNum: 2, delayDen: 100 }));
  const y = anim(3).map((f) => ({ ...f, delayNum: 1, delayDen: 50 }));
  expect(sameApng(dec(makeApng({ w: 48, h: 32, frames: x })), dec(makeApng({ w: 48, h: 32, frames: y })))).toBe(true);
});

t("PNG-08f: a tool that changes the picture of a frame is rejected, the file is untouched", async () => {
  const w = 16, h = 16;
  const bytes = makeApng({ w, h, frames: [{ w, h, rgba: scene(w, h, 0) }] });
  const e = make();
  // a different but smaller single PNG instead of the recompressed frame
  const other = makeApng({ w, h, frames: [{ w, h, rgba: scene(w, h, 3) }], level: 9 });
  const tp = await e.file("t.png", other);
  const liar = new Engine({ formats: [png], cacheDir: e.dir + "/c2", tempDir: e.dir + "/tmp", settings: { toolPaths: { oxipng: copyTool(tp, 6) } } });
  const p = await e.file("a.png", bytes);
  const r = await liar.optimizeFile(p);
  const step = r.steps.find((s) => s.id === "png.apng-frames")!;
  expect(step.outcome).toBe("rejected");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

test("PNG-08g: a truncated or broken animation is left alone", async () => {
  const bytes = makeApng({ w: 48, h: 32, frames: anim(4) });
  const e = make();
  const cut = await e.file("cut.png", bytes.subarray(0, bytes.length - 2000));
  expect((await e.engine.optimizeFile(cut)).reason).toContain("damaged");
  // acTL promises 4 frames but only 3 follow
  const three = makeApng({ w: 48, h: 32, frames: anim(3) });
  three[8 + 25 + 8 + 3] = 4;
  const crcFixed = three; // the CRC no longer matches either: damaged
  expect((await e.engine.optimizeFile(await e.file("short.png", crcFixed))).reason).toContain("damaged");
});

t("PNG-08h: text is dropped from an animation by default and kept with keepMetadata", async () => {
  const bytes = makeApng({ w: 48, h: 32, frames: anim(3) });
  // insert a tEXt chunk after acTL
  const at = 8 + 25 + 20;
  const body = new TextEncoder().encode("tEXt" + "Comment\0hello hello hello");
  const crc = Bun.hash.crc32(body);
  const chunk = new Uint8Array(12 + body.length - 4);
  new DataView(chunk.buffer).setUint32(0, body.length - 4);
  chunk.set(body, 4);
  new DataView(chunk.buffer).setUint32(8 + body.length - 4, crc);
  const withText = new Uint8Array([...bytes.subarray(0, at), ...chunk, ...bytes.subarray(at)]);
  const strip = make();
  const a = await strip.file("a.png", withText);
  await strip.engine.optimizeFile(a);
  expect(dec(readFileSync(a)).chunks.map((c) => c.type)).not.toContain("tEXt");
  const keep = make({ png: { keepMetadata: true } });
  const b = await keep.file("b.png", withText);
  await keep.engine.optimizeFile(b);
  expect(dec(readFileSync(b)).chunks.map((c) => c.type)).toContain("tEXt");
});
