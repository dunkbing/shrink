import { deflateSync } from "node:zlib";

// Small writers for BMP, ICO/CUR, APNG and TIFF fixtures. Independent of the engine's own readers and writers.
export const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const le = (n: number, bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => Math.floor(n / 2 ** (8 * i)) & 255);
const be32 = (n: number) => Uint8Array.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

export interface BmpSpec {
  width: number;
  height: number;
  bpp: 1 | 4 | 8 | 16 | 24 | 32;
  /** RGBA, top row first (true colour), or palette indexes (palette images). */
  rgba?: Uint8Array;
  idx?: Uint8Array;
  palette?: number[][];
  /** 12 (OS/2), 40, 108 or 124. */
  header?: 12 | 40 | 108 | 124;
  topDown?: boolean;
  /** Raw pixel bytes to use instead (RLE data). */
  raw?: Uint8Array;
  compression?: number;
  /** For headers 108/124: colour space tag; 0 gives the "calibrated" kind. */
  colourSpace?: number;
  /** Non-zero endpoints make a calibrated space real. */
  endpoints?: boolean;
  ppm?: number;
}

export function makeBmp(s: BmpSpec): Uint8Array {
  const { width: w, height: h, bpp } = s;
  const hs = s.header ?? 40;
  const stride = hs === 12 ? ((w * bpp + 31) >> 5) << 2 : ((w * bpp + 31) >> 5) << 2;
  let body: Uint8Array;
  if (s.raw) body = s.raw;
  else {
    body = new Uint8Array(stride * h);
    for (let r = 0; r < h; r++) {
      const dst = (s.topDown ? r : h - 1 - r) * stride;
      for (let x = 0; x < w; x++) {
        const p = r * w + x;
        if (bpp <= 8) body[dst + Math.floor((x * bpp) / 8)] |= s.idx![p] << (8 - bpp * (((x * bpp) % 8) / bpp + 1));
        else if (bpp === 24) body.set([s.rgba![p * 4 + 2], s.rgba![p * 4 + 1], s.rgba![p * 4]], dst + x * 3);
        else if (bpp === 32) body.set([s.rgba![p * 4 + 2], s.rgba![p * 4 + 1], s.rgba![p * 4], s.rgba![p * 4 + 3]], dst + x * 4);
        else body.set(le(((s.rgba![p * 4] >> 3) << 10) | ((s.rgba![p * 4 + 1] >> 3) << 5) | (s.rgba![p * 4 + 2] >> 3), 2), dst + x * 2);
      }
    }
  }
  const pal = s.palette ?? [];
  const esz = hs === 12 ? 3 : 4;
  const palBytes = concat(pal.map((c) => Uint8Array.from(esz === 3 ? [c[2], c[1], c[0]] : [c[2], c[1], c[0], 0])));
  const info = new Uint8Array(hs);
  info.set(le(hs, 4));
  if (hs === 12) {
    info.set(le(w, 2), 4);
    info.set(le(h, 2), 6);
    info.set(le(1, 2), 8);
    info.set(le(bpp, 2), 10);
  } else {
    info.set(le(w, 4), 4);
    info.set(le(s.topDown ? -h >>> 0 : h, 4), 8);
    info.set(le(1, 2), 12);
    info.set(le(bpp, 2), 14);
    info.set(le(s.compression ?? 0, 4), 16);
    info.set(le(s.ppm ?? 2835, 4), 24);
    info.set(le(s.ppm ?? 2835, 4), 28);
    info.set(le(pal.length, 4), 32);
    if (hs >= 108) {
      info.set(le(0xff0000, 4), 40);
      info.set(le(0xff00, 4), 44);
      info.set(le(0xff, 4), 48);
      info.set(le(bpp === 32 && s.compression === 3 ? 0xff000000 : 0, 4), 52);
      info.set(le(s.colourSpace ?? 0x73524742, 4), 56);
      if (s.endpoints) info.set(le(0x1000, 4), 60);
    }
  }
  const off = 14 + hs + palBytes.length;
  const file = new Uint8Array(14);
  file.set([0x42, 0x4d]);
  file.set(le(off + body.length, 4), 2);
  file.set(le(off, 4), 10);
  return concat([file, info, palBytes, body]);
}

/** A picture with `colours` flat vertical bands plus a diagonal, as RGBA. */
export function bands(w: number, h: number, colours: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = Math.floor(((x + (y >> 3)) * colours) / (w + (h >> 3))) % colours;
      out.set([(c * 53) & 255, (c * 97 + 20) & 255, (c * 11 + 200) & 255, 255], (y * w + x) * 4);
    }
  return out;
}

