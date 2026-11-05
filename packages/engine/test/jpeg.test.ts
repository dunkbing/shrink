// JPEG cases (docs/FORMATS.md, section 1) against the real jpegoptim, jpegtran and mozjpeg.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Engine, jpeg, parseJpeg } from "../src";
import { env, type Env } from "./fake";
import { addSegment, cjpeg, comment, exif, icc, makeJpeg, mpf } from "./lib/jpeg";
import { copyTool } from "./lib/platform";

const have = Bun.which("jpegtran") !== null;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [jpeg], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const t = have ? test : test.skip;
const info = (path: string) => parseJpeg(new Uint8Array(readFileSync(path)));
const pixelsOf = async (b: Uint8Array) => Bun.hash(await new Bun.Image(b).png({ compressionLevel: 1 }).bytes());

t("JPEG-01: a baseline photo becomes progressive with optimised tables and the same pixels", async () => {
  const bytes = await makeJpeg({ width: 160, height: 120 });
  const e = make();
  const p = await e.file("a.jpg", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  expect(info(p).progressive).toBe(true);
  expect(await pixelsOf(new Uint8Array(readFileSync(p)))).toBe(await pixelsOf(bytes));
});

t("JPEG-02: a file that is already optimised is left alone", async () => {
  const e = make({ skipOptimized: false });
  const p = await e.file("a.jpg", await makeJpeg({ width: 160, height: 120 }));
  await e.engine.optimizeFile(p);
  const once = readFileSync(p);
  expect((await e.engine.optimizeFile(p)).status).toBe("unchanged");
  expect(readFileSync(p)).toEqual(once);
});

t("JPEG-03: comments and EXIF go by default and stay with keepMetadata; the ICC profile always stays", async () => {
  const base = await makeJpeg({ width: 128, height: 96 });
  const bytes = icc(comment(exif(base, 1), "taken on a rainy day"));
  const strip = make();
  const a = await strip.file("a.jpg", bytes);
  await strip.engine.optimizeFile(a);
  const sa = info(a);
  expect(sa.comments).toBe(0);
  expect(sa.exif).toBeNull();
  expect(sa.icc).not.toBeNull();
  const keep = make({ jpeg: { keepMetadata: true } });
  const b = await keep.file("b.jpg", bytes);
  await keep.engine.optimizeFile(b);
  const sb = info(b);
  expect(sb.comments).toBe(1);
  expect(sb.exif).not.toBeNull();
  expect(sb.icc).not.toBeNull();
});

t("JPEG-04: EXIF orientation other than 1 is kept, so the picture still shows the same way", async () => {
  const bytes = exif(await makeJpeg({ width: 128, height: 96 }), 6);
  const e = make();
  const p = await e.file("a.jpg", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(info(p).orientation).toBe(6);
  expect(info(p).exif).not.toBeNull();
});

t("JPEG-05: an ICC profile is kept byte for byte", async () => {
  const profile = new TextEncoder().encode("profile-data-".repeat(500)); // longer than one segment would not be, but fine
  const bytes = icc(await makeJpeg({ width: 128, height: 96 }), profile);
  const e = make();
  const p = await e.file("a.jpg", bytes);
  await e.engine.optimizeFile(p);
  expect(Buffer.compare(info(p).icc!, profile)).toBe(0);
});

t("JPEG-07: a grayscale JPEG works", async () => {
  const bytes = await cjpeg({ gray: true });
  if (!bytes) return;
  const e = make();
  const p = await e.file("g.jpg", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged"]).toContain(r.status);
  expect(info(p).components).toBe(1);
  expect(await pixelsOf(new Uint8Array(readFileSync(p)))).toBe(await pixelsOf(bytes));
});

t("JPEG-08: subsampling, restart markers and optimised/unoptimised input keep their pixels", async () => {
  const e = make();
  for (const args of [["-sample", "1x1"], ["-sample", "2x1"], ["-sample", "2x2"], ["-restart", "5"], ["-baseline", "-notrellis"], ["-quality", "30"]]) {
    const bytes = await cjpeg({ args });
    if (!bytes) continue;
    const p = await e.file(`s-${args.join("")}.jpg`, bytes);
    const r = await e.engine.optimizeFile(p);
    expect(["optimized", "unchanged"]).toContain(r.status);
    expect(await pixelsOf(new Uint8Array(readFileSync(p)))).toBe(await pixelsOf(bytes));
  }
});

t("JPEG-09: a truncated JPEG is left alone", async () => {
  const bytes = await makeJpeg({ width: 128, height: 96 });
  const e = make();
  const p = await e.file("cut.jpg", bytes.subarray(0, bytes.length - 200));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
});

t("JPEG-10: data after the end of the image means the file is skipped", async () => {
  const bytes = await makeJpeg({ width: 128, height: 96 });
  const e = make();
  const p = await e.file("tail.jpg", Uint8Array.from([...bytes, ...new TextEncoder().encode("TRAILER-DATA")]));
  expect((await e.engine.optimizeFile(p)).reason).toBe("data after the end of the image");
});

t("JPEG-11: a gain-map (multi-picture) file is skipped with a reason", async () => {
  const e = make();
  const p = await e.file("hdr.jpg", mpf(await makeJpeg({ width: 128, height: 96 })));
  expect((await e.engine.optimizeFile(p)).reason).toContain("multi-picture");
});

t("JPEG-12: an MPO (two JPEGs concatenated) is skipped and both frames stay byte for byte, also with lossy on", async () => {
  const first = mpf(await makeJpeg({ width: 128, height: 96 }));
  const second = await makeJpeg({ width: 128, height: 96, seed: 9 });
  const mpo = Uint8Array.from([...first, ...second]);
  // the same two frames without the MPF index are still not touched: data after the first image
  const bare = Uint8Array.from([...(await makeJpeg({ width: 128, height: 96 })), ...second]);
  for (const [name, bytes, why] of [["a.mpo", mpo, "multi-picture"], ["b.jpg", mpo, "multi-picture"], ["c.jpg", bare, "data after"]] as const) {
    for (const lossy of [false, true]) {
      const e = make({ jpeg: { lossy } });
      const p = await e.file(name, bytes);
      const r = await e.engine.optimizeFile(p);
      expect(r.status).toBe("skipped");
      expect(r.reason ?? "").toContain(why);
      expect(readFileSync(p)).toEqual(Buffer.from(bytes));
    }
  }
});

/** Rewrites the frame header to say 4 components (what a CMYK JPEG has); the checks that skip it read headers only. */
function asFourComponents(jpeg: Uint8Array, adobeTransform?: number): Uint8Array {
  const at = jpeg.findIndex((v, i) => v === 0xff && jpeg[i + 1] === 0xc0);
  const len = (jpeg[at + 2] << 8) | jpeg[at + 3];
  // FF C0, length, precision, height, width, count (offset 9), then 3 bytes per component: add a fourth
  const fixed = Uint8Array.from([...jpeg.subarray(at, at + 2 + len), 4, 0x11, 0]);
  fixed[2] = (len + 3) >> 8;
  fixed[3] = (len + 3) & 255;
  fixed[9] = 4;
  const adobe = adobeTransform === undefined ? [] : [0xff, 0xee, 0, 14, 0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, adobeTransform];
  return Uint8Array.from([...jpeg.subarray(0, 2), ...adobe, ...jpeg.subarray(2, at), ...fixed, ...jpeg.subarray(at + 2 + len)]);
}

t("JPEG-06: CMYK and Adobe YCCK JPEGs are skipped (never through the tools), also with lossy on, and stay untouched", async () => {
  const base = await makeJpeg({ width: 64, height: 48 });
  const cases: [string, Uint8Array][] = [["cmyk.jpg", asFourComponents(base, 0)], ["ycck.jpg", asFourComponents(base, 2)]];
  expect(parseJpeg(cases[0][1]).components).toBe(4);
  expect(parseJpeg(cases[1][1]).adobe).toBe(2);
  for (const lossy of [false, true]) {
    for (const [name, bytes] of cases) {
      const e = make({ jpeg: { lossy } });
      const p = await e.file(name, bytes);
      const r = await e.engine.optimizeFile(p);
      expect(r.status).toBe("skipped");
      expect(r.reason).toContain("CMYK");
      expect(r.steps).toEqual([]);
      expect(readFileSync(p)).toEqual(Buffer.from(bytes));
    }
  }
});

const magick = Bun.which("magick") ?? Bun.which("convert");
(magick ? t : test.skip)("JPEG-06: a real CMYK JPEG made by ImageMagick is left alone", async () => {
  const e = make({ jpeg: { lossy: true } });
  const out = `${e.dir}/cmyk.jpg`;
  const r0 = Bun.spawnSync([magick!, "-size", "64x48", "gradient:red-blue", "-colorspace", "CMYK", out]);
  expect(r0.exitCode).toBe(0);
  const bytes = readFileSync(out);
  expect(parseJpeg(new Uint8Array(bytes)).components).toBe(4);
  const r = await e.engine.optimizeFile(out);
  expect(r.status).toBe("skipped");
  expect(readFileSync(out)).toEqual(bytes);
});

t("JPEG-14: arithmetic coding only with the setting", async () => {
  const bytes = await makeJpeg({ width: 160, height: 120 });
  const off = make();
  const a = await off.file("a.jpg", bytes);
  await off.engine.optimizeFile(a);
  expect([0xc0, 0xc1, 0xc2]).toContain(info(a).sof);
  const on = make({ jpeg: { arithmetic: true } });
  const b = await on.file("b.jpg", bytes);
  const r = await on.engine.optimizeFile(b);
  // arithmetic JPEGs are smaller; if the decoder cannot read them the oracle rejects the result instead
  expect(r.steps.some((s) => s.outcome === "kept" || s.outcome === "rejected" || s.outcome === "not smaller")).toBe(true);
  expect([0xc0, 0xc1, 0xc2, 0xc9, 0xca]).toContain(info(b).sof);
});

t("JPEG-15: level never makes it worse", async () => {
  const bytes = await makeJpeg({ width: 160, height: 120 });
  const sizes: number[] = [];
  for (const level of [1, 9]) {
    const e = make({ level });
    const p = await e.file("a.jpg", bytes);
    await e.engine.optimizeFile(p);
    sizes.push(readFileSync(p).length);
  }
  expect(sizes[1]).toBeLessThanOrEqual(sizes[0]);
});

t("JPEG-16: a result with different pixels is rejected", async () => {
  const bytes = await makeJpeg({ width: 128, height: 96, quality: 95 });
  const worse = await makeJpeg({ width: 128, height: 96, quality: 30 });
  const e = make({ disabledTools: ["jpegoptim", "mozjpegtran"] });
  const p = await e.file("a.jpg", bytes);
  const liar = new Engine({ formats: [jpeg], cacheDir: e.dir + "/c2", tempDir: e.dir + "/tmp", settings: { disabledTools: ["jpegoptim", "mozjpegtran"], toolPaths: { jpegtran: copyTool(`${e.dir}/worse.jpg`, 5) } } });
  await Bun.write(`${e.dir}/worse.jpg`, worse);
  const r = await liar.optimizeFile(p);
  expect(r.steps.find((s) => s.id === "jpeg.jpegtran")).toMatchObject({ outcome: "rejected", detail: "pixels differ" });
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

t("JPEG-17: a segment with a bad length is damaged, not a crash", async () => {
  const bytes = await makeJpeg({ width: 64, height: 48 });
  const bad = addSegment(bytes, 0xe0, new Uint8Array(4));
  bad[5] = 0xff; // the length field now claims far more than the file holds
  const e = make();
  const p = await e.file("bad.jpg", bad);
  expect((await e.engine.optimizeFile(p)).reason).toContain("damaged");
});
