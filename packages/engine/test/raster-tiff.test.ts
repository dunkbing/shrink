// TIFF cases (docs/FORMATS.md, section 6) against the real tiffcp and ImageMagick.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src";
import { parseTiff } from "../src/formats/tiff-parse";
import { tiff } from "../src/formats/tiff.format";
import { env, type Env } from "./fake";
import { makeTiff } from "./lib/raster";

const have = Bun.which("magick") !== null && Bun.which("tiffcp") !== null;
const t = have ? test : test.skip;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [tiff], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const work = mkdtempSync(join(tmpdir(), "shrink-tiff-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
/** Makes a TIFF with ImageMagick: `magick <args> out`. */
function im(...args: string[]): Uint8Array {
  const out = join(work, `f${n++}.tif`);
  const r = Bun.spawnSync(["magick", ...args, out], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return new Uint8Array(readFileSync(out));
}
const plasma = ["-size", "96x64", "plasma:fractal", "-seed", "7"];
const sigs = (path: string) => Bun.spawnSync(["magick", "identify", "-format", "%w|%h|%[colorspace]|%[depth]|%#\n", `tiff:${path}`]).stdout.toString();
const orig = (bytes: Uint8Array) => (Bun.write(join(work, "o" + n), bytes), join(work, "o" + n++));

t("TIFF-01: an uncompressed TIFF becomes smaller and decodes to the same pixels", async () => {
  const bytes = im("-size", "200x150", "gradient:red-blue", "-compress", "None");
  const e = make();
  const p = await e.file("a.tif", bytes);
  const before = sigs(await orig(bytes));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before / 2);
  expect(sigs(p)).toBe(before);
});

t("TIFF-02: a multi-page TIFF keeps every page", async () => {
  const bytes = im("-size", "80x60", "gradient:green-yellow", "(", "-size", "50x50", "xc:blue", ")", "(", "-size", "70x30", "pattern:checkerboard", ")", "-compress", "None");
  expect(parseTiff(bytes).ifds.length).toBe(3);
  const e = make();
  const p = await e.file("a.tif", bytes);
  const before = sigs(await orig(bytes));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(parseTiff(new Uint8Array(readFileSync(p))).ifds.length).toBe(3);
  expect(sigs(p)).toBe(before);
});

t("TIFF-03: 16-bit and floating point samples keep their values", async () => {
  const e = make();
  for (const args of [["-size", "100x80", "gradient:black-white", "-depth", "16", "-compress", "None"], ["-size", "64x64", "gradient:red-blue", "-define", "quantum:format=floating-point", "-depth", "32", "-compress", "None"]]) {
    const bytes = im(...args);
    const p = await e.file(`s${n}.tif`, bytes);
    const before = sigs(await orig(bytes));
    const r = await e.engine.optimizeFile(p);
    expect(r.status, r.reason).not.toBe("failed");
    expect(r.after).toBeLessThanOrEqual(r.before);
    expect(sigs(p)).toBe(before);
  }
});

t("TIFF-04: CMYK pictures keep their channels", async () => {
  const bytes = im("-size", "90x60", "gradient:cyan-magenta", "-colorspace", "CMYK", "-compress", "None");
  const e = make();
  const p = await e.file("a.tif", bytes);
  const before = sigs(await orig(bytes));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(sigs(p)).toBe(before);
  expect(sigs(p)).toContain("CMYK");
});

t("TIFF-05: tiled and striped layouts are both kept", async () => {
  const e = make();
  for (const args of [["-define", "tiff:tile-geometry=64x64"], ["-define", "tiff:rows-per-strip=8"]]) {
    const bytes = im("-size", "200x130", "gradient:orange-purple", ...args, "-compress", "None");
    const tags = parseTiff(bytes).ifds[0].tags;
    const p = await e.file(`l${n}.tif`, bytes);
    const before = sigs(await orig(bytes));
    expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
    const after = parseTiff(new Uint8Array(readFileSync(p))).ifds[0].tags;
    expect(after.has(322)).toBe(tags.has(322));
    expect(sigs(p)).toBe(before);
  }
});

test("TIFF-06: a GeoTIFF is skipped", async () => {
  const px = new Uint8Array(32 * 32).map((_, i) => i & 255);
  const bytes = makeTiff(32, 32, px, [[33550, 12, 3, 0]]);
  const e = make();
  const p = await e.file("a.tif", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("GeoTIFF");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

t("TIFF-07: a BigTIFF is skipped", async () => {
  const classic = im("-size", "40x40", "gradient:red-blue", "-compress", "None");
  const cp = join(work, "c.tif"), big = join(work, "big.tif");
  await Bun.write(cp, classic);
  expect(Bun.spawnSync(["tiffcp", "-8", cp, big]).exitCode).toBe(0);
  const e = make();
  const p = await e.file("a.tif", readFileSync(big));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("BigTIFF");
});

const profile = "/System/Library/ColorSync/Profiles/Display P3.icc";
(have && existsSync(profile) ? test : test.skip)("TIFF-08: an ICC profile and descriptive tags are kept (the profile always, the text with keepMetadata)", async () => {
  const bytes = im("-size", "100x80", "gradient:red-blue", "-profile", profile, "-set", "comment", "hello", "-compress", "None");
  expect(parseTiff(bytes).ifds[0].tags.has(34675)).toBe(true);
  for (const keepMetadata of [false, true]) {
    const e = make({ tiff: { keepMetadata } });
    const p = await e.file("a.tif", bytes);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("optimized");
    const tags = parseTiff(new Uint8Array(readFileSync(p))).ifds[0].tags;
    expect(tags.has(34675)).toBe(true);
    expect(Buffer.from(tags.get(34675)!.value)).toEqual(Buffer.from(parseTiff(bytes).ifds[0].tags.get(34675)!.value));
    if (keepMetadata) expect(tags.has(270)).toBe(parseTiff(bytes).ifds[0].tags.has(270));
  }
});

t("TIFF-09: a truncated TIFF is left alone", async () => {
  const bytes = im(...plasma, "-compress", "None");
  const e = make();
  const p = await e.file("cut.tif", bytes.subarray(0, bytes.length - 4000));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes.subarray(0, bytes.length - 4000)));
});

t("TIFF-10: a result with a changed pixel is rejected by the check and the file is untouched", async () => {
  const bytes = im("-size", "100x80", "gradient:red-blue", "-depth", "8", "-compress", "None");
  const tampered = im("-size", "100x80", "gradient:red-blue", "-depth", "8", "-fill", "black", "-draw", "point 50,40", "-alpha", "off", "-compress", "Zip");
  expect(tampered.length).toBeLessThan(bytes.length);
  const e = make();
  const tp = await e.file("t.tif", tampered);
  // tiffcp is called as: tiffcp -c <spec> <in> <out>
  const liar = new Engine({ formats: [tiff], cacheDir: e.dir + "/c2", tempDir: e.dir + "/tmp", settings: { toolPaths: { tiffcp: ["sh", "-c", `cp "${tp}" "$3"`] } } });
  const p = await e.file("a.tif", bytes);
  const r = await liar.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(r.steps[0].detail).toContain("differs");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

t("TIFF-11: a black and white scan is tried with CCITT G4", async () => {
  const bytes = im("-size", "300x200", "pattern:hs_horizontal", "-monochrome", "-compress", "None");
  const e = make();
  const p = await e.file("a.tif", bytes);
  const before = sigs(await orig(bytes));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.steps.find((s) => s.id === "tiff.g4")?.outcome).not.toBe("failed");
  expect(sigs(p)).toBe(before);
});

t("TIFF-12: a missing ImageMagick means the file is skipped (nothing can be verified)", async () => {
  const bytes = im("-size", "40x40", "gradient:red-blue", "-compress", "None");
  const e = make({ disabledTools: ["magick"] });
  const r = await e.engine.optimizeFile(await e.file("a.tif", bytes));
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("cannot verify");
});
