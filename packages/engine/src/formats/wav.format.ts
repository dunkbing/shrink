import { SkipFile, type Context, type Format, type Settings } from "../types";
import { audioSigOrNull, sameAudio, type AudioSig } from "./audio-oracle";
import { isWav, parseWav, rewriteWav, type Wav } from "./wav-parse";

interface Prepared {
  wav: Wav;
  bytes: Uint8Array;
  sig: AudioSig | null;
}

const slice = (b: Uint8Array, c: { off: number; size: number }) => b.subarray(c.off, c.off + c.size);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0;

export const wav: Format = {
  id: "wav",
  extensions: ["wav", "wave"],
  detect: (h) => isWav(h),
  flags: (s: Settings) => ({ keepMetadata: s.audio.keepMetadata }),
  steps: [
    {
      id: "wav.chunks",
      async run(input, output, ctx: Context) {
        const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
        await Bun.write(output, rewriteWav(bytes, parseWav(bytes), ctx.settings.audio.keepMetadata));
      },
    },
  ],
  oracle: {
    async prepare(path, ctx): Promise<Prepared> {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const w = parseWav(bytes);
      // ffmpeg is an extra check; a codec it does not know leaves the byte comparison alone.
      let sig: AudioSig | null = null;
      try {
        sig = await audioSigOrNull(path, ctx);
      } catch {}
      return { wav: w, bytes, sig };
    },
    async same(original, candidate, ctx) {
      const a = original as Prepared;
      const bytes = new Uint8Array(await Bun.file(candidate).arrayBuffer());
      let w: Wav;
      try {
        w = parseWav(bytes);
      } catch (e: any) {
        return e instanceof SkipFile ? e.message : `the result is not a valid WAV: ${e?.message ?? e}`;
      }
      if (!same(slice(a.bytes, a.wav.fmt), slice(bytes, w.fmt))) return "fmt chunk changed";
      if (!same(slice(a.bytes, a.wav.data), slice(bytes, w.data))) return "audio data changed";
      if (ctx.settings.audio.keepMetadata) {
        for (const c of a.wav.chunks) {
          if (c.id === "fmt " || c.id === "data" || /^(junk|pad |fllr|smed)/i.test(c.id)) continue;
          if (!w.chunks.some((d) => d.id === c.id && same(slice(a.bytes, c), slice(bytes, d)))) return `chunk ${c.id} was lost`;
        }
      }
      if (a.sig) {
        const sig = await audioSigOrNull(candidate, ctx);
        if (sig) return sameAudio(a.sig, sig, false);
      }
      return true;
    },
  },
};

export const formats: Format[] = [wav];
