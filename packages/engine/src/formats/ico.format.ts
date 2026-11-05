import { join } from "node:path";
import { SkipFile, type Context, type Format, type Settings, type Step } from "../types";
import { decodeDib, sameBitmap, type Bitmap } from "./bmp-decode";
import { decodePng, samePixels, type PngInfo } from "./png-decode";
import { errorMessage } from "../errors";

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

interface Entry {
  /** The 16-byte directory entry as it is, except size and offset. */
  head: Uint8Array;
  data: Uint8Array;
  png: boolean;
}
interface Ico {
  type: number;
  entries: Entry[];
  /** Decoded pictures, one per entry. */
  images: (PngInfo | Bitmap)[];
}

function parse(bytes: Uint8Array): Ico {
  if (bytes.length < 22) throw new Error("truncated");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = v.getUint16(2, true), count = v.getUint16(4, true);
  if (v.getUint16(0, true) !== 0 || (type !== 1 && type !== 2) || count === 0) throw new Error("not an icon");
  if (6 + count * 16 > bytes.length) throw new Error("truncated directory");
  const entries: Entry[] = [];
  const images: (PngInfo | Bitmap)[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const size = v.getUint32(at + 8, true), off = v.getUint32(at + 12, true);
    if (off < 6 + count * 16 || off + size > bytes.length || size < 8) throw new Error("entry outside the file");
    const data = bytes.subarray(off, off + size);
    const png = PNG.every((b, k) => data[k] === b);
    entries.push({ head: bytes.slice(at, at + 16), data, png });
    if (png) {
      const info = decodePng(data);
      if (info.animated) throw new SkipFile("animated PNG inside an icon");
      if (info.colour.has("iCCP") || info.colour.has("cICP") || ((info.colour.has("gAMA") || info.colour.has("cHRM")) && !info.colour.has("sRGB"))) throw new SkipFile("PNG with a colour profile inside an icon");
      images.push(info);
    } else {
      const bm = decodeDib(data, 0, { ico: true });
      const w = entries[i].head[0] || 256, h = entries[i].head[1] || 256;
      if (bm.width !== w || bm.height !== h) throw new Error("entry size does not match its image");
      images.push(bm);
    }
  }
  return { type, entries, images };
}

function build(type: number, entries: { head: Uint8Array; data: Uint8Array }[]): Uint8Array {
  let off = 6 + entries.length * 16;
  const out = new Uint8Array(off + entries.reduce((n, e) => n + e.data.length, 0));
  const v = new DataView(out.buffer);
  v.setUint16(2, type, true);
  v.setUint16(4, entries.length, true);
  entries.forEach((e, i) => {
    out.set(e.head, 6 + i * 16);
    v.setUint32(6 + i * 16 + 8, e.data.length, true);
    v.setUint32(6 + i * 16 + 12, off, true);
    out.set(e.data, off);
    off += e.data.length;
  });
  return out;
}

const oxiLevel = (level: number) => (level >= 9 ? "max" : String([1, 1, 2, 2, 3, 4, 4, 5, 6][level - 1] ?? 3));

const pngEntries: Step = {
  id: "ico.png-entries",
  tool: "oxipng",
  async run(input, output, ctx: Context) {
    const ico = parse(new Uint8Array(await Bun.file(input).arrayBuffer()));
    const entries: { head: Uint8Array; data: Uint8Array }[] = [];
    let n = 0;
    for (const e of ico.entries) {
      if (!e.png) {
        entries.push(e);
        continue;
      }
      const a = join(ctx.dir, `ico-${n}-in.png`), b = join(ctx.dir, `ico-${n}-out.png`);
      n++;
      await Bun.write(a, e.data);
      await ctx.run("oxipng", ["-q", "--force", "-o", oxiLevel(ctx.level), "--strip", ctx.settings.png.keepMetadata ? "none" : "safe", "--out", b, a]);
      const out = new Uint8Array(await Bun.file(b).arrayBuffer());
      entries.push({ head: e.head, data: out.length < e.data.length ? out : e.data });
    }
    await Bun.write(output, build(ico.type, entries));
  },
};

export const ico: Format = {
  id: "ico",
  extensions: ["ico", "cur"],
  detect: (h) => h.length >= 22 && h[0] === 0 && h[1] === 0 && (h[2] === 1 || h[2] === 2) && h[3] === 0 && (h[4] | (h[5] << 8)) > 0,
  flags: (s: Settings) => ({ keepMetadata: s.png.keepMetadata }),
  steps: [pngEntries],
  oracle: {
    async prepare(path) {
      return parse(new Uint8Array(await Bun.file(path).arrayBuffer()));
    },
    async same(original, candidatePath) {
      const a = original as Ico;
      let b: Ico;
      try {
        b = parse(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()));
      } catch (e) {
        return `the result does not decode: ${errorMessage(e)}`;
      }
      if (a.type !== b.type) return "type changed";
      if (a.entries.length !== b.entries.length) return "image count changed";
      for (let i = 0; i < a.entries.length; i++) {
        // width, height, colours, reserved, planes or hotspot x, bits or hotspot y
        if (Buffer.compare(a.entries[i].head.subarray(0, 8), b.entries[i].head.subarray(0, 8)) !== 0) return `entry ${i}: directory fields changed`;
        if (a.entries[i].png !== b.entries[i].png) return `entry ${i}: image kind changed`;
        const same = a.entries[i].png ? samePixels(a.images[i] as PngInfo, b.images[i] as PngInfo) : sameBitmap(a.images[i] as Bitmap, b.images[i] as Bitmap);
        if (same !== true) return `entry ${i}: ${same}`;
      }
      return true;
    },
  },
};

export const formats: Format[] = [ico];
