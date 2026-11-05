import { toolStep } from "../step";
import { type Context, type Format, type Settings } from "../types";
import { frameSignatures, originalSignatures, sameSignatures } from "./magick-sig";
import { parseTiff, sameTags, tagNumber, type Tiff } from "./tiff-parse";
import { errorMessage } from "../errors";

interface Prepared {
  tiff: Tiff;
  sigs: string[];
}

/** libtiff predictor for the first page: 3 for floating point, 2 for whole-byte integers, else none. */
function predictor(ctx: Context): number {
  const t = ctx.facts.tiff as Tiff;
  const bits = tagNumber(t, 0, 258) ?? 1, fmt = tagNumber(t, 0, 339) ?? 1;
  if (fmt === 3) return 3;
  return bits === 8 || bits === 16 || bits === 32 ? 2 : 1;
}

const tiffcp = (id: string, spec: (ctx: Context) => string, when?: (ctx: Context) => boolean | string) =>
  toolStep({ id, tool: "tiffcp", when, args: (input, output, ctx) => ["-c", spec(ctx), input, output] });

const bilevel = (ctx: Context) => {
  const t = ctx.facts.tiff as Tiff;
  return t.ifds.every((_, i) => (tagNumber(t, i, 258) ?? 1) === 1 && (tagNumber(t, i, 277) ?? 1) === 1) || "not a black and white picture";
};

export const tiff: Format = {
  id: "tiff",
  extensions: ["tif", "tiff"],
  detect: (h) => h.length >= 8 && ((h[0] === 0x49 && h[1] === 0x49 && (h[2] === 42 || h[2] === 43) && h[3] === 0) || (h[0] === 0x4d && h[1] === 0x4d && h[2] === 0 && (h[3] === 42 || h[3] === 43))),
  flags: (s: Settings) => ({ keepMetadata: s.tiff.keepMetadata }),
  steps: [
    tiffcp("tiff.zip", (ctx) => `zip:${predictor(ctx)}:p9`),
    tiffcp("tiff.zip-nopredictor", () => "zip:p9"),
    tiffcp("tiff.lzw", (ctx) => `lzw:${predictor(ctx)}`),
    tiffcp("tiff.g4", () => "g4", bilevel),
  ],
  oracle: {
    async prepare(path, ctx) {
      const tiff = parseTiff(new Uint8Array(await Bun.file(path).arrayBuffer()));
      ctx.facts.tiff = tiff;
      return { tiff, sigs: await originalSignatures(ctx, "tiff", path) } satisfies Prepared;
    },
    async same(original, candidatePath, ctx) {
      const a = original as Prepared;
      let b: Tiff;
      try {
        b = parseTiff(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()));
      } catch (e) {
        return `the result does not parse: ${errorMessage(e)}`;
      }
      const tags = sameTags(a.tiff, b, ctx.settings.tiff.keepMetadata);
      if (tags !== true) return tags;
      let sigs: string[];
      try {
        sigs = await frameSignatures(ctx, "tiff", candidatePath);
      } catch (e) {
        return `the result does not decode: ${errorMessage(e)}`;
      }
      return sameSignatures(a.sigs, sigs);
    },
  },
};

export const formats: Format[] = [tiff];
