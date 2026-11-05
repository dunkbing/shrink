import { toolStep } from "../step";
import { SkipFile, type Format, type Settings, type Step } from "../types";
import { pixels, samePicture, type Pixels } from "./bun-pixels";
import { parseWebp, type WebpInfo } from "./webp-parse";
import { errorMessage } from "../errors";
import { join } from "node:path";
import { judge, lowestQuality, MAX_LOSSY_PIXELS, rasterOf } from "./lossy";

interface Prepared {
  info: WebpInfo;
  pix: Pixels;
  path: string;
}

/** cwebp -q: the lowest quality whose result still passes the similarity check (alpha is kept at full quality). */
const recompress: Step = {
  id: "webp.recompress",
  tool: "cwebp",
  lossy: true,
  when: (ctx) => (Number(ctx.facts.pixels) > MAX_LOSSY_PIXELS ? "too large to check the similarity" : true),
  async run(input, output, ctx) {
    const ref = await rasterOf(new Uint8Array(await Bun.file(input).arrayBuffer()));
    const hit = await lowestQuality(
      20,
      95,
      async (q) => {
        const path = join(ctx.dir, `recode-${q}.webp`);
        const r = await ctx.run("cwebp", ["-quiet", "-q", String(q), "-alpha_q", "100", "-m", "6", "-mt", "-metadata", ctx.settings.webp.keepMetadata ? "all" : ctx.facts.keepExif ? "icc,exif" : "icc", "-o", path, input]);
        if (r.code !== 0) throw new Error(`cwebp exited with ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`);
        return { path, ok: judge(ref, await rasterOf(new Uint8Array(await Bun.file(path).arrayBuffer())), ctx.settings) === true };
      },
      ctx.signal,
    );
    await Bun.write(output, Bun.file(hit.path));
    ctx.note(`webp.recompress: quality ${hit.quality}`);
  },
};

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
    // Last: it changes the pixels (within the similarity floor), so only with webp.lossy.
    recompress,
  ],
  oracle: {
    async prepare(path, ctx) {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const info = parseWebp(bytes);
      if (info.animated) throw new SkipFile("animated WebP is not supported");
      let pix: Pixels;
      try {
        pix = await pixels(bytes);
      } catch (e) {
        throw new Error(`does not decode: ${errorMessage(e)}`);
      }
      ctx.facts.lossless = info.lossless;
      if (info.orientation !== 1) ctx.facts.keepExif = true;
      ctx.facts.pixels = info.width * info.height;
      return { info, pix, path } satisfies Prepared;
    },
    async same(original, candidatePath, ctx) {
      const a = original as Prepared;
      const bytes = new Uint8Array(await Bun.file(candidatePath).arrayBuffer());
      let info: WebpInfo, pix: Pixels;
      try {
        info = parseWebp(bytes);
        pix = await pixels(bytes);
      } catch (e) {
        return `the result does not decode: ${errorMessage(e)}`;
      }
      if (info.animated) return "result is animated";
      const same = samePicture(a.pix, pix);
      if (same !== true) return same;
      if (a.info.icc && (!info.icc || Buffer.compare(a.info.icc, info.icc) !== 0)) return "ICC profile changed";
      if (info.orientation !== a.info.orientation) return "orientation changed";
      if ((ctx.settings.webp.keepMetadata || ctx.facts.keepExif) && a.info.exif && !info.exif) return "EXIF was removed";
      return true;
    },
    async similar(original, candidatePath, ctx) {
      const a = original as Prepared;
      const bytes = new Uint8Array(await Bun.file(candidatePath).arrayBuffer());
      let info: WebpInfo, pic;
      try {
        info = parseWebp(bytes);
        pic = await rasterOf(bytes);
      } catch (e) {
        return `the result does not decode: ${errorMessage(e)}`;
      }
      if (info.animated) return "result is animated";
      if (a.info.icc && (!info.icc || Buffer.compare(a.info.icc, info.icc) !== 0)) return "ICC profile changed";
      if (info.orientation !== a.info.orientation) return "orientation changed";
      if ((ctx.settings.webp.keepMetadata || ctx.facts.keepExif) && a.info.exif && !info.exif) return "EXIF was removed";
      return judge(await rasterOf(new Uint8Array(await Bun.file(a.path).arrayBuffer())), pic, ctx.settings);
    },
  },
};

export const formats: Format[] = [webp];
