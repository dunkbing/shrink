// Strict RIFF/WAVE reader and chunk rewriter.
import { SkipFile } from "../types";

export interface WavChunk {
  id: string;
  /** Offset of the chunk's data. */
  off: number;
  size: number;
}

export interface Wav {
  chunks: WavChunk[];
  fmt: WavChunk;
  data: WavChunk;
}

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export function isWav(head: Uint8Array): boolean {
  const t = tag(head, 0);
  return (t === "RIFF" && tag(head, 8) === "WAVE") || ((t === "RF64" || t === "BW64") && tag(head, 8) === "WAVE");
}

/** Throws for a damaged file, SkipFile for RF64 and streaming WAVs. */
export function parseWav(b: Uint8Array): Wav {
  if (b.length < 12 || !isWav(b)) throw new Error("not a RIFF/WAVE file");
  if (tag(b, 0) !== "RIFF") throw new SkipFile("RF64/BW64 is not supported");
  const riff = u32(b, 4);
  if (riff === 0 || riff === 0xffffffff) throw new SkipFile("streaming WAV (unknown length) is not supported");
  const end = Math.min(b.length, 8 + riff);
  const chunks: WavChunk[] = [];
  let pos = 12;
  while (pos + 8 <= end) {
    const id = tag(b, pos), size = u32(b, pos + 4);
    if (id === "data" && size === 0xffffffff) throw new SkipFile("streaming WAV (unknown length) is not supported");
    if (pos + 8 + size > b.length) throw new Error(`chunk ${JSON.stringify(id)} is truncated`);
    chunks.push({ id, off: pos + 8, size });
    pos += 8 + size + (size & 1);
  }
  const fmts = chunks.filter((c) => c.id === "fmt "), datas = chunks.filter((c) => c.id === "data");
  if (fmts.length !== 1) throw new Error(fmts.length ? "more than one fmt chunk" : "no fmt chunk");
  if (datas.length > 1) throw new SkipFile("more than one data chunk");
  if (!datas.length) throw new Error("no data chunk");
  if (fmts[0].size < 16) throw new Error("fmt chunk is too short");
  return { chunks, fmt: fmts[0], data: datas[0] };
}

const FILLER = new Set(["JUNK", "junk", "PAD ", "pad ", "FLLR", "fllr", "Junk", "PAD", "SMED"]);

/** The same WAV with only the audio chunks (fmt, fact, data), or with everything but filler when metadata is kept. */
export function rewriteWav(b: Uint8Array, w: Wav, keepMetadata: boolean): Uint8Array {
  const keep = w.chunks.filter((c) => (keepMetadata ? !FILLER.has(c.id) : c.id === "fmt " || c.id === "fact" || c.id === "data"));
  const total = 12 + keep.reduce((n, c) => n + 8 + c.size + (c.size & 1), 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(b.subarray(0, 4), 0);
  dv.setUint32(4, total - 8, true);
  out.set(b.subarray(8, 12), 8);
  let p = 12;
  for (const c of keep) {
    out.set(b.subarray(c.off - 8, c.off + c.size), p);
    p += 8 + c.size;
    if (c.size & 1) out[p++] = 0;
  }
  return out;
}
