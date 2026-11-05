import { toolStep } from "../step";
import type { Format, Settings } from "../types";
import { audioSig, sameAudio, type AudioSig } from "./audio-oracle";
import { audioRegion, frameChain, id3v2Size } from "./mp3-parse";

const hasGapless = (tags: Uint8Array[]) => tags.some((t) => Buffer.from(t).includes("iTunSMPB"));

export const mp3: Format = {
  id: "mp3",
  extensions: ["mp3"],
  detect: (h, name) => {
    if (id3v2Size(h, 0) || (h[0] === 0xff && frameChain(h, 0, 2))) return true;
    // Junk before the first frame: only by extension.
    if (!/\.mp3$/i.test(name)) return false;
    for (let p = 0; p < h.length - 4; p++) if (h[p] === 0xff && frameChain(h, p, 3)) return true;
    return false;
  },
  flags: (s: Settings) => ({ keepMetadata: s.audio.keepMetadata }),
  steps: [
    {
      id: "mp3.clean",
      async run(input, output, ctx) {
        const b = new Uint8Array(await Bun.file(input).arrayBuffer());
        const keep = ctx.settings.audio.keepMetadata;
        const r = audioRegion(b, true);
        if (keep) {
          // Tags stay; only junk between them and the first frame goes.
          await Bun.write(output, r.start > r.tagEnd ? Buffer.concat([b.subarray(0, r.tagEnd), b.subarray(r.start)]) : b);
          return;
        }
        if (hasGapless(r.tagBytes)) {
          ctx.note("mp3.clean: tag holds gapless info (iTunSMPB), kept");
          await Bun.write(output, b);
          return;
        }
        await Bun.write(output, b.subarray(r.start, r.end));
      },
    },
    toolStep({
      id: "mp3.mp3packer",
      tool: "mp3packer",
      args: (input, output) => ["-z", "-s", "-a", "", "-A", "-f", input, output],
    }),
  ],
  oracle: {
    async prepare(path, ctx): Promise<AudioSig> {
      // Decoder warnings are normal for MP3s (junk, cut last frame); only unreadable files are damaged.
      return audioSig(path, ctx);
    },
    async same(original, candidate, ctx) {
      let b: AudioSig;
      try {
        b = await audioSig(candidate, ctx);
      } catch (e: any) {
        return `the result does not decode: ${e?.message ?? e}`;
      }
      return sameAudio(original as AudioSig, b, ctx.settings.audio.keepMetadata);
    },
  },
};

export const formats: Format[] = [mp3];
