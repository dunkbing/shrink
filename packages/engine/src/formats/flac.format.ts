import { inPlaceStep, toolStep } from "../step";
import { MissingTool } from "../tools";
import type { Context, Format, Settings } from "../types";
import { audioSig, sameAudio, type AudioSig } from "./audio-oracle";
import { isFlac, parseFlac, type FlacInfo } from "./flac-parse";
import { errorMessage } from "../errors";

interface Prepared {
  info: FlacInfo;
  sig: AudioSig;
}

/** `flac -t`: decodes everything and checks every frame CRC and the stored MD5. A missing flac is fine. */
async function flacTest(path: string, ctx: Context): Promise<string | null> {
  try {
    const r = await ctx.run("flac", ["-t", "-s", path]);
    return r.code === 0 ? null : (r.stderr.trim().split("\n").pop() ?? "flac -t failed");
  } catch (e) {
    if (e instanceof MissingTool) return null;
    throw e;
  }
}

export const flac: Format = {
  id: "flac",
  extensions: ["flac"],
  detect: (h) => isFlac(h),
  flags: (s: Settings) => ({ keepMetadata: s.audio.keepMetadata }),
  steps: [
    toolStep({
      id: "flac.reencode",
      tool: "flac",
      args: (input, output, ctx) => ["-s", "-f", "-V", "-8", ...(ctx.level >= 5 ? ["-e"] : []), ...(ctx.level >= 7 ? ["-p"] : []), "--padding=0", "-o", output, input],
    }),
    inPlaceStep({
      id: "flac.strip",
      tool: "metaflac",
      strip: true,
      args: (file) => ["--remove", "--block-type=VORBIS_COMMENT,PICTURE,CUESHEET,APPLICATION,PADDING", "--dont-use-padding", file],
    }),
  ],
  oracle: {
    async prepare(path, ctx): Promise<Prepared> {
      const info = parseFlac(new Uint8Array(await Bun.file(path).arrayBuffer()));
      const bad = await flacTest(path, ctx);
      if (bad) throw new Error(bad);
      const sig = await audioSig(path, ctx);
      if (sig.errors) throw new Error(sig.errors.split("\n")[0]);
      return { info, sig };
    },
    async same(original, candidate, ctx) {
      const a = original as Prepared;
      let b: Prepared;
      try {
        const info = parseFlac(new Uint8Array(await Bun.file(candidate).arrayBuffer()));
        const bad = await flacTest(candidate, ctx);
        if (bad) return `the result does not verify: ${bad}`;
        b = { info, sig: await audioSig(candidate, ctx) };
      } catch (e) {
        return `the result does not decode: ${errorMessage(e)}`;
      }
      const x = a.info, y = b.info;
      if (x.sampleRate !== y.sampleRate || x.channels !== y.channels || x.bitsPerSample !== y.bitsPerSample) return "stream format changed";
      if (x.totalSamples !== y.totalSamples && x.totalSamples !== 0n) return "sample count changed";
      if (/[1-9a-f]/.test(x.md5) && x.md5 !== y.md5) return "STREAMINFO MD5 changed";
      const keep = ctx.settings.audio.keepMetadata;
      if (keep) for (const t of [4, 5, 6]) if ((y.blocks.get(t) ?? 0) < (x.blocks.get(t) ?? 0)) return `metadata block type ${t} was lost`;
      return sameAudio(a.sig, b.sig, keep);
    },
  },
};

export const formats: Format[] = [flac];
