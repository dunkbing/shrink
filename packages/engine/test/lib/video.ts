// Tiny synthetic clips made with ffmpeg at test time.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const have = (t: string) => Bun.which(t) !== null;
export const haveFfmpeg = have("ffmpeg") && have("ffprobe");

export function ffmpeg(args: string[], cwd?: string) {
  const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-nostdin", "-y", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`ffmpeg ${args.join(" ").slice(0, 200)}: ${r.stderr.toString().slice(0, 500)}`);
}

const SRC = (secs: number) => ["-f", "lavfi", "-i", `testsrc2=size=160x120:rate=15:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`];
const SRC2 = (secs: number) => ["-f", "lavfi", "-i", `sine=frequency=660:duration=${secs}`];
/** A big comment tag: pure metadata that stripping removes. */
export const bigTag = () => "note " + "metadata padding ".repeat(1500);

/** Writes a metadata file with chapters. */
export function chaptersFile(dir: string, titles = ["One", "Two"]): string {
  const p = join(dir, "chapters.txt");
  const lines = [";FFMETADATA1"];
  titles.forEach((t, i) => lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${i * 700}`, `END=${(i + 1) * 700}`, `title=${t}`));
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

export function coverJpeg(dir: string): string {
  const p = join(dir, "cover.jpg");
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=64x64:rate=1:duration=1", "-frames:v", "1", p]);
  return p;
}

/** H.264 + AAC MP4 with global tags (so the metadata strip has something to drop). */
export function makeMp4(path: string, o: { secs?: number; movflags?: string; codec?: "h264" | "hevc" | "vp9" | "mpeg4"; tags?: boolean; extra?: string[]; format?: string } = {}) {
  const codec = { h264: ["-c:v", "libx264"], hevc: ["-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=error"], vp9: ["-c:v", "libvpx-vp9", "-b:v", "100k"], mpeg4: ["-c:v", "mpeg4"] }[o.codec ?? "h264"];
  ffmpeg([...SRC(o.secs ?? 1.5), ...(o.extra ?? []), ...codec, "-c:a", "aac", ...(o.tags === false ? [] : ["-metadata", "title=Clip", "-metadata", `comment=${bigTag()}`]), "-metadata:s:a:0", "language=eng", ...(o.movflags ? ["-movflags", o.movflags] : []), ...(o.format ? ["-f", o.format] : []), path]);
}

/** MP4 with two audio tracks (languages), a subtitle track and chapters. */
export function makeMp4Multi(dir: string, path: string) {
  const ch = chaptersFile(dir);
  const srt = join(dir, "m.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhello\n");
  ffmpeg([...SRC(1.5), ...SRC2(1.5), "-i", srt, "-i", ch, "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map_chapters", "4", "-map_metadata", "4", "-c:v", "libx264", "-c:a", "aac", "-c:s", "mov_text", "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=Main", "-metadata:s:a:1", "language=fra", "-metadata:s:a:1", "title=Commentaire", "-metadata:s:s:0", "language=deu", "-metadata", `comment=${bigTag()}`, path]);
}

/** MKV with tags, two audio tracks, an SRT track, an attached font and chapters. */
export function makeMkv(dir: string, path: string, o: { webm?: boolean } = {}) {
  const ch = chaptersFile(dir);
  const srt = join(dir, "s.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhello\n");
  const font = join(dir, "f.ttf");
  writeFileSync(font, new Uint8Array(3000).map((_, i) => (i * 7) & 255));
  if (o.webm) {
    ffmpeg([...SRC(1.5), "-c:v", "libvpx-vp9", "-b:v", "100k", "-c:a", "libopus", "-metadata", "title=Web", "-metadata", `comment=${bigTag()}`, "-metadata:s:a:0", "language=eng", path]);
    return;
  }
  ffmpeg([...SRC(1.5), ...SRC2(1.5), "-i", srt, "-i", ch, "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map_chapters", "4", "-attach", font, "-metadata:s:t", "mimetype=font/ttf", "-c:v", "libx264", "-c:a", "aac", "-c:s", "srt", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fra", "-metadata:s:a:1", "title=Commentaire", "-metadata", "title=Movie", "-metadata", `comment=${bigTag()}`, path]);
}

export function makeAvi(path: string) {
  ffmpeg([...SRC(1.5), "-c:v", "mpeg4", "-c:a", "mp3", "-metadata", `comment=${bigTag()}`, path]);
}
export function makeFlv(path: string) {
  ffmpeg([...SRC(1.5), "-c:v", "flv", "-c:a", "mp3", "-ar", "44100", "-metadata", `comment=${"flv padding ".repeat(30)}`, path]);
}
export function makeMpg(path: string, fmt = "mpeg") {
  ffmpeg([...SRC(1.5), "-c:v", "mpeg2video", "-b:v", "400k", "-c:a", "mp2", "-f", fmt, path]);
}
/** Audio only, in a given container. */
export function makeAudioOnly(path: string, fmt: string) {
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", ...(fmt === "mp4" || fmt === "ipod" ? ["-c:a", "aac"] : ["-c:a", "libopus"]), "-f", fmt, path]);
}
/** Theora: only possible by remuxing a real Theora file. */
export function ogvWithTags(src: string, path: string) {
  ffmpeg(["-i", src, "-map", "0:v", "-map", "0:a?", "-c", "copy", "-metadata", "title=Tagged", "-metadata", `comment=${bigTag()}`, path]);
}

export function streamHashes(path: string): string {
  const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-map", "0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"]);
  return r.stdout.toString();
}
export function probeJson(path: string): any {
  const r = Bun.spawnSync(["ffprobe", "-v", "error", "-show_streams", "-show_chapters", "-show_format", "-of", "json", path]);
  return JSON.parse(r.stdout.toString());
}

// A private engine over the video formats only (no other family's formats are loaded).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync as wf } from "node:fs";
import { tmpdir } from "node:os";
import { Engine } from "../../src/optimize";
import type { DeepPartial, Format, Settings, Step } from "../../src/types";

export interface VEnv {
  dir: string;
  engine: Engine;
  file(name: string, content: string | Uint8Array): string;
  cleanup(): void;
}
export function venv(formats: Format[], settings: DeepPartial<Settings> = {}, tweak?: (f: Format) => Format): VEnv {
  const dir = mkdtempSync(join(tmpdir(), "shrink-video-"));
  mkdirSync(join(dir, "tmp"), { recursive: true });
  const engine = new Engine({ formats: tweak ? formats.map(tweak) : formats, settings: { workers: 4, ...settings }, cacheDir: join(dir, "cache"), tempDir: join(dir, "tmp") });
  return {
    dir,
    engine,
    file(name, content) {
      const p = join(dir, name);
      wf(p, content);
      return p;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
export type { Step };

/** MP4 with chapters, a cover picture and a title. */
export function makeMp4Cover(dir: string, path: string) {
  const ch = chaptersFile(dir);
  const cover = coverJpeg(dir);
  ffmpeg([...SRC(1.5), "-i", cover, "-i", ch, "-map", "0:v", "-map", "1:a", "-map", "2:v", "-map_chapters", "3", "-map_metadata", "3", "-c", "copy", "-c:v:0", "libx264", "-c:a", "aac", "-c:v:1", "mjpeg", "-disposition:v:1", "attached_pic", "-metadata", "title=Covered", "-metadata", `comment=${bigTag()}`, path]);
}

/** Flips one byte in the middle of the first mdat / Cluster payload: same size, different packets. */
export function flipPayloadByte(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  out[Math.floor(out.length * 0.5)] ^= 0x55;
  return out;
}
