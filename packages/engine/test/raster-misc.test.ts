// Long-tail raster formats (docs/FORMATS.md, section 19): LONG-01 rewrites that keep every pixel, LONG-02 variants that cannot
// gain are left alone, LONG-03 damaged files are untouched, LONG-04 a tool that changes pixels is rejected.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src";
import { pbm, pcx, pgm, ppm, sgi, sun, tga, xbm, xpm, hdr } from "../src/formats/raster-misc.format";
import { env, type Env } from "./fake";
import { scriptTool } from "./lib/platform";

const have = Bun.which("magick") !== null;
const t = have ? test : test.skip;
const formats = [tga, pcx, sgi, sun, hdr, xbm, xpm, pbm, pgm, ppm];
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const work = mkdtempSync(join(tmpdir(), "shrink-misc-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
/** `magick <args> <prefix>:out` */
function im(out: string, ...args: string[]): Uint8Array {
  const path = join(work, `f${n++}`);
  const r = Bun.spawnSync(["magick", ...args, `${out}:${path}`], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return new Uint8Array(readFileSync(path));
}
const sig = (prefix: string, path: string) => Bun.spawnSync(["magick", "identify", "-format", "%w|%h|%[colorspace]|%[channels]|%#\n", `${prefix}:${path}`]).stdout.toString();
const flat = ["-size", "160x120", "xc:white", "-fill", "navy", "-draw", "rectangle 20,20 90,80", "-fill", "red", "-draw", "circle 120,60 120,90"];

async function shrinks(name: string, prefix: string, bytes: Uint8Array) {
  const e = make();
  const o = join(work, `o${n++}`);
  await Bun.write(o, bytes);
  const p = await e.file(name, bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status, `${r.reason} ${JSON.stringify(r.steps)}`).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  expect(sig(prefix, p)).toBe(sig(prefix, o));
}

t("LONG-01a: a plain-text PNM becomes binary with the same pixels (PPM, PGM, PBM)", async () => {
  await shrinks("a.ppm", "ppm", im("ppm", ...flat, "-compress", "None"));
  await shrinks("a.pgm", "pgm", im("pgm", ...flat, "-colorspace", "Gray", "-compress", "None"));
  await shrinks("a.pbm", "pbm", im("pbm", ...flat, "-monochrome", "-compress", "None"));
});

t("LONG-01b: an uncompressed TGA is run-length encoded", async () => {
  await shrinks("a.tga", "tga", im("tga", ...flat, "-compress", "None"));
});

t("LONG-01c: whatever the writers produce keeps its pixels or is left as it is (PCX, SGI, Sun, XBM, XPM, HDR)", async () => {
  const e = make();
  for (const [name, prefix, args] of [["a.pcx", "pcx", flat], ["a.sgi", "sgi", flat], ["a.ras", "sun", flat], ["a.xbm", "xbm", [...flat, "-monochrome"]], ["a.xpm", "xpm", flat], ["a.hdr", "hdr", flat]] as const) {
    const bytes = im(prefix, ...args);
    const o = join(work, `o${n++}`);
    await Bun.write(o, bytes);
    const p = await e.file(name, bytes);
    const r = await e.engine.optimizeFile(p);
    expect(r.status, `${name}: ${r.reason}`).not.toBe("failed");
    expect(r.after).toBeLessThanOrEqual(r.before);
    expect(sig(prefix, p)).toBe(sig(prefix, o));
  }
});

t("LONG-02: a file that is already compact is left byte for byte as it is", async () => {
  const bytes = im("ppm", ...flat);
  const e = make();
  const p = await e.file("a.ppm", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

t("LONG-03: truncated files are left alone", async () => {
  const e = make();
  for (const [name, prefix] of [["a.tga", "tga"], ["a.pcx", "pcx"], ["a.ppm", "ppm"], ["a.sgi", "sgi"]] as const) {
    const bytes = im(prefix, ...flat);
    const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
    const p = await e.file(name, cut);
    const r = await e.engine.optimizeFile(p);
    expect(r.status, name).not.toBe("optimized");
    expect(readFileSync(p)).toEqual(Buffer.from(cut));
  }
});

t("LONG-04: a tool that changes a pixel is rejected and the file is untouched", async () => {
  const bytes = im("ppm", ...flat, "-compress", "None");
  const other = im("ppm", ...flat, "-fill", "black", "-draw", "point 3,3");
  const e = make();
  const tp = await e.file("t.ppm", other);
  // identify runs the real ImageMagick; anything else (the rewrite) just copies the tampered picture over the output
  const liar = scriptTool(`if (args[0] === "identify") {
  const r = Bun.spawnSync([${JSON.stringify(Bun.which("magick"))}, ...args]);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.exitCode);
}
fs.copyFileSync(${JSON.stringify(tp)}, args[args.length - 1].replace(/^ppm:/, ""));`);
  const liarEngine = new Engine({ formats, cacheDir: e.dir + "/c2", tempDir: e.dir + "/tmp", settings: { toolPaths: { magick: liar } } });
  const p = await e.file("a.ppm", bytes);
  const r = await liarEngine.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(r.steps[0].detail).toContain("differs");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

t("LONG-05: a TGA needs a TGA name; content and extension must agree", async () => {
  const bytes = im("tga", ...flat, "-compress", "None");
  const e = make();
  expect((await e.engine.optimizeFile(await e.file("a.dat", bytes))).reason).toContain("unsupported");
  expect((await e.engine.optimizeFile(await e.file("a.tga", bytes))).status).toBe("optimized");
  const ppmBytes = im("ppm", ...flat, "-compress", "None");
  expect((await e.engine.optimizeFile(await e.file("a.tga2", ppmBytes))).status).toBe("optimized"); // an unknown extension is not a claim
  expect((await e.engine.optimizeFile(await e.file("b.pcx", ppmBytes))).reason).toContain("extension");
});

t("LONG-06: without ImageMagick the file is skipped (nothing can be verified)", async () => {
  const e = make({ disabledTools: ["magick"] });
  const r = await e.engine.optimizeFile(await e.file("a.ppm", im("ppm", ...flat, "-compress", "None")));
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("cannot verify");
});
