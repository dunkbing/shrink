import { inPlaceStep, toolStep } from "../step";
import type { Format, Settings } from "../types";
import { pixels, samePicture, type Pixels } from "./bun-pixels";
import { parseJpeg, type JpegInfo } from "./jpeg-parse";

interface Prepared {
  info: JpegInfo;
  pix: Pixels;
}

const keeps = (ctx: { settings: Settings }) => ctx.settings.jpeg.keepMetadata;
/** EXIF holds the orientation: it stays when the picture is rotated through it. */
const keepsExif = (ctx: { settings: Settings; facts: Record<string, unknown> }) => keeps(ctx) || ctx.facts.keepExif === true;
const arith = (ctx: { settings: Settings }) => (ctx.settings.jpeg.arithmetic ? ["-arithmetic"] : []);

export const jpeg: Format = {
  id: "jpeg",
  extensions: ["jpg", "jpeg", "jpe", "jfif", "jfi", "jif"],
  detect: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  flags: (s: Settings) => ({ lossy: s.jpeg.lossy, keepMetadata: s.jpeg.keepMetadata }),
  steps: [
    // Drops comments, EXIF, IPTC and XMP but keeps the ICC profile (jpegtran's -copy none would drop that too).
    inPlaceStep({
      id: "jpeg.jpegoptim",
      tool: "jpegoptim",
      args: (file, ctx) => ["-q", "--all-progressive", ...(keeps(ctx) ? ["--strip-none"] : ["--strip-com", "--strip-iptc", "--strip-xmp", ...(keepsExif(ctx) ? [] : ["--strip-exif"])]), file],
    }),
    toolStep({ id: "jpeg.jpegtran", tool: "jpegtran", args: (i, o, ctx) => ["-optimize", "-progressive", "-copy", "all", ...arith(ctx), "-outfile", o, i] }),
    toolStep({ id: "jpeg.mozjpegtran", tool: "mozjpegtran", args: (i, o, ctx) => ["-optimize", "-progressive", "-copy", "all", ...arith(ctx), "-outfile", o, i] }),
  ],
  async skip(path, head, ctx) {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    let info: JpegInfo;
    try {
      info = parseJpeg(bytes);
    } catch {
      return null; // the oracle reports it as damaged
    }
    if (info.multiPicture) return "multi-picture or gain-map JPEG (the tools would drop the extra images)";
    if (info.sof !== 0xc0 && info.sof !== 0xc1 && info.sof !== 0xc2) return `unsupported JPEG kind (SOF${info.sof - 0xc0})`;
    if (info.precision !== 8) return `${info.precision}-bit JPEG is not supported`;
    if (info.components === 4) return "CMYK JPEG cannot be verified yet";
    if (info.trailing > 0) return "data after the end of the image";
    return null;
  },
  oracle: {
    async prepare(path, ctx) {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const info = parseJpeg(bytes);
      let pix: Pixels;
      try {
        pix = await pixels(bytes);
      } catch (e: any) {
        throw new Error(`does not decode: ${e?.message ?? e}`);
      }
      // The ICC profile is never touched by the tools used here; a rotation lives in EXIF, which then stays.
      if (info.orientation !== 1) ctx.facts.keepExif = true;
      return { info, pix } satisfies Prepared;
    },
    async same(original, candidatePath, ctx) {
      const a = original as Prepared;
      const bytes = new Uint8Array(await Bun.file(candidatePath).arrayBuffer());
      let info: JpegInfo, pix: Pixels;
      try {
        info = parseJpeg(bytes);
        pix = await pixels(bytes);
      } catch (e: any) {
        return `the result does not decode: ${e?.message ?? e}`;
      }
      const same = samePicture(a.pix, pix);
      if (same !== true) return same;
      if (info.components !== a.info.components) return "colour components changed";
      if (a.info.icc && (!info.icc || Buffer.compare(a.info.icc, info.icc) !== 0)) return "ICC profile changed";
      if (info.orientation !== a.info.orientation) return "orientation changed";
      if (keepsExif(ctx) && a.info.exif && !info.exif) return "EXIF was removed";
      return true;
    },
  },
};

export const formats: Format[] = [jpeg];
