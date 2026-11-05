// A strict BMP/DIB reader (also used for the images inside ICO/CUR) and a writer for the lossless repacking.
// Every picture becomes top-down 8-bit RGBA; anything unusual throws (damaged) or SkipFile (unsupported).
import { SkipFile } from "../types";

export interface Bitmap {
  width: number;
  height: number;
  /** width * height * 4 bytes, top row first. */
  rgba: Uint8Array;
  /** The picture has real transparency (an alpha channel in use, or an ICO mask with holes). */
  alpha: boolean;
  bpp: number;
  compression: number;
  headerSize: number;
  xppm: number;
  yppm: number;
  /** Colours in the palette (0 for true colour). */
  colours: number;
  /** Every channel has 8 bits (or comes from a palette): other widths are scaled up and viewers differ on how. */
  exact: boolean;
}

function fail(m: string): never {
  throw new Error(m);
}

const COLOUR_SPACES_OK = [0, 0x73524742, 0x57696e20]; // calibrated with no endpoints, sRGB, Windows default

/** Reads a DIB that starts at `at` (the info header). `ico`: the height counts the AND mask too and the pixels follow the palette. */
export function decodeDib(bytes: Uint8Array, at: number, o: { dataOffset?: number; ico?: boolean } = {}): Bitmap {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (at + 12 > bytes.length) fail("truncated");
  const hsize = view.getUint32(at, true);
  let width: number, height: number, bpp: number, compression = 0, colours = 0, xppm = 0, yppm = 0;
  let masks = [0, 0, 0, 0];
  if (hsize === 12) {
    width = view.getUint16(at + 4, true);
    height = view.getUint16(at + 6, true);
    bpp = view.getUint16(at + 10, true);
    if (view.getUint16(at + 8, true) !== 1) fail("bad planes");
  } else if ([40, 52, 56, 108, 124].includes(hsize)) {
    if (at + hsize > bytes.length) fail("truncated");
    width = view.getInt32(at + 4, true);
    height = view.getInt32(at + 8, true);
    if (view.getUint16(at + 12, true) !== 1) fail("bad planes");
    bpp = view.getUint16(at + 14, true);
    compression = view.getUint32(at + 16, true);
    xppm = view.getInt32(at + 24, true);
    yppm = view.getInt32(at + 28, true);
    colours = view.getUint32(at + 32, true);
    if (hsize >= 52) masks = [0, 4, 8, hsize >= 56 ? 12 : -1].map((k) => (k < 0 ? 0 : view.getUint32(at + 40 + k, true)));
    if (hsize >= 108) {
      const cs = view.getUint32(at + 56, true);
      if (!COLOUR_SPACES_OK.includes(cs)) throw new SkipFile("BMP with a colour space or profile");
      if (cs === 0 && [...Array(9)].some((_, i) => view.getUint32(at + 60 + i * 4, true) !== 0)) throw new SkipFile("BMP with a colour space or profile");
      if (hsize === 124 && view.getUint32(at + 108 + 8, true) !== 0) throw new SkipFile("BMP with a colour profile");
    }
  } else if (hsize === 64 || hsize === 16) throw new SkipFile("OS/2 2.x BMP header");
  else fail("unknown header");
  if (compression === 4 || compression === 5) throw new SkipFile("BMP holding JPEG or PNG data");
  if (![0, 1, 2, 3, 6].includes(compression)) throw new SkipFile(`BMP compression ${compression} is not supported`);
  const topDown = height < 0;
  height = Math.abs(height);
  let rows = height;
  if (o.ico) {
    if (height % 2) fail("odd icon height");
    rows = height / 2;
  }
  if (width <= 0 || rows <= 0 || width > 1 << 16 || rows > 1 << 16 || width * rows > 1 << 27) fail("bad size");
  if (![1, 2, 4, 8, 16, 24, 32].includes(bpp)) fail("bad bit count");
  if (bpp === 2) throw new SkipFile("2-bit BMP");
  if ((compression === 1 && bpp !== 8) || (compression === 2 && bpp !== 4)) fail("RLE with the wrong bit count");
  if ((compression === 3 || compression === 6) && bpp !== 16 && bpp !== 32) fail("bitfields with the wrong bit count");
  if (topDown && (compression === 1 || compression === 2)) fail("top-down RLE");

  let p = at + hsize;
  if (hsize === 40 && (compression === 3 || compression === 6)) {
    const n = compression === 6 ? 4 : 3;
    if (p + n * 4 > bytes.length) fail("truncated");
    masks = [0, 1, 2, 3].map((k) => (k < n ? view.getUint32(p + k * 4, true) : 0));
    p += n * 4;
  }
  // palette
  let palette: Uint8Array | null = null;
  let entries = 0;
  if (bpp <= 8) {
    entries = colours || 1 << bpp;
    if (entries > 1 << bpp) fail("palette too large");
    const esz = hsize === 12 ? 3 : 4;
    if (p + entries * esz > bytes.length) fail("truncated palette");
    palette = new Uint8Array(entries * 3);
    for (let i = 0; i < entries; i++) {
      palette[i * 3] = bytes[p + i * esz + 2];
      palette[i * 3 + 1] = bytes[p + i * esz + 1];
      palette[i * 3 + 2] = bytes[p + i * esz];
    }
    p += entries * esz;
  }
  const dataAt = o.dataOffset ?? p;
  if (dataAt < p || dataAt > bytes.length) fail("bad pixel data offset");
  const rgba = new Uint8Array(width * rows * 4);
  const rowOf = (r: number) => (topDown ? r : rows - 1 - r); // file row r to picture row
  let alpha = false, exact = true;

  if (compression === 1 || compression === 2) {
    const idx = decodeRle(bytes, dataAt, width, rows, compression === 2);
    for (let r = 0; r < rows; r++)
      for (let x = 0; x < width; x++) {
        const i = idx[r * width + x];
        if (i >= entries) fail("palette index out of range");
        const o4 = (rowOf(r) * width + x) * 4;
        rgba[o4] = palette![i * 3]; rgba[o4 + 1] = palette![i * 3 + 1]; rgba[o4 + 2] = palette![i * 3 + 2]; rgba[o4 + 3] = 255;
      }
  } else {
    const stride = ((width * bpp + 31) >> 5) << 2;
    if (dataAt + stride * rows > bytes.length) fail("truncated pixel data");
    // channel extraction for 16/32 bits
    const shifts = masks.map((m) => (m ? 31 - Math.clz32(m & -m) : 0));
    const widths = masks.map((m, k) => (m ? popcount(m >>> shifts[k]) : 0));
    if (bpp === 16 || bpp === 32) {
      if (compression === 0) {
        if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f, 0];
        else masks = [0xff0000, 0xff00, 0xff, 0];
        for (let k = 0; k < 4; k++) (shifts[k] = masks[k] ? 31 - Math.clz32(masks[k] & -masks[k]) : 0), (widths[k] = masks[k] ? popcount(masks[k] >>> shifts[k]) : 0);
      } else {
        for (let k = 0; k < 3; k++) if (!masks[k]) fail("missing colour mask");
        if (hsize === 40 && compression === 3) masks[3] = 0, (widths[3] = 0);
      }
    }
    let anyAlpha = false;
    for (let r = 0; r < rows; r++) {
      const row = dataAt + r * stride;
      const dst = rowOf(r) * width * 4;
      for (let x = 0; x < width; x++) {
        const d = dst + x * 4;
        switch (bpp) {
          case 1: case 4: case 8: {
            const per = 8 / bpp;
            const i = (bytes[row + Math.floor(x / per)] >> (8 - bpp * ((x % per) + 1))) & ((1 << bpp) - 1);
            if (i >= entries) fail("palette index out of range");
            rgba[d] = palette![i * 3]; rgba[d + 1] = palette![i * 3 + 1]; rgba[d + 2] = palette![i * 3 + 2]; rgba[d + 3] = 255;
            break;
          }
          case 24:
            rgba[d] = bytes[row + x * 3 + 2]; rgba[d + 1] = bytes[row + x * 3 + 1]; rgba[d + 2] = bytes[row + x * 3]; rgba[d + 3] = 255;
            break;
          default: {
            const v = bpp === 16 ? view.getUint16(row + x * 2, true) : view.getUint32(row + x * 4, true);
            for (let k = 0; k < 3; k++) rgba[d + k] = scale((v & masks[k]) >>> shifts[k], widths[k]);
            if (masks[3]) {
              rgba[d + 3] = scale((v & masks[3]) >>> shifts[3], widths[3]);
              if (rgba[d + 3] !== 255) anyAlpha = true;
            } else if (bpp === 32 && compression === 0 && bytes[row + x * 4 + 3] !== 0) anyAlpha = true;
            else rgba[d + 3] = 255;
          }
        }
      }
    }
    if (bpp === 32 && compression === 0) {
      // the fourth byte is alpha only if it is used at all
      for (let r = 0; r < rows; r++)
        for (let x = 0; x < width; x++) rgba[(rowOf(r) * width + x) * 4 + 3] = anyAlpha ? bytes[dataAt + r * stride + x * 4 + 3] : 255;
    }
    alpha = anyAlpha;
    exact = (bpp !== 16 && bpp !== 32) || widths.slice(0, 3).every((w) => w === 8);
    if (o.ico) {
      // the AND mask: 1 = transparent; a 32-bit image with alpha ignores it
      const maskAt = dataAt + stride * rows;
      const mstride = ((width + 31) >> 5) << 2;
      if (maskAt + mstride * rows > bytes.length) fail("truncated mask");
      if (!(bpp === 32 && anyAlpha)) {
        for (let r = 0; r < rows; r++)
          for (let x = 0; x < width; x++) {
            if ((bytes[maskAt + r * mstride + (x >> 3)] >> (7 - (x & 7))) & 1) {
              const d = (rowOf(r) * width + x) * 4;
              rgba[d] = rgba[d + 1] = rgba[d + 2] = rgba[d + 3] = 0;
              alpha = true;
            }
          }
      }
    }
    return { width, height: rows, rgba, alpha, bpp, compression, headerSize: hsize, xppm, yppm, colours: entries, exact };
  }
  if (o.ico) {
    // RLE is not used in icons, but keep the mask rule for palette images handled above
    fail("RLE inside an icon");
  }
  return { width, height: rows, rgba, alpha, bpp, compression, headerSize: hsize, xppm, yppm, colours: entries, exact };
}

