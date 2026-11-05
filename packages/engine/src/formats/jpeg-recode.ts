// The lossy JPEG step: decode, re-encode with cjpeg at the lowest quality that keeps the similarity floor, put the profile and EXIF back.
import { join } from "node:path";
import type { Step } from "../types";
import { judge, lowestQuality, MAX_LOSSY_PIXELS, rasterOf, type Raster } from "./lossy";
import { parseJpeg } from "./jpeg-parse";

/** The metadata segments of a JPEG that are worth carrying over: ICC always, EXIF when needed, everything else with keepAll. */
export function carriedSegments(orig: Uint8Array, o: { exif: boolean; all: boolean }): Uint8Array[] {
  const out: Uint8Array[] = [];
  const ascii = (at: number, n: number) => String.fromCharCode(...orig.subarray(at, at + n));
  let at = 2;
  while (at + 4 <= orig.length && orig[at] === 0xff) {
    const m = orig[at + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (orig[at + 2] << 8) | orig[at + 3];
    const seg = orig.subarray(at, at + 2 + len);
    const d = at + 4;
    const icc = m === 0xe2 && ascii(d, 12) === "ICC_PROFILE\0";
    const exif = m === 0xe1 && ascii(d, 6) === "Exif\0\0";
    const skip = m === 0xe0 || m === 0xee || (m === 0xe2 && ascii(d, 4) === "MPF\0") || (m >= 0xc0 && m <= 0xcf) || m === 0xdb || m === 0xc4 || m === 0xdd;
    if (icc || (exif && (o.exif || o.all)) || (o.all && !skip && !exif)) out.push(seg);
    at += 2 + len;
  }
  return out;
}

/** The JPEG without its EXIF segment, so a decoder does not rotate it: pixels are compared as stored. */
export function dropExif(jpeg: Uint8Array): Uint8Array {
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const m = jpeg[at + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (jpeg[at + 2] << 8) | jpeg[at + 3];
    if (m === 0xe1 && String.fromCharCode(...jpeg.subarray(at + 4, at + 10)) === "Exif\0\0") {
      const out = new Uint8Array(jpeg.length - 2 - len);
      out.set(jpeg.subarray(0, at));
      out.set(jpeg.subarray(at + 2 + len), at);
      return dropExif(out);
    }
    at += 2 + len;
  }
  return jpeg;
}

/** The stored pixels of a JPEG (EXIF orientation not applied). */
export const storedRaster = (jpeg: Uint8Array) => rasterOf(dropExif(jpeg));

/** Puts segments right after the JFIF header (or SOI). */
export function insertSegments(jpeg: Uint8Array, segs: Uint8Array[]): Uint8Array {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const extra = segs.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(jpeg.length + extra);
  out.set(jpeg.subarray(0, at));
  let p = at;
  for (const s of segs) (out.set(s, p), (p += s.length));
  out.set(jpeg.subarray(at), p);
  return out;
}

function ppm(r: Raster): Uint8Array {
  const head = new TextEncoder().encode(`P6\n${r.width} ${r.height}\n255\n`);
  const out = new Uint8Array(head.length + r.width * r.height * 3);
  out.set(head);
  for (let i = 0, o = head.length; i < r.width * r.height; i++, o += 3) {
    out[o] = r.rgba[i * 4];
    out[o + 1] = r.rgba[i * 4 + 1];
    out[o + 2] = r.rgba[i * 4 + 2];
  }
  return out;
}

export const jpegRecompress: Step = {
  id: "jpeg.recompress",
  tool: "cjpeg",
  lossy: true,
  when: (ctx) => (Number(ctx.facts.pixels) > MAX_LOSSY_PIXELS ? "too large to check the similarity" : true),
  async run(input, output, ctx) {
    const orig = new Uint8Array(await Bun.file(input).arrayBuffer());
    const info = parseJpeg(orig);
    const ref = await storedRaster(orig);
    const src = join(ctx.dir, "recode.ppm");
    await Bun.write(src, ppm(ref));
    const keep = ctx.settings.jpeg.keepMetadata;
    const segs = carriedSegments(orig, { exif: keep || ctx.facts.keepExif === true, all: keep });
    const hit = await lowestQuality(
      30,
      95,
      async (q) => {
        const path = join(ctx.dir, `recode-${q}.jpg`);
        const r = await ctx.run("cjpeg", ["-quality", String(q), "-optimize", "-progressive", ...(info.components === 1 ? ["-grayscale"] : []), "-outfile", path, src]);
        if (r.code !== 0) throw new Error(`cjpeg exited with ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`);
        const bytes = insertSegments(new Uint8Array(await Bun.file(path).arrayBuffer()), segs);
        await Bun.write(path, bytes);
        return { path, ok: judge(ref, await storedRaster(bytes), ctx.settings) === true };
      },
      ctx.signal,
    );
    await Bun.write(output, Bun.file(hit.path));
    ctx.note(`jpeg.recompress: quality ${hit.quality}`);
  },
};
