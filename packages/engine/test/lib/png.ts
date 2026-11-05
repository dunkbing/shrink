import { deflateSync } from "node:zlib";

// A small PNG writer for fixtures: any colour type and bit depth, no filtering, optional extra chunks.
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(t.length + data.length);
  body.set(t);
  body.set(data, 4);
  return concat([u32(data.length), body, u32(Bun.hash.crc32(body))]);
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

export interface PngSpec {
  width: number;
  height: number;
  /** 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA */
  colorType: 0 | 2 | 3 | 4 | 6;
  bitDepth: 1 | 2 | 4 | 8 | 16;
  /** Raw scanline bytes (without filter bytes), height * rowBytes. Default: a gradient. */
  data?: Uint8Array;
  palette?: number[][];
  /** Extra chunks placed before IDAT: [type, data]. */
  chunks?: [string, Uint8Array][];
  compression?: number;
  /** Split the image data into several IDAT chunks of this size. */
  idatSize?: number;
}

const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as const;

export function rowBytes(s: Pick<PngSpec, "width" | "colorType" | "bitDepth">) {
  return Math.ceil((s.width * channels[s.colorType] * s.bitDepth) / 8);
}

export function makePng(s: PngSpec): Uint8Array {
  const rb = rowBytes(s);
  const raw = new Uint8Array(s.height * (rb + 1));
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < rb; x++) raw[y * (rb + 1) + 1 + x] = s.data ? s.data[y * rb + x] : (x * 7 + y * 3) & 255;
  }
  const ihdr = concat([u32(s.width), u32(s.height), new Uint8Array([s.bitDepth, s.colorType, 0, 0, 0])]);
  const z = new Uint8Array(deflateSync(raw, { level: s.compression ?? 1 }));
  const idats: Uint8Array[] = [];
  const size = s.idatSize ?? z.length;
  for (let i = 0; i < z.length; i += size) idats.push(chunk("IDAT", z.subarray(i, i + size)));
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...(s.palette ? [chunk("PLTE", new Uint8Array(s.palette.flat()))] : []),
    ...(s.chunks ?? []).map(([t, d]) => chunk(t, d)),
    ...idats,
    chunk("IEND", new Uint8Array()),
  ]);
}
