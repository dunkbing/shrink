// Shared by the video container formats: the `packets` oracle (ffmpeg stream hashes of the copied packets plus
// stream facts from ffprobe) and the ffmpeg remux step.
import { statSync } from "node:fs";
import { MissingTool } from "../tools";
import { SkipFile, type Context, type Oracle, type Step } from "../types";

export interface VStream {
  index: number;
  type: string;
  codec: string;
  attachedPic: boolean;
  /** MP4 chapters are stored as a text track; ffmpeg shows it as data. */
  chapterTrack: boolean;
  /** Ogg Skeleton: an index/metadata stream ffmpeg cannot copy. */
  skeleton: boolean;
  language: string;
  title: string;
  startTime: number;
  duration: number | null;
  /** Everything that describes how the stream plays, except times. */
  props: string;
  /** Attachments: file name and size. */
  attachment: string;
}

export interface VideoInfo {
  size: number;
  streams: VStream[];
  /** Packet hash per stream index (attachments have none). */
  hashes: Map<number, string>;
  chapters: string[];
  duration: number | null;
  format: string;
}

const num = (v: unknown): number | null => (v === undefined || v === null || v === "N/A" || Number.isNaN(Number(v)) ? null : Number(v));
const PROP_KEYS = ["profile", "width", "height", "coded_width", "coded_height", "pix_fmt", "sample_aspect_ratio", "display_aspect_ratio", "field_order", "color_range", "color_space", "color_transfer", "color_primaries", "chroma_location", "sample_rate", "channels", "channel_layout", "sample_fmt", "bits_per_raw_sample", "bits_per_sample", "r_frame_rate", "avg_frame_rate", "extradata_size", "level"];

