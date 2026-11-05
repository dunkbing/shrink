import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Audio fixtures: a WAV writer in TypeScript, and ffmpeg / flac for the other formats.
const u32 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const u16 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255]);
const tag = (s: string) => new TextEncoder().encode(s);
export const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

export interface WavOptions {
  rate?: number;
  channels?: number;
  bits?: 8 | 16 | 24 | 32;
  float?: boolean;
  extensible?: boolean;
  frames?: number;
  /** Chunks around the audio: before `fmt `, between `fmt ` and `data`, and after `data`. */
  before?: [string, Uint8Array][];
  between?: [string, Uint8Array][];
  after?: [string, Uint8Array][];
  /** Skip the pad byte after an odd-sized data chunk. */
  noDataPad?: boolean;
}

export const chunk = (id: string, data: Uint8Array) => concat([tag(id), u32(data.length), data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);

/** A tone plus a little noise, deterministic. */
export function pcm(o: WavOptions): Uint8Array {
  const { rate = 44100, channels = 2, bits = 16, float = false, frames = 4000 } = o;
  const bytes = bits / 8;
  const out = new Uint8Array(frames * channels * bytes);
  const dv = new DataView(out.buffer);
  let seed = 12345;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = 0.5 * Math.sin((2 * Math.PI * (440 + c * 110) * i) / rate) + ((seed >> 8) % 100) / 5000;
      const at = (i * channels + c) * bytes;
      if (float) bits === 32 ? dv.setFloat32(at, v, true) : dv.setFloat64(at, v, true);
      else if (bits === 8) dv.setUint8(at, Math.round(128 + v * 120));
      else if (bits === 16) dv.setInt16(at, Math.round(v * 30000), true);
      else if (bits === 24) {
        const x = Math.round(v * 8000000);
        out[at] = x & 255, out[at + 1] = (x >> 8) & 255, out[at + 2] = (x >> 16) & 255;
      } else dv.setInt32(at, Math.round(v * 2000000000), true);
    }
  return out;
}

export function makeWav(o: WavOptions = {}): Uint8Array {
  const { rate = 44100, channels = 2, bits = 16, float = false, extensible = false } = o;
  const align = (channels * bits) / 8;
  const base = [...u16(extensible ? 0xfffe : float ? 3 : 1), ...u16(channels), ...u32(rate), ...u32(rate * align), ...u16(align), ...u16(bits)];
  let fmt = new Uint8Array(base);
  if (extensible) {
    const guid = [float ? 3 : 1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
    fmt = concat([fmt, u16(22), u16(bits), u32(channels === 2 ? 3 : (1 << channels) - 1), new Uint8Array(guid)]);
  }
  const data = pcm(o);
  const dataChunk = concat([tag("data"), u32(data.length), data, data.length & 1 && !o.noDataPad ? new Uint8Array(1) : new Uint8Array(0)]);
  const body = concat([
    tag("WAVE"),
    ...(o.before ?? []).map(([i, d]) => chunk(i, d)),
    chunk("fmt ", fmt),
    ...(float ? [chunk("fact", u32(o.frames ?? 4000))] : []),
    ...(o.between ?? []).map(([i, d]) => chunk(i, d)),
    dataChunk,
    ...(o.after ?? []).map(([i, d]) => chunk(i, d)),
  ]);
  return concat([tag("RIFF"), u32(body.length), body]);
}

export const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A private folder for fixtures made by the tools. */
export const workDir = () => mkdtempSync(join(tmpdir(), "shrink-audio-"));

export const have = { ffmpeg: Bun.which("ffmpeg") !== null, flac: Bun.which("flac") !== null && Bun.which("metaflac") !== null, optivorbis: Bun.which("optivorbis") !== null, mp3packer: Bun.which("mp3packer") !== null };

export function run(cmd: string[], cwd?: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString().slice(0, 300)}`);
  return r.stdout.toString();
}

/** ffmpeg on a generated source: a tone with noise; `src` extra args replace the default input. */
export const SRC = (seconds = 2, rate = 44100) => ["-f", "lavfi", "-i", `aevalsrc=0.3*sin(2*PI*440*t)+0.2*sin(2*PI*1330*t)+0.05*random(0):d=${seconds}:s=${rate}`];
export const ff = (args: string[]) => run(["ffmpeg", "-v", "error", "-y", "-nostdin", ...args]);

/** A small cover picture file. */
export function cover(dir: string): string {
  const p = join(dir, "cover.png");
  ff(["-f", "lavfi", "-i", "testsrc=s=96x96:d=1", "-frames:v", "1", p]);
  return p;
}

/** Stream hash of the decoded audio, computed independently of the engine's oracle code path (plain 16/32-bit PCM md5). */
export function decodeMd5(path: string): string {
  return run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:a", "-c:a", "pcm_f64le", "-f", "md5", "-"]).trim();
}

export const probe = (path: string, entries = "format_tags"): any => JSON.parse(run(["ffprobe", "-v", "error", "-show_entries", entries, "-show_streams", "-show_format", "-of", "json", path]));
