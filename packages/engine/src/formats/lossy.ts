// Shared by the lossy steps: decoded pictures, the similarity measure (SSIM) and a search for the lowest quality that still passes.
import { decodePng, type PngInfo } from "./png-decode";
import { SkipFile, type Settings } from "../types";

/** Pictures with more pixels than this are not re-encoded (the similarity check would need too much memory). */
export const MAX_LOSSY_PIXELS = 24_000_000;

/** 8-bit RGBA. */
export interface Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** A PNG's pixels at 8 bits. */
export function rasterOfPng(info: PngInfo): Raster {
  if (info.hash !== undefined) throw new SkipFile("too large for a similarity check");
  const rgba = new Uint8Array(info.pixels.length);
  for (let i = 0; i < rgba.length; i++) rgba[i] = Math.round(info.pixels[i] / 257);
  return { width: info.width, height: info.height, rgba };
}

/** Decodes anything Bun.Image reads (JPEG, WebP, PNG) to 8-bit RGBA, via a canonical PNG. */
export async function rasterOf(bytes: Uint8Array): Promise<Raster> {
  const png = await new Bun.Image(bytes).png({ compressionLevel: 1 }).bytes();
  return rasterOfPng(decodePng(new Uint8Array(png)));
}

/** Luma (Rec. 601), the picture composited over mid grey so transparent areas do not count as black. */
function luma(r: Raster): Float32Array {
  const n = r.width * r.height, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = r.rgba[i * 4 + 3] / 255;
    const y = 0.299 * r.rgba[i * 4] + 0.587 * r.rgba[i * 4 + 1] + 0.114 * r.rgba[i * 4 + 2];
    out[i] = y * a + 128 * (1 - a);
  }
  return out;
}

function alphaPlane(r: Raster): Float32Array {
  const n = r.width * r.height, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r.rgba[i * 4 + 3];
  return out;
}

/** Mean SSIM of two planes: 8x8 windows every 4 pixels (the window shrinks for tiny pictures). */
export function ssimPlane(a: Float32Array, b: Float32Array, w: number, h: number): number {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const win = Math.min(8, w, h), step = Math.max(1, Math.min(4, win));
  let sum = 0, count = 0;
  const n = win * win;
  const last = (size: number) => size - win;
  for (let y0 = 0; ; y0 = Math.min(y0 + step, last(h))) {
    for (let x0 = 0; ; x0 = Math.min(x0 + step, last(w))) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = y0; y < y0 + win; y++) {
        const row = y * w;
        for (let x = x0; x < x0 + win; x++) {
          const p = a[row + x], q = b[row + x];
          sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
        }
      }
      const ma = sa / n, mb = sb / n;
      const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
      if (x0 >= last(w)) break;
    }
    if (y0 >= last(h)) break;
  }
  return sum / count;
}

export interface Similarity {
  ssim: number;
  /** Why the pictures differ in more than looks (size, transparency), if they do. */
  problem: string | null;
}

/** How alike two pictures are: same size, same transparency (fully transparent stays so, opaque stays opaque), SSIM of the luma and of the alpha. */
export function compare(a: Raster, b: Raster, floor: number): Similarity {
  if (a.width !== b.width || a.height !== b.height) return { ssim: 0, problem: `size ${a.width}x${a.height} became ${b.width}x${b.height}` };
  const n = a.width * a.height;
  let hasA = false, hasB = false, wrong = 0;
  for (let i = 0; i < n; i++) {
    const x = a.rgba[i * 4 + 3], y = b.rgba[i * 4 + 3];
    if (x !== 255) hasA = true;
    if (y !== 255) hasB = true;
    if ((x === 0) !== (y === 0) || (x === 255) !== (y === 255)) wrong++;
  }
  if (hasA !== hasB) return { ssim: 0, problem: hasA ? "transparency was lost" : "transparency was added" };
  if (wrong > n * 0.001) return { ssim: 0, problem: "transparent and opaque areas changed" };
  let ssim = ssimPlane(luma(a), luma(b), a.width, a.height);
  if (hasA) {
    const alpha = ssimPlane(alphaPlane(a), alphaPlane(b), a.width, a.height);
    if (alpha < floor) return { ssim: alpha, problem: `alpha channel similarity ${alpha.toFixed(4)} is below ${floor}` };
    ssim = Math.min(ssim, alpha);
  }
  return { ssim, problem: null };
}

/** true, or why a candidate picture is not similar enough to the original. */
export function judge(original: Raster, candidate: Raster, settings: Settings): true | string {
  const floor = settings.lossy.ssim;
  const s = compare(original, candidate, floor);
  if (s.problem) return s.problem;
  return s.ssim >= floor ? true : `similarity ${s.ssim.toFixed(4)} is below the floor ${floor}`;
}

/**
 * Binary search for the lowest quality in [lo, hi] whose result still passes: `encode` writes a candidate for a quality and
 * says if it is similar enough. Returns the path of the smallest passing candidate.
 */
export async function lowestQuality(lo: number, hi: number, encode: (q: number) => Promise<{ path: string; ok: boolean }>, signal: AbortSignal): Promise<{ path: string; quality: number }> {
  let best: { path: string; quality: number } | null = null;
  while (lo <= hi) {
    if (signal.aborted) throw new Error("cancelled");
    const q = (lo + hi) >> 1;
    const r = await encode(q);
    if (r.ok) {
      best = { path: r.path, quality: q };
      hi = q - 1;
    } else lo = q + 1;
  }
  if (!best) throw new Error("no quality reaches the similarity floor");
  return best;
}
