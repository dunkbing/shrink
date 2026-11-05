import { errorMessage } from "../errors";
import { join } from "node:path";
import { judge, lowestQuality, MAX_LOSSY_PIXELS, rasterOfPng } from "./lossy";
import { toolStep } from "../step";
import { type Format, type Settings, type Step } from "../types";
import { apngFrames } from "./apng-opt";
import { decodeApng, sameApng, type ApngInfo } from "./apng-decode";
import { decodePng, decodePngAuto, samePixels, type PngInfo } from "./png-decode";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** oxipng's -o by level. */
const oxiLevel = (level: number) => (level >= 9 ? "max" : String([1, 1, 2, 2, 3, 4, 4, 5, 6][level - 1] ?? 3));

/** Colour information that changes how the picture looks: kept as it is. */
function isProtected(info: PngInfo): boolean {
  return info.colour.has("iCCP") || info.colour.has("cICP") || ((info.colour.has("gAMA") || info.colour.has("cHRM")) && !info.colour.has("sRGB")) || info.orientation !== 1;
}

interface Prepared {
  info: PngInfo;
  apng?: ApngInfo;
}

/** pngquant: the fewest colours whose result still passes the similarity check (its `--quality` max picks the palette size). */
const pngquant: Step = {
  id: "png.pngquant",
  tool: "pngquant",
  lossy: true,
  when: (ctx) => (ctx.facts.animated ? "animated PNG" : ctx.facts.protected ? "the colour profile would change" : Number(ctx.facts.pixels) > MAX_LOSSY_PIXELS ? "too large to check the similarity" : true),
  async run(input, output, ctx) {
    const ref = rasterOfPng(decodePng(new Uint8Array(await Bun.file(input).arrayBuffer())));
    const hit = await lowestQuality(
      30,
      100,
      async (q) => {
        const path = join(ctx.dir, `quant-${q}.png`);
        const r = await ctx.run("pngquant", ["--force", "--speed", ctx.level >= 7 ? "1" : "3", ...(ctx.settings.png.keepMetadata ? [] : ["--strip"]), `--quality=0-${q}`, "--output", path, "--", input]);
        if (r.code !== 0) throw new Error(`pngquant exited with ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`);
        return { path, ok: judge(ref, rasterOfPng(decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()))), ctx.settings) === true };
      },
      ctx.signal,
    );
    await Bun.write(output, Bun.file(hit.path));
    ctx.note(`png.pngquant: quality ${hit.quality}`);
  },
};

export const png: Format = {
  id: "png",
  extensions: ["png"],
  detect: (head) => SIGNATURE.every((b, i) => head[i] === b),
  flags: (s: Settings) => ({ lossy: s.png.lossy, keepMetadata: s.png.keepMetadata }),
  steps: [
    toolStep({
      id: "png.oxipng",
      tool: "oxipng",
      when: (ctx) => !ctx.facts.animated,
      args: (input, output, ctx) => ["-q", "--force", "-o", oxiLevel(ctx.level), ...(ctx.level >= 9 ? ["--zopfli"] : []), "--strip", ctx.settings.png.keepMetadata || ctx.facts.protected ? "none" : "safe", "--out", output, input],
    }),
    apngFrames,
    // Last: it changes the pixels (within the similarity floor), so only with png.lossy.
    pngquant,
  ],
  oracle: {
    async prepare(path, ctx) {
      const info = await decodePngAuto(new Uint8Array(await Bun.file(path).arrayBuffer()), ctx.signal);
      if (isProtected(info)) ctx.facts.protected = true;
      ctx.facts.pixels = info.width * info.height;
      if (info.animated) {
        ctx.facts.animated = true;
        return { info, apng: decodeApng(new Uint8Array(await Bun.file(path).arrayBuffer())) } satisfies Prepared;
      }
      return { info } satisfies Prepared;
    },
    async same(original, candidatePath, ctx) {
      const { info: a, apng } = original as Prepared;
      let b: PngInfo;
      try {
        b = await decodePngAuto(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()), ctx.signal);
      } catch (e) {
        return `the result does not decode: ${errorMessage(e)}`;
      }
      const same = apng ? samePixels({ ...a, animated: false }, { ...b, animated: false }) : samePixels(a, b);
      if (same !== true) return same;
      if (apng) {
        if (!b.animated) return "the animation was lost";
        let c: ApngInfo;
        try {
          c = decodeApng(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()));
        } catch (e) {
          return `the animation does not decode: ${errorMessage(e)}`;
        }
        const s = sameApng(apng, c);
        if (s !== true) return s;
      }
      if (ctx.settings.png.keepMetadata || ctx.facts.protected) {
        for (const t of ["iCCP", "cICP", "gAMA", "cHRM", "sRGB", "sBIT"]) {
          const x = a.colour.get(t), y = b.colour.get(t);
          if ((x === undefined) !== (y === undefined) || (x && y && Buffer.compare(x, y) !== 0)) return `${t} changed`;
        }
        if (a.orientation !== b.orientation) return "orientation changed";
      }
      return true;
    },
    async similar(original, candidatePath, ctx) {
      const { info: a } = original as Prepared;
      let b: PngInfo;
      try {
        b = decodePng(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()));
      } catch (e) {
        return `the result does not decode: ${errorMessage(e)}`;
      }
      if (b.animated) return "result is animated";
      if (a.orientation !== b.orientation) return "orientation changed";
      if (ctx.facts.protected || ctx.settings.png.keepMetadata) {
        for (const t of ["iCCP", "cICP", "gAMA", "cHRM", "sRGB", "sBIT"]) {
          const x = a.colour.get(t), y = b.colour.get(t);
          if ((x === undefined) !== (y === undefined) || (x && y && Buffer.compare(x, y) !== 0)) return `${t} changed`;
        }
      }
      try {
        return judge(rasterOfPng(a), rasterOfPng(b), ctx.settings);
      } catch (e) {
        return errorMessage(e);
      }
    },
  },
};

export const formats: Format[] = [png];
