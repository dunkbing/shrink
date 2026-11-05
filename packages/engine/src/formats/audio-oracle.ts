// Shared audio oracle: both files decode (ffmpeg) to the same samples, and the same streams and tags where tags are kept.
import { MissingTool } from "../tools";
import type { Context } from "../types";

export interface AudioSig {
  /** `streamhash` lines of the decoded samples (every audio stream, exact 64-bit float PCM). */
  hash: string;
  /** Codec, rate and channels per audio stream. */
  info: string;
  /** Non-audio streams (cover art, video, subtitles). */
  extra: number;
  chapters: number;
  tags: Map<string, string>;
  /** What ffmpeg complained about while decoding. */
  errors: string;
}

const IGNORED = new Set(["encoder", "vendor", "major_brand", "minor_version", "compatible_brands", "creation_time", "handler_name", "vendor_id"]);

export async function audioSig(path: string, ctx: Context): Promise<AudioSig> {
  const dec = await ctx.run("ffmpeg", ["-v", "error", "-nostdin", "-i", path, "-map", "0:a", "-c:a", "pcm_f64le", "-f", "streamhash", "-hash", "sha256", "-"]);
  if (dec.code !== 0) throw new Error(`cannot be decoded: ${(dec.stderr.trim().split("\n")[0] ?? "").slice(0, 200)}`);
  const hash = dec.stdout.trim();
  if (!hash) throw new Error("has no audio stream");
  const pr = await ctx.run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path]);
  if (pr.code !== 0) throw new Error("cannot be read");
  const j = JSON.parse(pr.stdout);
  const streams: any[] = j.streams ?? [];
  const audio = streams.filter((s) => s.codec_type === "audio");
  const tags = new Map<string, string>();
  const addTags = (t: any, prefix: string) => {
    for (const [k, v] of Object.entries<any>(t ?? {})) if (!IGNORED.has(k.toLowerCase())) tags.set(prefix + k.toLowerCase(), String(v));
  };
  addTags(j.format?.tags, "");
  audio.forEach((s, i) => addTags(s.tags, `a${i}:`));
  return {
    hash,
    info: audio.map((s) => `${s.codec_name}/${s.sample_rate}/${s.channels}`).join(" "),
    extra: streams.length - audio.length,
    chapters: (j.chapters ?? []).length,
    tags,
    errors: dec.stderr.trim(),
  };
}

/** Like audioSig, but a missing ffmpeg gives null. */
export async function audioSigOrNull(path: string, ctx: Context): Promise<AudioSig | null> {
  try {
    return await audioSig(path, ctx);
  } catch (e) {
    if (e instanceof MissingTool) return null;
    throw e;
  }
}

/** true, or why the candidate's content differs. */
export function sameAudio(a: AudioSig, b: AudioSig, keepMetadata: boolean): true | string {
  if (a.info !== b.info) return `audio streams differ (${a.info} vs ${b.info})`;
  if (a.hash !== b.hash) return "decoded samples differ";
  if (keepMetadata) {
    for (const [k, v] of a.tags) if (b.tags.get(k) !== v) return `tag ${k} was lost or changed`;
    if (b.extra < a.extra) return "cover art or other streams were lost";
    if (b.chapters < a.chapters) return "chapters were lost";
  }
  return true;
}