export async function probe(path: string, ctx: Context): Promise<{ streams: VStream[]; chapters: string[]; duration: number | null; format: string }> {
  const r = await ctx.run("ffprobe", ["-v", "error", "-show_streams", "-show_chapters", "-show_format", "-of", "json", path]);
  if (r.code !== 0 || r.stderr.trim()) throw new Error(`ffprobe: ${(r.stderr || "failed").trim().split("\n")[0]}`);
  const j = JSON.parse(r.stdout);
  const streams: VStream[] = (j.streams ?? []).map((s: any) => {
    const tags = Object.fromEntries(Object.entries(s.tags ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const disp = Object.entries(s.disposition ?? {}).filter(([, v]) => v).map(([k]) => k).sort().join(",");
    const props = JSON.stringify([PROP_KEYS.map((k) => (k === "extradata_size" && (s.codec_type === "subtitle" || j.format?.format_name === "ogg") ? null : (s[k] ?? null))), disp, s.side_data_list ?? null]);
    return {
      index: s.index,
      type: s.codec_type,
      codec: s.codec_name ?? "?",
      attachedPic: s.disposition?.attached_pic === 1,
      skeleton: s.codec_type === "data" && (s.codec_name ?? "unknown") === "unknown",
      chapterTrack: s.codec_type === "data" && s.codec_name === "bin_data" && s.codec_tag_string === "text",
      language: tags.language ?? "",
      title: tags.title ?? "",
      startTime: num(s.start_time) ?? 0,
      duration: num(s.duration),
      props,
      attachment: s.codec_type === "attachment" ? `${tags.filename ?? ""}:${s.extradata_size ?? 0}` : "",
    };
  });
  const chapters = (j.chapters ?? []).map((c: any) => `${c.start_time}-${c.end_time}`);
  return { streams, chapters, duration: num(j.format?.duration), format: String(j.format?.format_name ?? "") };
}

/** Hash of the packets of every stream: `ffmpeg -map 0 -c copy -f streamhash`. Any demux error fails. */
export async function packetHashes(path: string, ctx: Context): Promise<Map<number, string>> {
  const r = await ctx.run("ffmpeg", ["-v", "error", "-nostdin", "-i", path, "-map", "0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"]);
  if (r.code !== 0 || r.stderr.trim()) throw new Error(`demux error: ${(r.stderr || `ffmpeg exited with ${r.code}`).trim().split("\n")[0]}`);
  const m = new Map<number, string>();
  for (const line of r.stdout.split("\n")) {
    const g = /^(\d+),\w,SHA256=([0-9a-f]+)$/.exec(line.trim());
    if (g) m.set(Number(g[1]), g[2]);
  }
  return m;
}

export async function analyze(path: string, ctx: Context): Promise<VideoInfo> {
  const p = await probe(path, ctx);
  const hashes = await packetHashes(path, ctx);
  return { size: statSync(path).size, ...p, hashes };
}

/** Streams that count as content: cover art (an attached picture stream) is metadata unless it is kept. */
export const contentStreams = (info: VideoInfo, keepMetadata: boolean) => info.streams.filter((s) => !s.chapterTrack && !(s.skeleton && info.format === "ogg") && (keepMetadata || !s.attachedPic));

const close = (a: number | null, b: number | null, tol: number) => (a === null || b === null ? a === b : Math.abs(a - b) <= tol);

export interface PacketsOptions {
  /** Format-specific check that the file is whole; throws if damaged. */
  whole?(path: string, size: number, ctx: Context, original: boolean): Promise<void> | void;
  /** Chapters must survive (Matroska) or follow keepMetadata (MP4). */
  chaptersAlways?: boolean;
}

/** The `packets` oracle: identical packets for every stream, same stream list, tags, props, chapters, durations. */
export function packetsOracle(opts: PacketsOptions = {}): Oracle {
  return {
    async prepare(path, ctx) {
      const size = statSync(path).size;
      try {
        await opts.whole?.(path, size, ctx, true);
        const info = await analyze(path, ctx);
        if (!info.streams.some((s) => s.type === "video" && !s.attachedPic)) throw new SkipFile("no video stream (audio-only files belong to the audio formats)");
        for (const s of info.streams) if (!s.chapterTrack && !s.skeleton && s.type !== "attachment" && s.type !== "data" && !info.hashes.has(s.index)) throw new Error(`stream ${s.index} could not be read`);
        return info;
      } catch (e: any) {
        if (e instanceof SkipFile) throw e;
        if (e instanceof MissingTool) throw new SkipFile(`cannot verify: ${e.message}`);
        throw e;
      }
    },
    async same(original, candidate, ctx) {
      const a = original as VideoInfo;
      let b: VideoInfo;
      try {
        await opts.whole?.(candidate, statSync(candidate).size, ctx, false);
        b = await analyze(candidate, ctx);
      } catch (e: any) {
        return `the result does not read cleanly: ${e?.message ?? e}`;
      }
      if (b.size * 2 < a.size) return "the result is less than half the original (suspicious)";
      const keep = ctx.settings.video.keepMetadata;
      const sa = contentStreams(a, keep);
      const sb = contentStreams(b, keep);
      if (sa.length !== sb.length) return `stream count ${sa.length} became ${sb.length}`;
      for (let i = 0; i < sa.length; i++) {
        const x = sa[i], y = sb[i];
        const n = `stream ${i} (${x.type})`;
        if (x.type !== y.type || x.codec !== y.codec) return `${n}: codec ${x.codec} became ${y.codec}`;
        if (x.language !== y.language) return `${n}: language '${x.language}' became '${y.language}'`;
        if (x.title !== y.title) return `${n}: title changed`;
        if (x.props !== y.props) return `${n}: stream properties changed`;
        if (x.attachment !== y.attachment) return `${n}: attachment changed`;
        if (x.type !== "attachment" && a.hashes.get(x.index) !== b.hashes.get(y.index)) return `${n}: packets differ`;
        if (!close(x.startTime, y.startTime, 0.002)) return `${n}: start time ${x.startTime} became ${y.startTime}`;
        if (!close(x.duration, y.duration, 0.05)) return `${n}: duration ${x.duration} became ${y.duration}`;
      }
      if (!close(a.duration, b.duration, 0.05)) return `duration ${a.duration} became ${b.duration}`;
      if (opts.chaptersAlways || keep) {
        if (a.chapters.join("|") !== b.chapters.join("|")) return "chapters changed";
      }
      return true;
    },
  };
}

export interface RemuxOptions {
  id: string;
  /** ffmpeg muxer name for the output; may depend on the input. */
  muxer(ctx: Context): string;
  /** Extra output options (movflags and the like). */
  extra?(ctx: Context): string[];
  /** Chapters are metadata here (MP4): dropped unless kept. */
  chaptersAreMetadata?: boolean;
  /** Tags live in the streams (Ogg): drop them all but language and title. */
  stripStreamTags?: boolean;
  /** Streams to leave out when metadata is stripped (cover art). */
  dropCoverArt?: boolean;
  /** Needs these facts to be set (by skip) or runs only when it returns true. */
  when?: Step["when"];
}

/** ffmpeg `-map 0 -c copy` into a fresh container; global tags (and in MP4 chapters, cover art) go unless kept. */
export function remuxStep(o: RemuxOptions): Step {
  return {
    id: o.id,
    tool: "ffmpeg",
    when: o.when,
    async run(input, output, ctx) {
      const keep = ctx.settings.video.keepMetadata;
      const args = ["-v", "error", "-nostdin", "-y", "-i", input];
      const p = await probe(input, ctx);
      const maps: string[] = [];
      let k = 0;
      const keepTags: string[] = [];
      for (const s of p.streams) if (!s.chapterTrack && !(s.skeleton && p.format === "ogg") && (keep || !o.dropCoverArt || !s.attachedPic)) {
        maps.push("-map", `0:${s.index}`);
        if (s.language) keepTags.push(`-metadata:s:${k}`, `language=${s.language}`);
        if (s.title) keepTags.push(`-metadata:s:${k}`, `title=${s.title}`);
        k++;
      }
      args.push(...maps, "-c", "copy", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact");
      if (!keep) args.push(...(o.stripStreamTags ? ["-map_metadata", "-1", ...keepTags] : ["-map_metadata:g", "-1"]));
      if (!keep && o.chaptersAreMetadata) args.push("-map_chapters", "-1");
      args.push(...(o.extra?.(ctx) ?? []), "-f", o.muxer(ctx), output);
      const r = await ctx.run("ffmpeg", args);
      if (r.code !== 0) throw new Error(`ffmpeg exited with ${r.code}: ${r.stderr.trim().split("\n")[0]}`);
      if (r.stderr.trim()) throw new Error(`demux/mux error: ${r.stderr.trim().split("\n")[0]}`);
    },
  };
}
