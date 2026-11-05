import type { Context, Format, Settings } from "../types";
import { audioSig, sameAudio, type AudioSig } from "./audio-oracle";

const EBML = [0x1a, 0x45, 0xdf, 0xa3];

/** Audio-only Matroska/WebM (.mka, .weba): remuxed with ffmpeg, packets copied. */
export const mka: Format = {
  id: "mka",
  extensions: ["mka", "weba"],
  detect: (h, name) => EBML.every((c, i) => h[i] === c) && /\.(mka|weba)$/i.test(name),
  flags: (s: Settings) => ({ keepMetadata: s.audio.keepMetadata }),
  async skip(path, _head, ctx) {
    const r = await ctx.run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:stream_disposition=attached_pic", "-of", "csv=p=0", path]).catch(() => null);
    if (r && r.stdout.split("\n").some((l) => l.startsWith("video") && !l.trim().endsWith(",1"))) return "video stream";
    return null;
  },
  steps: [
    {
      id: "mka.remux",
      tool: "ffmpeg",
      async run(input, output, ctx: Context) {
        const keep = ctx.settings.audio.keepMetadata;
        const webm = /\.weba$/i.test(ctx.original);
        const r = await ctx.run("ffmpeg", [
          "-v", "error", "-nostdin", "-y", "-i", input,
          ...(keep ? ["-map", "0", "-map_metadata", "0", "-map_chapters", "0"] : ["-map", "0:a", "-map_metadata", "-1", "-map_chapters", "-1"]),
          "-c", "copy", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", webm ? "webm" : "matroska", output,
        ]);
        if (r.code !== 0) throw new Error(`ffmpeg exited with ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
      },
    },
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

export const formats: Format[] = [mka];
