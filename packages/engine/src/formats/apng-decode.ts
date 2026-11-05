// Animated PNG: a strict reader that works out what a player shows (every displayed frame after blend and dispose),
// the delays, the loop count and the default image, so two files can be compared by what they display.
import { SkipFile } from "../types";
import { decodePng } from "./png-decode";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

export interface RawChunk {
  type: string;
  data: Uint8Array;
}

export function readChunks(bytes: Uint8Array): RawChunk[] {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: RawChunk[] = [];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error("truncated");
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (Bun.hash.crc32(bytes.subarray(at + 4, at + 8 + len)) !== view.getUint32(at + 8 + len)) throw new Error(`bad CRC in ${type}`);
    out.push({ type, data: bytes.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === "IEND") return out;
  }
  throw new Error("truncated");
}

export function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type));
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length));
  out.set(body, 4);
  out.set(u32(Bun.hash.crc32(body)), 8 + data.length);
  return out;
}

export const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

export interface Frame {
  seq: number;
  width: number;
  height: number;
  x: number;
  y: number;
  delayNum: number;
  delayDen: number;
  dispose: number;
  blend: number;
  /** Compressed image data (zlib stream) of the frame. */
  z: Uint8Array;
}

export interface ApngInfo {
  width: number;
  height: number;
  numPlays: number;
  /** The default image (IDAT) is not part of the animation. */
  hidden: boolean;
  frames: Frame[];
  /** What each frame shows: SHA-256 of the canvas after it is drawn (fully transparent pixels count as equal). */
  shown: string[];
  /** The default image as stand-alone PNG viewers show it. */
  defaultHash: string;
  chunks: RawChunk[];
}

/** A stand-alone PNG for one frame: the file's header with the frame's size and palette, and the frame's data. */
export function framePng(chunks: RawChunk[], w: number, h: number, z: Uint8Array): Uint8Array {
  const ihdr = chunks.find((c) => c.type === "IHDR")!.data.slice();
  ihdr.set(u32(w), 0);
  ihdr.set(u32(h), 4);
  const keep = chunks.filter((c) => c.type === "PLTE" || c.type === "tRNS");
  return concat([new Uint8Array(SIGNATURE), chunkBytes("IHDR", ihdr), ...keep.map((c) => chunkBytes(c.type, c.data)), chunkBytes("IDAT", z), chunkBytes("IEND", new Uint8Array())]);
}

const norm = (px: Uint16Array) => {
  const c = px.slice();
  for (let i = 0; i < c.length; i += 4) if (c[i + 3] === 0) c[i] = c[i + 1] = c[i + 2] = 0;
  return new Bun.CryptoHasher("sha256").update(c).digest("hex");
};

