import { type Format, type Settings, type Step } from "../types";
import { decodeBmp, sameBitmap, writeBmp, type Bitmap } from "./bmp-decode";
import { errorMessage } from "../errors";

/** Repacks the picture the smallest way that keeps every pixel: palette of 2/16/256 colours (raw or RLE) or 24-bit. */
export function repackBmp(bm: Bitmap): Uint8Array | null {
  if (bm.alpha || !bm.exact) return null;
  const n = bm.width * bm.height;
  const idx = new Uint8Array(n);
  const seen = new Map<number, number>();
  const pal: number[] = [];
  let palette = true;
  for (let i = 0; i < n; i++) {
    const key = (bm.rgba[i * 4] << 16) | (bm.rgba[i * 4 + 1] << 8) | bm.rgba[i * 4 + 2];
    let k = seen.get(key);
    if (k === undefined) {
      if (seen.size === 256) {
        palette = false;
        break;
      }
      k = seen.size;
      seen.set(key, k);
      pal.push(key >> 16, (key >> 8) & 255, key & 255);
    }
    idx[i] = k;
  }
  const base = { width: bm.width, height: bm.height, xppm: bm.xppm, yppm: bm.yppm };
  const best: Uint8Array[] = [];
  if (!palette) best.push(writeBmp({ ...base, bpp: 24, rgba: bm.rgba }));
  else {
    const p = Uint8Array.from(pal);
    const colours = seen.size;
    for (const bpp of [1, 4, 8] as const) {
      if (colours > 1 << bpp) continue;
      best.push(writeBmp({ ...base, bpp, idx, palette: p }));
      if (bpp !== 1) best.push(writeBmp({ ...base, bpp, idx, palette: p, rle: true }));
    }
  }
  return best.reduce((a, b) => (b.length < a.length ? b : a));
}

const repack: Step = {
  id: "bmp.repack",
  async run(input, output) {
    const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
    const out = repackBmp(decodeBmp(bytes));
    await Bun.write(output, out ?? bytes);
  },
};

export const bmp: Format = {
  id: "bmp",
  extensions: ["bmp", "dib"],
  detect: (h) => h[0] === 0x42 && h[1] === 0x4d && h.length >= 26 && [12, 40, 52, 56, 64, 108, 124].includes(h[14] | (h[15] << 8)) && h[16] === 0 && h[17] === 0,
  flags: (s: Settings) => ({ keepMetadata: s.bmp.keepMetadata }),
  steps: [repack],
  oracle: {
    async prepare(path) {
      return decodeBmp(new Uint8Array(await Bun.file(path).arrayBuffer()));
    },
    async same(original, candidatePath) {
      const a = original as Bitmap;
      let b: Bitmap;
      try {
        b = decodeBmp(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()));
      } catch (e) {
        return `the result does not decode: ${errorMessage(e)}`;
      }
      const same = sameBitmap(a, b);
      if (same !== true) return same;
      if (a.xppm !== b.xppm || a.yppm !== b.yppm) return "resolution changed";
      return true;
    },
  },
};

export const formats: Format[] = [bmp];
