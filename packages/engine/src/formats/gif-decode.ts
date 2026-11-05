// A strict GIF reader for verification: every frame composited onto the canvas, with its delay, plus the loop count.
export interface GifFrame {
  /** The canvas after this frame is drawn (RGBA, width * height * 4). */
  rgba: Uint8Array;
  /** Centiseconds. */
  delay: number;
}

export interface GifInfo {
  width: number;
  height: number;
  frames: GifFrame[];
  /** NETSCAPE loop count (0 = forever), or null when the file has no loop extension. */
  loop: number | null;
  comments: number;
  /** Extension blocks other than graphic control, comment and NETSCAPE loop. */
  otherExtensions: number;
}

function fail(m: string): never {
  throw new Error(m);
}

function lzw(data: Uint8Array, minBits: number, pixels: number): Uint8Array {
  const clear = 1 << minBits, end = clear + 1;
  const out = new Uint8Array(pixels);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  let bits = minBits + 1, next = end + 1, prev = -1, first = 0;
  let acc = 0, have = 0, at = 0, o = 0;
  for (let i = 0; i < clear; i++) suffix[i] = i;
  while (o < pixels) {
    while (have < bits) {
      if (at >= data.length) return fail("image data too short");
      acc |= data[at++] << have;
      have += 8;
    }
    const code = acc & ((1 << bits) - 1);
    acc >>>= bits;
    have -= bits;
    if (code === clear) {
      bits = minBits + 1;
      next = end + 1;
      prev = -1;
      continue;
    }
    if (code === end) break;
    let sp = 0, c = code;
    if (prev === -1) {
      if (code >= clear) fail("bad LZW code");
      out[o++] = suffix[code];
      prev = code;
      first = code;
      continue;
    }
    if (c >= next) {
      if (c > next) fail("bad LZW code");
      stack[sp++] = first;
      c = prev;
    }
    while (c >= clear) {
      stack[sp++] = suffix[c];
      c = prefix[c];
    }
    first = suffix[c];
    stack[sp++] = first;
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      if (next === 1 << bits && bits < 12) bits++;
    }
    prev = code;
    while (sp > 0 && o < pixels) out[o++] = stack[--sp];
  }
  if (o < pixels) fail("image data too short");
  return out;
}

export function decodeGif(b: Uint8Array): GifInfo {
  const sig = String.fromCharCode(...b.subarray(0, 6));
  if (sig !== "GIF87a" && sig !== "GIF89a") fail("not a GIF");
  if (b.length < 13) fail("truncated");
  const width = b[6] | (b[7] << 8), height = b[8] | (b[9] << 8);
  if (!width || !height || width * height > 1 << 28) fail("bad size");
  const flags = b[10];
  let at = 13;
  let globalTable: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 3 * (2 << (flags & 7));
    if (at + n > b.length) fail("truncated");
    globalTable = b.subarray(at, at + n);
    at += n;
  }
  const info: GifInfo = { width, height, frames: [], loop: null, comments: 0, otherExtensions: 0 };
  let canvas = new Uint8Array(width * height * 4);
  let gce: { delay: number; transparent: number; disposal: number } | null = null;
  let done = false;
  const skipBlocks = () => {
    while (true) {
      if (at >= b.length) fail("truncated");
      const n = b[at++];
      if (n === 0) return;
      at += n;
    }
  };
  while (at < b.length && !done) {
    const t = b[at++];
    if (t === 0x3b) {
      done = true;
    } else if (t === 0x21) {
      const label = b[at++];
      if (label === 0xf9) {
        if (b[at] !== 4) fail("bad graphic control extension");
        const f = b[at + 1];
        gce = { disposal: (f >> 2) & 7, transparent: f & 1 ? b[at + 4] : -1, delay: b[at + 2] | (b[at + 3] << 8) };
        at += 6;
      } else if (label === 0xfe) {
        info.comments++;
        skipBlocks();
      } else if (label === 0xff) {
        const n = b[at++];
        const id = String.fromCharCode(...b.subarray(at, at + n));
        at += n;
        if (id === "NETSCAPE2.0" && b[at] === 3 && b[at + 1] === 1) {
          info.loop = b[at + 2] | (b[at + 3] << 8);
        } else info.otherExtensions++;
        skipBlocks();
      } else {
        info.otherExtensions++;
        skipBlocks();
      }
    } else if (t === 0x2c) {
      if (at + 9 > b.length) fail("truncated");
      const left = b[at] | (b[at + 1] << 8), top = b[at + 2] | (b[at + 3] << 8), w = b[at + 4] | (b[at + 5] << 8), h = b[at + 6] | (b[at + 7] << 8), lf = b[at + 8];
      at += 9;
      let table = globalTable;
      if (lf & 0x80) {
        const n = 3 * (2 << (lf & 7));
        if (at + n > b.length) fail("truncated");
        table = b.subarray(at, at + n);
        at += n;
      }
      if (!table) fail("no colour table");
      if (left + w > width || top + h > height) fail("frame outside the canvas");
      const minBits = b[at++];
      if (minBits < 1 || minBits > 8) fail("bad LZW size");
      const parts: Uint8Array[] = [];
      while (true) {
        if (at >= b.length) fail("truncated");
        const n = b[at++];
        if (n === 0) break;
        if (at + n > b.length) fail("truncated");
        parts.push(b.subarray(at, at + n));
        at += n;
      }
      const idx = lzw(Buffer.concat(parts), minBits, w * h);
      const rows = Array.from({ length: h }, (_, i) => i);
      if (lf & 0x40) {
        const order: number[] = [];
        for (const [s, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = s; y < h; y += st) order.push(y);
        for (let i = 0; i < h; i++) rows[order[i]] = i; // stored row i is picture row order[i]
      }
      const before = gce?.disposal === 3 ? canvas.slice() : null;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const ci = idx[rows[y] * w + x];
          if (ci === gce?.transparent) continue;
          if (ci * 3 + 2 >= table.length) fail("colour index out of range");
          const o = ((top + y) * width + left + x) * 4;
          canvas[o] = table[ci * 3];
          canvas[o + 1] = table[ci * 3 + 1];
          canvas[o + 2] = table[ci * 3 + 2];
          canvas[o + 3] = 255;
        }
      }
      info.frames.push({ rgba: canvas.slice(), delay: gce?.delay ?? 0 });
      if (gce?.disposal === 2) for (let y = 0; y < h; y++) canvas.fill(0, ((top + y) * width + left) * 4, ((top + y) * width + left + w) * 4);
      else if (before) canvas = before;
      gce = null;
    } else fail("bad block");
  }
  if (!done) fail("truncated (no trailer)");
  if (!info.frames.length) fail("no frames");
  return info;
}

/** Same frames, delays and loop count? Fully transparent pixels count as equal. */
export function sameGif(a: GifInfo, b: GifInfo): true | string {
  if (a.width !== b.width || a.height !== b.height) return "canvas size changed";
  if (a.frames.length !== b.frames.length) return `${a.frames.length} frames became ${b.frames.length}`;
  if (a.loop !== b.loop && !(a.frames.length === 1 && (a.loop === null || b.loop === null))) return "loop count changed";
  for (let f = 0; f < a.frames.length; f++) {
    if (a.frames[f].delay !== b.frames[f].delay) return `frame ${f} delay changed`;
    const x = a.frames[f].rgba, y = b.frames[f].rgba;
    for (let i = 0; i < x.length; i += 4) {
      if (x[i + 3] === 0 && y[i + 3] === 0) continue;
      if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2] || x[i + 3] !== y[i + 3]) return `frame ${f} differs at pixel ${i / 4}`;
    }
  }
  return true;
}
