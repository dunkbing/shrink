// COMMON cases for the raster formats of this family, on the real files in fixtures/real (see corpus.test.ts for the rest).
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src";
import { bmp } from "../src/formats/bmp.format";
import { ico } from "../src/formats/ico.format";
import { png } from "../src/formats/png.format";
import { formats as misc } from "../src/formats/raster-misc.format";
import { tiff } from "../src/formats/tiff.format";
import { env } from "./fake";
import { bands, makeBmp } from "./lib/raster";

const real = join(import.meta.dir, "../../../fixtures/real");
const manifest: { file: string; format: string }[] = await Bun.file(join(real, "../manifest.d/raster.json")).json();
const mine = new Set(["bmp", "ico", "tiff", "tga", "pcx", "sgi", "sun", "hdr", "xbm", "xpm", "pbm", "pgm", "ppm"]);
const files = manifest.filter((m) => (mine.has(m.format) || m.file.includes("apng")) && existsSync(join(real, m.file)));
const all = [bmp, ico, png, tiff, ...misc];
const e = env({ formats: all, settings: { skipOptimized: false } });
afterAll(() => e.cleanup());

test("COMMON-02/03/04: a second run never grows the file and gains under 1%", async () => {
  let optimized = 0;
  for (const m of files) {
    const p = join(e.dir, m.file);
    copyFileSync(join(real, m.file), p);
    const before = statSync(p).size;
    const first = await e.engine.optimizeFile(p);
    const mid = statSync(p).size;
    expect(mid, m.file).toBeLessThanOrEqual(before);
    const second = await e.engine.optimizeFile(p);
    const after = statSync(p).size;
    expect(after, m.file).toBeLessThanOrEqual(mid);
    expect(mid - after, `${m.file}: ${second.status}`).toBeLessThanOrEqual(Math.max(1, mid * 0.01));
    if (first.status === "optimized") optimized++;
  }
  expect(optimized).toBeGreaterThan(20);
}, 120000);

test("COMMON-14: unusual file names work", async () => {
  const bytes = makeBmp({ width: 60, height: 40, bpp: 24, rgba: bands(60, 40, 5) });
  for (const name of ["-leading dash.bmp", "ünï côdé 日本.bmp", "  spaces  and [brackets] %d.bmp", "a".repeat(120) + ".bmp"]) {
    const p = await e.file(name, bytes);
    const r = await e.engine.optimizeFile(p);
    expect(r.status, name).toBe("optimized");
  }
});

const haveTiff = Bun.which("tiffcp") !== null && Bun.which("magick") !== null;
(haveTiff ? test : test.skip)("COMMON-09/10: a tool that crashes or is missing only skips its step", async () => {
  const src = join(real, "hopper.tif");
  if (!existsSync(src)) return;
  const p = join(e.dir, "crash.tif");
  copyFileSync(src, p);
  const crash = new Engine({ formats: [tiff], cacheDir: e.dir + "/cc", tempDir: e.dir + "/tmp", settings: { toolPaths: { tiffcp: ["false"] } } });
  const r = await crash.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(r.steps.every((s) => s.outcome === "failed" || s.outcome === "skipped")).toBe(true);
  expect(readFileSync(p)).toEqual(readFileSync(src));
  const missing = new Engine({ formats: [tiff], cacheDir: e.dir + "/cd", tempDir: e.dir + "/tmp", settings: { disabledTools: ["tiffcp"] } });
  const r2 = await missing.optimizeFile(p);
  expect(r2.status).toBe("unchanged");
  expect(r2.notes.join(" ")).toContain("tiffcp not available");
});
