import { toolStep } from "../step";
import { SkipFile, type Format, type Settings } from "../types";
import { decodePng, samePixels, type PngInfo } from "./png-decode";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** oxipng's -o by level. */
const oxiLevel = (level: number) => (level >= 9 ? "max" : String([1, 1, 2, 2, 3, 4, 4, 5, 6][level - 1] ?? 3));

/** Colour information that changes how the picture looks: kept as it is. */
function isProtected(info: PngInfo): boolean {
  return info.colour.has("iCCP") || info.colour.has("cICP") || ((info.colour.has("gAMA") || info.colour.has("cHRM")) && !info.colour.has("sRGB")) || info.orientation !== 1;
}

export const png: Format = {
  id: "png",
  extensions: ["png"],
  detect: (head) => SIGNATURE.every((b, i) => head[i] === b),
  flags: (s: Settings) => ({ lossy: s.png.lossy, keepMetadata: s.png.keepMetadata }),
  steps: [
    toolStep({
      id: "png.oxipng",
      tool: "oxipng",
      args: (input, output, ctx) => ["-q", "--force", "-o", oxiLevel(ctx.level), ...(ctx.level >= 9 ? ["--zopfli"] : []), "--strip", ctx.settings.png.keepMetadata || ctx.facts.protected ? "none" : "safe", "--out", output, input],
    }),
  ],
  oracle: {
    async prepare(path, ctx) {
      const info = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
      if (info.animated) throw new SkipFile("animated PNG is not supported yet");
      if (isProtected(info)) ctx.facts.protected = true;
      return info;
    },
    async same(original, candidatePath, ctx) {
      const a = original as PngInfo;
      let b: PngInfo;
      try {
        b = decodePng(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()));
      } catch (e: any) {
        return `the result does not decode: ${e.message}`;
      }
      const same = samePixels(a, b);
      if (same !== true) return same;
      if (ctx.settings.png.keepMetadata || ctx.facts.protected) {
        for (const t of ["iCCP", "cICP", "gAMA", "cHRM", "sRGB", "sBIT"]) {
          const x = a.colour.get(t), y = b.colour.get(t);
          if ((x === undefined) !== (y === undefined) || (x && y && Buffer.compare(x, y) !== 0)) return `${t} changed`;
        }
        if (a.orientation !== b.orientation) return "orientation changed";
      }
      return true;
    },
  },
};

export const formats: Format[] = [png];
