// Trimming digital silence from the ends of a FLAC (audio.trimSilence): finding it, and comparing what is left.
import { closeSync, openSync, readSync, rmSync, fstatSync } from "node:fs";
import { join } from "node:path";
import type { Context, Step } from "../types";
import { parseFlac } from "./flac-parse";

const BLOCK = 1 << 20;

export interface Ends {
  /** Frames (one sample per channel) in the file. */
  frames: number;
  /** Leading and trailing frames that are silent. */
  head: number;
  tail: number;
  /** SHA-256 of the samples between the silent ends. */
  middle: string;
}

/** Decodes to raw little-endian signed PCM in the job folder; returns its path. */
async function decodeRaw(path: string, ctx: Context, name: string): Promise<string> {
  const out = join(ctx.dir, name);
  const r = await ctx.run("flac", ["-d", "-s", "-f", "--force-raw-format", "--endian=little", "--sign=signed", "-o", out, path]);
  if (r.code !== 0) throw new Error(`flac cannot decode it: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`);
  return out;
}

/** Finds the silent ends of raw PCM (a frame is silent when every sample is within one step of the stored precision) and hashes the middle. */
function scan(raw: string, channels: number, bits: number, signal: AbortSignal): Ends {
  const width = Math.ceil(bits / 8), frameBytes = width * channels;
  const limit = 1 << (width * 8 - bits);
  const fd = openSync(raw, "r");
  try {
    const frames = Math.floor(fstatSync(fd).size / frameBytes);
    const buf = new Uint8Array(Math.floor(BLOCK / frameBytes) * frameBytes || frameBytes);
    const loud = (at: number) => {
      for (let c = 0; c < channels; c++) {
        const o = at + c * width;
        let v = buf[o];
        for (let k = 1; k < width; k++) v |= buf[o + k] << (8 * k);
        v = (v << (32 - 8 * width)) >> (32 - 8 * width);
        if (Math.abs(v) > limit) return true;
      }
      return false;
    };
    const perBlock = buf.length / frameBytes;
    let head = frames;
    for (let f = 0; f < frames && head === frames; f += perBlock) {
      if (signal.aborted) throw new Error("cancelled");
      const n = Math.min(perBlock, frames - f);
      readSync(fd, buf, 0, n * frameBytes, f * frameBytes);
      for (let i = 0; i < n; i++) if (loud(i * frameBytes)) {
        head = f + i;
        break;
      }
    }
    if (head === frames) return { frames, head: frames, tail: 0, middle: "" };
    let tail = 0;
    scanTail: for (let end = frames; end > head; end -= perBlock) {
      if (signal.aborted) throw new Error("cancelled");
      const start = Math.max(head, end - perBlock), n = end - start;
      readSync(fd, buf, 0, n * frameBytes, start * frameBytes);
      for (let i = n - 1; i >= 0; i--) {
        if (loud(i * frameBytes)) break scanTail;
        tail++;
      }
    }
    const h = new Bun.CryptoHasher("sha256");
    for (let f = head; f < frames - tail; f += perBlock) {
      if (signal.aborted) throw new Error("cancelled");
      const n = Math.min(perBlock, frames - tail - f);
      readSync(fd, buf, 0, n * frameBytes, f * frameBytes);
      h.update(buf.subarray(0, n * frameBytes));
    }
    return { frames, head, tail, middle: h.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

/** The silent ends of a FLAC file and a hash of the samples between them. */
export async function silentEnds(path: string, ctx: Context, name: string): Promise<Ends> {
  const info = parseFlac(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const raw = await decodeRaw(path, ctx, name);
  try {
    return scan(raw, info.channels, info.bitsPerSample, ctx.signal);
  } finally {
    rmSync(raw, { force: true });
  }
}

/** audio.trimSilence: cuts digital silence from the start and end (flac --skip / --until, tags and pictures carried over). */
export const flacTrim: Step = {
  id: "flac.trim",
  tool: "flac",
  lossy: true,
  minSaving: 0,
  async run(input, output, ctx) {
    const e = await silentEnds(input, ctx, "trim.raw");
    if (e.head + e.tail === 0 || e.head >= e.frames) {
      await Bun.write(output, Bun.file(input));
      ctx.note(e.head >= e.frames ? "flac.trim: the whole file is silent, nothing cut" : "flac.trim: no silence at the ends");
      return;
    }
    const r = await ctx.run("flac", ["-s", "-f", "-V", "-8", ...(ctx.level >= 5 ? ["-e"] : []), "--padding=0", `--skip=${e.head}`, `--until=${e.frames - e.tail}`, "-o", output, input]);
    if (r.code !== 0) throw new Error(`flac exited with ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`);
    ctx.note(`flac.trim: cut ${e.head} frames at the start and ${e.tail} at the end`);
  },
};
