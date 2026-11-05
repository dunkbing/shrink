// Rare raster formats (TGA, PCX, SGI, Sun raster, PNM, Radiance HDR, XBM, XPM): ImageMagick writes the picture again in the
// same format, and the result is kept only if every frame has the same pixel signature as the original.
import { toolStep } from "../step";
import type { Context, Format, Step } from "../types";
import { frameSignatures, originalSignatures, sameSignatures } from "./magick-sig";
import { errorMessage } from "../errors";

const text = (h: Uint8Array, n: number) => String.fromCharCode(...h.subarray(0, n));
const ws = (c: number) => c === 10 || c === 13 || c === 32 || c === 9;

function misc(o: { id: string; prefix: string; extensions: string[]; detect(h: Uint8Array, name: string): boolean; variants?: [string, string[]][] }): Format {
  const steps: Step[] = (o.variants ?? [["", []]]).map(([name, args]) =>
    toolStep({
      id: `${o.id}.magick${name ? "-" + name : ""}`,
      tool: "magick",
      // the format prefix, not the file name, tells ImageMagick what to read and write
      args: (input, output) => [`${o.prefix}:${input}`, "-strip", ...args, `${o.prefix}:${output}`],
    }),
  );
  return {
    id: o.id,
    extensions: o.extensions,
    detect: o.detect,
    steps,
    oracle: {
      prepare: (path, ctx: Context) => originalSignatures(ctx, o.prefix, path),
      async same(original, candidate, ctx) {
        let sigs: string[];
        try {
          sigs = await frameSignatures(ctx, o.prefix, candidate);
        } catch (e) {
          return `the result does not decode: ${errorMessage(e)}`;
        }
        return sameSignatures(original as string[], sigs);
      },
    },
  };
}

const ext = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
const rle: [string, string[]][] = [["rle", ["-compress", "RLE"]], ["raw", ["-compress", "None"]]];

export const tga = misc({
  id: "tga",
  prefix: "tga",
  extensions: ["tga", "vda", "icb", "vst"],
  // no signature: a plausible header and a TGA name
  detect: (h, name) => {
    if (h.length < 18 || !["tga", "vda", "icb", "vst"].includes(ext(name))) return false;
    const w = h[12] | (h[13] << 8), ht = h[14] | (h[15] << 8);
    return (h[1] === 0 || h[1] === 1) && [1, 2, 3, 9, 10, 11].includes(h[2]) && w > 0 && ht > 0 && [8, 15, 16, 24, 32].includes(h[16]);
  },
  variants: rle,
});

export const pcx = misc({
  id: "pcx",
  prefix: "pcx",
  extensions: ["pcx"],
  detect: (h) => h.length >= 128 && h[0] === 0x0a && [0, 2, 3, 4, 5].includes(h[1]) && h[2] === 1 && [1, 2, 4, 8].includes(h[3]),
});

export const sgi = misc({
  id: "sgi",
  prefix: "sgi",
  extensions: ["sgi", "rgb", "rgba", "bw"],
  detect: (h) => h.length >= 512 && h[0] === 0x01 && h[1] === 0xda && (h[2] === 0 || h[2] === 1) && (h[3] === 1 || h[3] === 2),
  variants: rle,
});

export const sun = misc({
  id: "sun",
  prefix: "sun",
  extensions: ["ras", "sun"],
  detect: (h) => h.length >= 32 && h[0] === 0x59 && h[1] === 0xa6 && h[2] === 0x6a && h[3] === 0x95,
  variants: rle,
});

export const hdr = misc({
  id: "hdr",
  prefix: "hdr",
  extensions: ["hdr", "pic"],
  detect: (h) => text(h, 10) === "#?RADIANCE" || text(h, 6) === "#?RGBE",
});

export const xbm = misc({
  id: "xbm",
  prefix: "xbm",
  extensions: ["xbm"],
  detect: (h) => text(h, 8) === "#define " && /_width\s+\d/.test(text(h, Math.min(h.length, 512))),
});

export const xpm = misc({
  id: "xpm",
  prefix: "xpm",
  extensions: ["xpm"],
  detect: (h) => text(h, 9) === "/* XPM */",
});

const pnm = (id: string, raw: number, plain: number) =>
  misc({
    id,
    prefix: id,
    extensions: [id, "pnm"],
    detect: (h) => h.length >= 3 && h[0] === 0x50 && (h[1] === 0x30 + raw || h[1] === 0x30 + plain) && ws(h[2]),
  });
export const pbm = pnm("pbm", 4, 1);
export const pgm = pnm("pgm", 5, 2);
export const ppm = pnm("ppm", 6, 3);

export const formats: Format[] = [tga, pcx, sgi, sun, hdr, xbm, xpm, pbm, pgm, ppm];