/** A DIB for an icon: XOR bitmap (24 or 32 bit) plus the AND mask; height is doubled. */
export function makeIconDib(w: number, h: number, rgba: Uint8Array, bpp: 24 | 32, mask?: boolean[]): Uint8Array {
  const bmp = makeBmp({ width: w, height: h, bpp, rgba });
  const dib = bmp.slice(14);
  new DataView(dib.buffer).setInt32(8, h * 2, true);
  const ms = ((w + 31) >> 5) << 2;
  const m = new Uint8Array(ms * h);
  if (mask) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) m[(h - 1 - y) * ms + (x >> 3)] |= 0x80 >> (x & 7);
  return concat([dib, m]);
}

export function makeIco(images: { data: Uint8Array; w: number; h: number; bits?: number; hotspot?: [number, number] }[], type: 1 | 2 = 1): Uint8Array {
  let off = 6 + images.length * 16;
  const dir = images.map((im) => {
    const e = new Uint8Array(16);
    e[0] = im.w & 255;
    e[1] = im.h & 255;
    e.set(le(im.hotspot ? im.hotspot[0] : 1, 2), 4);
    e.set(le(im.hotspot ? im.hotspot[1] : (im.bits ?? 32), 2), 6);
    e.set(le(im.data.length, 4), 8);
    e.set(le(off, 4), 12);
    off += im.data.length;
    return e;
  });
  return concat([Uint8Array.from([0, 0, type, 0, images.length, 0]), ...dir, ...images.map((i) => i.data)]);
}

// ---- APNG

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([new TextEncoder().encode(type), data]);
  return concat([be32(data.length), body, be32(Bun.hash.crc32(body))]);
}

export interface ApngFrame {
  w: number;
  h: number;
  x?: number;
  y?: number;
  /** RGBA, w*h*4 */
  rgba: Uint8Array;
  delayNum?: number;
  delayDen?: number;
  dispose?: 0 | 1 | 2;
  blend?: 0 | 1;
}

const rgbaZ = (f: { w: number; h: number; rgba: Uint8Array }, level: number) => {
  const raw = new Uint8Array(f.h * (f.w * 4 + 1));
  for (let y = 0; y < f.h; y++) raw.set(f.rgba.subarray(y * f.w * 4, (y + 1) * f.w * 4), y * (f.w * 4 + 1) + 1);
  return new Uint8Array(deflateSync(raw, { level }));
};

/** An RGBA 8-bit APNG. `hidden`: the default image (IDAT) is `defaultImage` and not part of the animation. */
export function makeApng(o: { w: number; h: number; frames: ApngFrame[]; plays?: number; hidden?: boolean; defaultImage?: Uint8Array; level?: number }): Uint8Array {
  const level = o.level ?? 0;
  const parts: Uint8Array[] = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", concat([be32(o.w), be32(o.h), Uint8Array.from([8, 6, 0, 0, 0])])), chunk("acTL", concat([be32(o.frames.length), be32(o.plays ?? 0)]))];
  let seq = 0;
  const fctl = (f: ApngFrame) => chunk("fcTL", concat([be32(seq++), be32(f.w), be32(f.h), be32(f.x ?? 0), be32(f.y ?? 0), Uint8Array.from([(f.delayNum ?? 10) >> 8, (f.delayNum ?? 10) & 255, (f.delayDen ?? 100) >> 8, (f.delayDen ?? 100) & 255, f.dispose ?? 0, f.blend ?? 0])]));
  o.frames.forEach((f, i) => {
    if (i === 0 && o.hidden) parts.push(chunk("IDAT", rgbaZ({ w: o.w, h: o.h, rgba: o.defaultImage! }, level)));
    parts.push(fctl(f));
    const z = rgbaZ(f, level);
    parts.push(i === 0 && !o.hidden ? chunk("IDAT", z) : chunk("fdAT", concat([be32(seq++), z])));
  });
  parts.push(chunk("IEND", new Uint8Array()));
  return concat(parts);
}

// ---- TIFF

/** A little-endian, classic, uncompressed 8-bit gray TIFF with extra tags: [tag, type, count, value(4 bytes)]. */
export function makeTiff(w: number, h: number, pixels: Uint8Array, extra: [number, number, number, number][] = []): Uint8Array {
  const tags: [number, number, number, number][] = [
    [256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 8], [277, 3, 1, 1], [278, 3, 1, h], [279, 4, 1, w * h], ...extra,
  ];
  tags.sort((a, b) => a[0] - b[0]);
  const ifdAt = 8 + w * h;
  const head = concat([Uint8Array.from([0x49, 0x49, 42, 0]), le(ifdAt, 4)]);
  const ifd = concat([le(tags.length, 2), ...tags.map(([t, ty, c, v]) => concat([le(t, 2), le(ty, 2), le(c, 4), le(v, ty === 3 ? 2 : 4), new Uint8Array(ty === 3 ? 2 : 0)])), le(0, 4)]);
  return concat([head, pixels, ifd]);
}
