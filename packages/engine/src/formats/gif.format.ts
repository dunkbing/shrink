import { toolStep } from "../step";
import { SkipFile, type Format, type Settings } from "../types";
import { decodeGif, sameGif, type GifInfo } from "./gif-decode";

export const gif: Format = {
  id: "gif",
  extensions: ["gif"],
  detect: (h) => {
    const s = String.fromCharCode(...h.subarray(0, 6));
    return s === "GIF87a" || s === "GIF89a";
  },
  flags: (s: Settings) => ({ lossy: s.gif.lossy, keepMetadata: s.gif.keepMetadata }),
  steps: [
    toolStep({
      id: "gif.gifsicle",
      tool: "gifsicle",
      args: (input, output, ctx) => ["-O" + (ctx.level >= 7 ? "3" : ctx.level >= 4 ? "2" : "1"), ...(ctx.settings.gif.keepMetadata ? [] : ["--no-comments", "--no-names"]), "-o", output, input],
    }),
  ],
  oracle: {
    async prepare(path) {
      const info = decodeGif(new Uint8Array(await Bun.file(path).arrayBuffer()));
      if (info.width * info.height * info.frames.length > 1 << 29) throw new SkipFile("too large to verify");
      return info;
    },
    async same(original, candidatePath, ctx) {
      let b: GifInfo;
      try {
        b = decodeGif(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()));
      } catch (e: any) {
        return `the result does not decode: ${e?.message ?? e}`;
      }
      const a = original as GifInfo;
      const same = sameGif(a, b);
      if (same !== true) return same;
      if (ctx.settings.gif.keepMetadata && a.comments > b.comments) return "comments were removed";
      return true;
    },
  },
};

export const formats: Format[] = [gif];