const popcount = (v: number) => {
  let n = 0;
  for (; v; v >>>= 1) n += v & 1;
  return n;
};
const scale = (v: number, bits: number) => (bits === 0 ? 255 : bits === 8 ? v : Math.round((v * 255) / ((1 << bits) - 1)));

/** RLE8/RLE4 to palette indexes (file order, top row of the file first). Gaps left by jumps are not supported. */
function decodeRle(d: Uint8Array, at: number, w: number, h: number, four: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const set = new Uint8Array(w * h);
  let x = 0, y = 0, p = at, ended = false;
  const put = (v: number) => {
    if (x >= w || y >= h) fail("RLE runs outside the picture");
    out[y * w + x] = v;
    set[y * w + x] = 1;
    x++;
  };
  while (p + 1 < d.length && !ended) {
    const n = d[p++], v = d[p++];
    if (n > 0) {
      for (let i = 0; i < n; i++) put(four ? (i % 2 ? v & 15 : v >> 4) : v);
    } else if (v === 0) (x = 0), y++;
    else if (v === 1) ended = true;
    else if (v === 2) {
      if (p + 2 > d.length) fail("truncated");
      x += d[p++];
      y += d[p++];
    } else {
      const bytes = four ? (v + 1) >> 1 : v;
      if (p + bytes > d.length) fail("truncated");
      for (let i = 0; i < v; i++) put(four ? (i % 2 ? d[p + (i >> 1)] & 15 : d[p + (i >> 1)] >> 4) : d[p + i]);
      p += bytes + (bytes & 1);
    }
  }
  if (set.some((s) => !s)) {
    if (!ended) fail("truncated pixel data");
    throw new SkipFile("RLE bitmap with undefined pixels");
  }
  return out;
}

