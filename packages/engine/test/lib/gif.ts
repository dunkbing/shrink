// A GIF writer for fixtures: frames of palette indices, any sub-rectangle, with the GIF89a extensions.
export interface GifFrameSpec {
  /** Palette indices, w * h. */
  pixels: Uint8Array;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  delay?: number;
  /** 0 none, 1 keep, 2 background, 3 previous */
  disposal?: number;
  transparent?: number;
  interlace?: boolean;
  /** A palette of its own (RGB triples, power-of-two length). */
  localPalette?: number[][];
}

export interface GifSpec {
  width: number;
  height: number;
  palette: number[][];
  frames: GifFrameSpec[];
  loop?: number;
  comment?: string;
  /** Leave the loop extension out even with several frames. */
  noLoop?: boolean;
}

function lzwEncode(indices: Uint8Array, minBits: number): number[] {
  const clear = 1 << minBits, end = clear + 1;
  const out: number[] = [];
  let acc = 0, have = 0;
  const put = (code: number, bits: number) => {
    acc |= code << have;
    have += bits;
    while (have >= 8) (out.push(acc & 255), (acc >>>= 8), (have -= 8));
  };
  let bits = minBits + 1, next = end + 1;
  const table = new Map<string, number>();
  put(clear, bits);
  let cur = "";
  for (const v of indices) {
    const k = cur + String.fromCharCode(v);
    if (cur === "" || table.has(k) || k.length === 1) {
      cur = k;
      continue;
    }
    put(cur.length === 1 ? cur.charCodeAt(0) : table.get(cur)!, bits);
    if (next < 4096) {
      table.set(k, next++);
      if (next > 1 << bits && bits < 12) bits++;
    } else {
      put(clear, bits);
      table.clear();
      bits = minBits + 1;
      next = end + 1;
    }
    cur = String.fromCharCode(v);
  }
  if (cur) put(cur.length === 1 ? cur.charCodeAt(0) : table.get(cur)!, bits);
  put(end, bits);
  if (have > 0) out.push(acc & 255);
  return out;
}

const sub = (data: number[]) => {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
};

const sizeBits = (n: number) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
const table = (p: number[][]) => {
  const bits = sizeBits(p.length);
  return { bits, bytes: [...p, ...Array.from({ length: (1 << bits) - p.length }, () => [0, 0, 0])].flat() };
};

export function makeGif(s: GifSpec): Uint8Array {
  const g = table(s.palette);
  const out: number[] = [...new TextEncoder().encode("GIF89a"), s.width & 255, s.width >> 8, s.height & 255, s.height >> 8, 0x80 | 0x70 | (g.bits - 1), 0, 0, ...g.bytes];
  if (s.loop !== undefined && !s.noLoop) out.push(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, s.loop & 255, s.loop >> 8, 0);
  if (s.comment) out.push(0x21, 0xfe, ...sub([...new TextEncoder().encode(s.comment)]));
  for (const f of s.frames) {
    const w = f.width ?? s.width, h = f.height ?? s.height;
    if (f.delay !== undefined || f.disposal !== undefined || f.transparent !== undefined)
      out.push(0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (f.transparent !== undefined ? 1 : 0), (f.delay ?? 0) & 255, (f.delay ?? 0) >> 8, f.transparent ?? 0, 0);
    const lt = f.localPalette ? table(f.localPalette) : null;
    out.push(0x2c, (f.left ?? 0) & 255, (f.left ?? 0) >> 8, (f.top ?? 0) & 255, (f.top ?? 0) >> 8, w & 255, w >> 8, h & 255, h >> 8, (lt ? 0x80 | (lt.bits - 1) : 0) | (f.interlace ? 0x40 : 0));
    if (lt) out.push(...lt.bytes);
    let px = f.pixels;
    if (f.interlace) {
      const order: number[] = [];
      for (const [st, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = st; y < h; y += step) order.push(y);
      px = new Uint8Array(w * h);
      order.forEach((y, i) => px.set(f.pixels.subarray(y * w, (y + 1) * w), i * w));
    }
    const minBits = Math.max(2, (lt ?? g).bits);
    out.push(minBits, ...sub(lzwEncode(px, minBits)));
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

/** A palette of n colours spread around. */
export const palette = (n: number) => Array.from({ length: n }, (_, i) => [(i * 53) & 255, (i * 97 + 20) & 255, (i * 29 + 70) & 255]);

/** Pixels with some structure: stripes and noise. */
export const stripes = (w: number, h: number, colours: number, seed = 1) => {
  let r = seed * 7919;
  return Uint8Array.from({ length: w * h }, (_, i) => {
    r = (r * 1103515245 + 12345) >>> 0;
    return (Math.floor((i % w) / 6) + Math.floor(i / w / 5) + ((r >>> 16) % 3 === 0 ? 1 : 0)) % colours;
  });
};