export function decodeApng(bytes: Uint8Array): ApngInfo {
  const chunks = readChunks(bytes);
  const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
  const ihdr = chunks[0];
  if (ihdr.type !== "IHDR" || ihdr.data.length !== 13) throw new Error("no header");
  const width = view(ihdr.data).getUint32(0), height = view(ihdr.data).getUint32(4);
  const actl = chunks.find((c) => c.type === "acTL");
  if (!actl || actl.data.length !== 8) throw new Error("no animation control");
  const numFrames = view(actl.data).getUint32(0), numPlays = view(actl.data).getUint32(4);
  if (numFrames === 0 || numFrames > 1 << 16) throw new Error("bad frame count");

  const frames: Frame[] = [];
  const data: Uint8Array[][] = [];
  let seq = 0, hidden = true, sawIdat = false, cur = -1;
  for (const c of chunks) {
    if (c.type === "fcTL") {
      if (c.data.length !== 26) throw new Error("bad fcTL");
      const v = view(c.data);
      if (v.getUint32(0) !== seq++) throw new Error("frame sequence out of order");
      frames.push({ seq: seq - 1, width: v.getUint32(4), height: v.getUint32(8), x: v.getUint32(12), y: v.getUint32(16), delayNum: v.getUint16(20), delayDen: v.getUint16(22), dispose: c.data[24], blend: c.data[25], z: new Uint8Array() });
      data.push([]);
      cur = frames.length - 1;
      if (!sawIdat) hidden = false;
    } else if (c.type === "IDAT") {
      sawIdat = true;
      if (!hidden) data[0].push(c.data); // IDAT right after the first fcTL is that frame's data
    } else if (c.type === "fdAT") {
      if (cur < 0) throw new Error("fdAT before fcTL");
      if (c.data.length < 4) throw new Error("bad fdAT");
      if (view(c.data).getUint32(0) !== seq++) throw new Error("frame sequence out of order");
      data[cur].push(c.data.subarray(4));
    }
  }
  if (frames.length !== numFrames) throw new Error("frame count does not match");
  frames.forEach((f, i) => {
    f.z = concat(data[i]);
    if (!f.z.length) throw new Error("frame without data");
    if (!f.width || !f.height || f.x + f.width > width || f.y + f.height > height) throw new Error("frame outside the picture");
    if (f.dispose > 2 || f.blend > 1) throw new Error("bad dispose or blend operation");
  });
  if (!hidden && (frames[0].width !== width || frames[0].height !== height || frames[0].x || frames[0].y)) throw new Error("first frame does not cover the picture");
  if (width * height * frames.length > 1 << 29) throw new SkipFile("too large to verify");

  const dflt = decodePng(bytes);
  const defaultHash = norm(dflt.pixels);
  const canvas = new Uint16Array(width * height * 4);
  const shown: string[] = [];
  let prev: { f: Frame; saved: Uint16Array | null } | null = null;
  for (const f of frames) {
    if (prev) {
      if (prev.f.dispose === 1 || (prev.f.dispose === 2 && !prev.saved)) clear(canvas, width, prev.f);
      else if (prev.f.dispose === 2) canvas.set(prev.saved!);
    }
    const saved = f.dispose === 2 && shown.length > 0 ? canvas.slice() : null;
    const px = decodePng(framePng(chunks, f.width, f.height, f.z)).pixels;
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const s = (y * f.width + x) * 4, d = ((f.y + y) * width + f.x + x) * 4;
        if (f.blend === 0) {
          for (let k = 0; k < 4; k++) canvas[d + k] = px[s + k];
        } else {
          const sa = px[s + 3], da = canvas[d + 3];
          if (sa === 65535 || da === 0) {
            if (sa === 0) continue;
            for (let k = 0; k < 4; k++) canvas[d + k] = px[s + k];
          } else if (sa !== 0) {
            const oa = sa + (da * (65535 - sa)) / 65535;
            for (let k = 0; k < 3; k++) canvas[d + k] = Math.round((px[s + k] * sa + (canvas[d + k] * da * (65535 - sa)) / 65535) / oa);
            canvas[d + 3] = Math.round(oa);
          }
        }
      }
    shown.push(norm(canvas));
    prev = { f, saved };
  }
  return { width, height, numPlays, hidden, frames, shown, defaultHash, chunks };
}

function clear(canvas: Uint16Array, width: number, f: Frame) {
  for (let y = 0; y < f.height; y++) canvas.fill(0, ((f.y + y) * width + f.x) * 4, ((f.y + y) * width + f.x + f.width) * 4);
}

/** Two animations are the same if they show the same frames for the same time, loop the same and have the same default image. */
export function sameApng(a: ApngInfo, b: ApngInfo): true | string {
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}x${a.height} became ${b.width}x${b.height}`;
  if (a.numPlays !== b.numPlays) return "loop count changed";
  if (a.hidden !== b.hidden) return "default image handling changed";
  if (a.defaultHash !== b.defaultHash) return "default image changed";
  if (a.frames.length !== b.frames.length) return `frame count ${a.frames.length} became ${b.frames.length}`;
  for (let i = 0; i < a.frames.length; i++) {
    const x = a.frames[i], y = b.frames[i];
    const dx = x.delayDen || 100, dy = y.delayDen || 100;
    if (x.delayNum * dy !== y.delayNum * dx) return `frame ${i}: delay changed`;
    if (a.shown[i] !== b.shown[i]) return `frame ${i}: picture changed`;
  }
  return true;
}
