import { toolStep } from "../step";
import type { Format, Settings } from "../types";
import { audioSig, sameAudio, type AudioSig } from "./audio-oracle";

const starts = (b: Uint8Array, s: string) => s.split("").every((c, i) => b[i] === c.charCodeAt(0));

/** Codec names of the logical streams, from the first (BOS) page of each. */
export function oggCodecs(head: Uint8Array): string[] {
  const out: string[] = [];
  let p = 0;
  while (p + 27 <= head.length && starts(head.subarray(p), "OggS")) {
    const segs = head[p + 26];
    if (p + 27 + segs > head.length) break;
    let size = 0;
    for (let i = 0; i < segs; i++) size += head[p + 27 + i];
    const body = p + 27 + segs;
    if (!(head[p + 5] & 2)) break; // BOS pages come first
    const d = head.subarray(body, body + Math.min(size, 16));
    out.push(
      starts(d, "\x01vorbis") ? "vorbis"
        : starts(d, "OpusHead") ? "opus"
        : starts(d, "Speex   ") ? "speex"
        : starts(d, "\x7fFLAC") ? "flac"
        : starts(d, "\x80theora") ? "theora"
        : starts(d, "\x01video\0\0\0") || starts(d, "OVP80") || starts(d, "BBCD") ? "video"
        : starts(d, "fishead") || starts(d, "fisbone") ? "skeleton"
        : "unknown",
    );
    p = body + size;
  }
  return out;
}

export const ogg: Format = {
  id: "ogg",
  extensions: ["ogg", "oga", "opus", "spx"],
  // Theora and other video in Ogg belong to the video family.
  detect: (h) => starts(h, "OggS") && !oggCodecs(h).some((x) => x === "theora" || x === "video"),
  flags: (s: Settings) => ({ keepMetadata: s.audio.keepMetadata }),
  async skip(_path, head) {
    const c = oggCodecs(head).filter((x) => x !== "skeleton");
    if (c.some((x) => x === "theora" || x === "video")) return "video stream";
    if (c.length === 0) return "no recognisable stream";
    const other = c.find((x) => x !== "vorbis");
    if (other) return other === "opus" ? "Opus is not supported (no lossless gain)" : other === "speex" ? "Speex is not supported (no lossless gain)" : other === "flac" ? "FLAC in Ogg is not supported" : "unsupported Ogg stream";
    return null;
  },
  steps: [
    toolStep({
      id: "ogg.optivorbis",
      tool: "optivorbis",
      args: (input, output, ctx) => [
        "-q",
        "-r", "ogg2ogg",
        "--remuxer_option", "randomize_stream_serials=false",
        "--comment_fields_action", ctx.settings.audio.keepMetadata ? "copy" : "delete",
        input,
        output,
      ],
    }),
  ],
  oracle: {
    async prepare(path, ctx): Promise<AudioSig> {
      const sig = await audioSig(path, ctx);
      if (sig.errors) throw new Error(sig.errors.split("\n")[0]);
      return sig;
    },
    async same(original, candidate, ctx) {
      let b: AudioSig;
      try {
        b = await audioSig(candidate, ctx);
      } catch (e: any) {
        return `the result does not decode: ${e?.message ?? e}`;
      }
      if (b.errors) return `the result decodes with errors: ${b.errors.split("\n")[0]}`;
      return sameAudio(original as AudioSig, b, ctx.settings.audio.keepMetadata);
    },
  },
};

export const formats: Format[] = [ogg];