export function decodeBmp(bytes: Uint8Array): Bitmap {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) fail("not a BMP");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return decodeDib(bytes, 14, { dataOffset: view.getUint32(10, true) });
}

export function sameBitmap(a: Bitmap, b: Bitmap): true | string {
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}x${a.height} became ${b.width}x${b.height}`;
  const pa = a.rgba, pb = b.rgba;
  for (let i = 0; i < pa.length; i += 4) {
    if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2] || pa[i + 3] !== pb[i + 3]) {
      const q = i / 4;
      return `pixel ${q % a.width},${Math.floor(q / a.width)} changed`;
    }
  }
  return true;
}

// ---- writer

function rle(idx: Uint8Array, w: number, h: number, four: boolean): Uint8Array {
  const out: number[] = [];
  for (let r = h - 1; r >= 0; r--) {
    const row = idx.subarray(r * w, (r + 1) * w);
    let i = 0;
    while (i < w) {
      let run = 1;
      while (i + run < w && row[i + run] === row[i] && run < 255) run++;
      if (run >= 3) {
        out.push(run, four ? (row[i] << 4) | row[i] : row[i]);
        i += run;
        continue;
      }
      // literal stretch until the next run of 3
      let j = i;
      while (j < w && j - i < 255) {
        let r2 = 1;
        while (j + r2 < w && row[j + r2] === row[j] && r2 < 3) r2++;
        if (r2 >= 3) break;
        j++;
      }
      let n = j - i;
      if (n === 0) n = 1, j = i + 1;
      if (n < 3) {
        for (let k = i; k < j; k++) out.push(1, four ? (row[k] << 4) | row[k] : row[k]);
      } else {
        out.push(0, n);
        if (four) {
          for (let k = 0; k < n; k += 2) out.push((row[i + k] << 4) | (k + 1 < n ? row[i + k + 1] : 0));
          if (((n + 1) >> 1) & 1) out.push(0);
        } else {
          for (let k = 0; k < n; k++) out.push(row[i + k]);
          if (n & 1) out.push(0);
        }
      }
      i = j;
    }
    out.push(0, 0);
  }
  out[out.length - 1] = 1; // the last end-of-line becomes end-of-bitmap
  return Uint8Array.from(out);
}

/** A BMP with a plain 40-byte header: 24-bit, or palette (1/4/8 bits, optionally RLE). `idx`/`palette` for palette images. */
export function writeBmp(o: { width: number; height: number; xppm: number; yppm: number; bpp: 1 | 4 | 8 | 24; rle?: boolean; idx?: Uint8Array; palette?: Uint8Array; rgba?: Uint8Array }): Uint8Array {
  const { width: w, height: h, bpp } = o;
  const nPal = bpp === 24 ? 0 : o.palette!.length / 3;
  const stride = ((w * bpp + 31) >> 5) << 2;
  let body: Uint8Array;
  if (o.rle) body = rle(o.idx!, w, h, bpp === 4);
  else {
    body = new Uint8Array(stride * h);
    for (let r = 0; r < h; r++) {
      const dst = (h - 1 - r) * stride;
      for (let x = 0; x < w; x++) {
        if (bpp === 24) {
          const s = (r * w + x) * 4;
          body[dst + x * 3] = o.rgba![s + 2]; body[dst + x * 3 + 1] = o.rgba![s + 1]; body[dst + x * 3 + 2] = o.rgba![s];
        } else {
          const per = 8 / bpp;
          body[dst + Math.floor(x / per)] |= o.idx![r * w + x] << (8 - bpp * ((x % per) + 1));
        }
      }
    }
  }
  const off = 14 + 40 + nPal * 4;
  const out = new Uint8Array(off + body.length);
  const v = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  v.setUint32(2, out.length, true);
  v.setUint32(10, off, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, bpp, true);
  v.setUint32(30, o.rle ? (bpp === 4 ? 2 : 1) : 0, true);
  v.setUint32(34, o.rle ? body.length : 0, true);
  v.setInt32(38, o.xppm, true);
  v.setInt32(42, o.yppm, true);
  v.setUint32(46, nPal, true);
  for (let i = 0; i < nPal; i++) {
    out[54 + i * 4] = o.palette![i * 3 + 2];
    out[54 + i * 4 + 1] = o.palette![i * 3 + 1];
    out[54 + i * 4 + 2] = o.palette![i * 3];
  }
  out.set(body, off);
  return out;
}
