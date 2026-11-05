// A strict PNG reader for verification: every pixel as 16-bit RGBA (so 16-bit images are compared in full), CRCs checked.
import { inflateSync } from "node:zlib";
import { readOrientation } from "./exif";

export interface PngInfo {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  interlaced: boolean;
  animated: boolean;
  /** width * height * 4 samples (R, G, B, A), 16 bits each. */
  pixels: Uint16Array;
  /** Chunks that change how the picture looks, by type. */
  colour: Map<string, Uint8Array>;
  /** EXIF orientation (1 when none). */
  orientation: number;
  chunks: string[];
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const COLOUR = ["iCCP", "cICP", "gAMA", "cHRM", "sRGB", "sBIT"];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function fail(m: string): never {
  throw new Error(m);
}

function unfilter(data: Uint8Array, at: number, rows: number, rowBytes: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rows * rowBytes);
  for (let y = 0; y < rows; y++) {
    const f = data[at + y * (rowBytes + 1)];
    const src = at + y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - rowBytes + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - rowBytes + x - bpp] : 0;
      let v = data[src + x];
      switch (f) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: fail(`bad filter type ${f}`);
      }
      out[dst + x] = v & 255;
    }
  }
  return out;
}

export function decodePng(bytes: Uint8Array): PngInfo {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) fail("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idat: Uint8Array[] = [];
  const colour = new Map<string, Uint8Array>();
  const chunks: string[] = [];
  let ihdr: Uint8Array | null = null, plte: Uint8Array | null = null, trns: Uint8Array | null = null, exif: Uint8Array | null = null;
  let animated = false, ended = false;
  let at = 8;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (at + 12 + len > bytes.length) fail("truncated");
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (Bun.hash.crc32(bytes.subarray(at + 4, at + 8 + len)) !== view.getUint32(at + 8 + len)) fail(`bad CRC in ${type}`);
    chunks.push(type);
    if (type === "IHDR") ihdr = data;
    else if (type === "PLTE") plte = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "acTL") animated = true;
    else if (type === "eXIf") exif = data;
    if (COLOUR.includes(type)) colour.set(type, data);
    at += 12 + len;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || !ihdr || ihdr.length !== 13) fail("truncated");
  const iv = new DataView(ihdr.buffer, ihdr.byteOffset, 13);
  const width = iv.getUint32(0), height = iv.getUint32(4), bitDepth = ihdr[8], colorType = ihdr[9], interlaced = ihdr[12] === 1;
  if (!width || !height || width > 1 << 16 || height > 1 << 16 || width * height > 1 << 28) fail("bad size");
  if (!DEPTHS[colorType]?.includes(bitDepth)) fail("bad colour type or depth");
  if (colorType === 3 && !plte) fail("missing palette");
  const bits = CHANNELS[colorType] * bitDepth;
  const bpp = Math.max(1, bits >> 3);
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  } catch {
    return fail("bad image data");
  }

  const pixels = new Uint16Array(width * height * 4);
  const maxv = (1 << bitDepth) - 1;
  const scale = bitDepth === 16 ? 1 : 65535 / maxv;
  const sample = (row: Uint8Array, base: number, i: number): number => {
    if (bitDepth === 16) return (row[base + i * 2] << 8) | row[base + i * 2 + 1];
    if (bitDepth === 8) return row[base + i];
    const per = 8 / bitDepth, byte = row[base + Math.floor(i / per)];
    return (byte >> (8 - bitDepth * ((i % per) + 1))) & maxv;
  };
  const trnsSample = (k: number) => (trns && trns.length >= (k + 1) * 2 ? (trns[k * 2] << 8) | trns[k * 2 + 1] : -1);
  const [tg, tr, tgn, tb] = [trnsSample(0), trnsSample(0), trnsSample(1), trnsSample(2)];

  const put = (row: Uint8Array, px: number, x: number, y: number) => {
    const o = (y * width + x) * 4;
    let r = 0, g = 0, b = 0, a = 65535;
    const s = (k: number) => sample(row, 0, px * CHANNELS[colorType] + k);
    switch (colorType) {
      case 0: { const v = s(0); r = g = b = Math.round(v * scale); if (tg === v && trns) a = 0; break; }
      case 2: { const R = s(0), G = s(1), B = s(2); [r, g, b] = [R, G, B].map((v) => Math.round(v * scale)); if (trns && tr === R && tgn === G && tb === B) a = 0; break; }
      case 3: { const i = s(0); if (i * 3 + 2 >= plte!.length) fail("palette index out of range"); r = plte![i * 3] * 257; g = plte![i * 3 + 1] * 257; b = plte![i * 3 + 2] * 257; if (trns && i < trns.length) a = trns[i] * 257; break; }
      case 4: { r = g = b = Math.round(s(0) * scale); a = Math.round(s(1) * scale); break; }
      case 6: { r = Math.round(s(0) * scale); g = Math.round(s(1) * scale); b = Math.round(s(2) * scale); a = Math.round(s(3) * scale); break; }
    }
    pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = a;
  };

  let used = 0;
  for (const [x0, y0, dx, dy] of interlaced ? PASSES : [[0, 0, 1, 1]]) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bits) / 8);
    if (used + ph * (rowBytes + 1) > raw.length) fail("image data too short");
    const rows = unfilter(raw, used, ph, rowBytes, bpp);
    used += ph * (rowBytes + 1);
    for (let y = 0; y < ph; y++) {
      const row = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
      for (let x = 0; x < pw; x++) put(row, x, x0 + x * dx, y0 + y * dy);
    }
  }
  let orientation = 1;
  if (exif && exif.length > 12) orientation = readOrientation(exif);
  return { width, height, colorType, bitDepth, interlaced, animated, pixels, colour, orientation, chunks };
}

/** Do two decoded pictures hold the same pixels? Fully transparent pixels count as equal whatever their colour. */
export function samePixels(a: PngInfo, b: PngInfo): true | string {
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}x${a.height} became ${b.width}x${b.height}`;
  if (a.animated !== b.animated) return "animation changed";
  const pa = a.pixels, pb = b.pixels;
  for (let i = 0; i < pa.length; i += 4) {
    if (pa[i + 3] === 0 && pb[i + 3] === 0) continue;
    if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2] || pa[i + 3] !== pb[i + 3]) {
      const p = i / 4;
      return `pixel ${p % a.width},${Math.floor(p / a.width)} changed`;
    }
  }
  return true;
}
