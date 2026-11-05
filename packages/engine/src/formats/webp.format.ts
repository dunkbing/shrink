import { toolStep } from "../step";
import { SkipFile, type Format, type Settings } from "../types";
import { pixels, samePicture, type Pixels } from "./bun-pixels";
import { parseWebp, type WebpInfo } from "./webp-parse";

interface Prepared {
  info: WebpInfo;
  pix: Pixels;
}

export const webp: Format = {
  id: "webp",
  extensions: ["webp"],
  detect: (h) => String.fromCharCode(...h.subarray(0, 4)) === "RIFF" && String.fromCharCode(...h.subarray(8, 12)) === "WEBP",
  flags: (s: Settings) => ({ lossy: s.webp.lossy, keepMetadata: s.webp.keepMetadata }),
  steps: [
    // Lossless WebP only: re-encoding a lossy one losslessly would grow it and could never be the same file.
    toolStep({
      id: "webp.cwebp",
      tool: "cwebp",
      when: (ctx) => (ctx.facts.lossless ? true : "lossy WebP is left alone"),
      args: (input, output, ctx) => ["-quiet", "-lossless", "-z", String(Math.min(9, ctx.level)), "-mt", "-metadata", ctx.settings.webp.keepMetadata ? "all" : ctx.facts.keepExif ? "icc,exif" : "icc", "-o", output, input],
    }),
  ],
  oracle: {
    async prepare(path, ctx) {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const info = parseWebp(bytes);
      if (info.animated) throw new SkipFile("animated WebP is not supported");
      let pix: Pixels;
      try {
        pix = await pixels(bytes);
      } catch (e: any) {
        throw new Error(`does not decode: ${e?.message ?? e}`);
      }
      ctx.facts.lossless = info.lossless;
      if (info.orientation !== 1) ctx.facts.keepExif = true;
      return { info, pix } satisfies Prepared;
    },
    async same(original, candidatePath, ctx) {
      const a = original as Prepared;
      const bytes = new Uint8Array(await Bun.file(candidatePath).arrayBuffer());
      let info: WebpInfo, pix: Pixels;
      try {
        info = parseWebp(bytes);
        pix = await pixels(bytes);
      } catch (e: any) {
        return `the result does not decode: ${e?.message ?? e}`;
      }
      if (info.animated) return "result is animated";
      const same = samePicture(a.pix, pix);
      if (same !== true) return same;
      if (a.info.icc && (!info.icc || Buffer.compare(a.info.icc, info.icc) !== 0)) return "ICC profile changed";
      if (info.orientation !== a.info.orientation) return "orientation changed";
      if ((ctx.settings.webp.keepMetadata || ctx.facts.keepExif) && a.info.exif && !info.exif) return "EXIF was removed";
      return true;
    },
  },
};

export const formats: Format[] = [webp];
