// Lossless APNG recompression: each frame's data is recompressed on its own (filters and deflate only, no colour changes),
// the frame layout, delays and chunks stay as they are. The caller's check proves the animation is unchanged.
import { join } from "node:path";
import type { Context, Step } from "../types";
import { chunkBytes, concat, framePng, readChunks, type RawChunk } from "./apng-decode";

const oxiLevel = (level: number) => (level >= 9 ? "max" : String([1, 1, 2, 2, 3, 4, 4, 5, 6][level - 1] ?? 3));
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const TEXT = new Set(["tEXt", "zTXt", "iTXt", "tIME"]);

async function recompress(ctx: Context, chunks: RawChunk[], w: number, h: number, z: Uint8Array, n: number): Promise<Uint8Array> {
  const a = join(ctx.dir, `apng-${n}-in.png`), b = join(ctx.dir, `apng-${n}-out.png`);
  await Bun.write(a, framePng(chunks, w, h, z));
  await ctx.run("oxipng", ["-q", "--force", "--nx", "-o", oxiLevel(ctx.level), ...(ctx.level >= 9 ? ["--zopfli"] : []), "--out", b, a]);
  const out = readChunks(new Uint8Array(await Bun.file(b).arrayBuffer()));
  const nz = concat(out.filter((c) => c.type === "IDAT").map((c) => c.data));
  return nz.length < z.length ? nz : z;
}

export const apngFrames: Step = {
  id: "png.apng-frames",
  tool: "oxipng",
  when: (ctx) => ctx.facts.animated === true || "not an animated PNG",
  async run(input, output, ctx) {
    const chunks = readChunks(new Uint8Array(await Bun.file(input).arrayBuffer()));
    const dropText = !ctx.settings.png.keepMetadata && !ctx.facts.protected;
    const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
    // each frame's data stream, in file order; the default image is IDAT, a frame is fcTL + fdAT* (IDAT right after the first fcTL is frame 0)
    type Group = { w: number; h: number; z: Uint8Array[]; first: number };
    const groups: Group[] = [];
    const owner: (Group | null)[] = [];
    const ihdr = view(chunks[0].data);
    let idat: Group | null = null, frame: Group | null = null;
    chunks.forEach((c, i) => {
      owner.push(null);
      if (c.type === "fcTL") {
        const v = view(c.data);
        frame = { w: v.getUint32(4), h: v.getUint32(8), z: [], first: -1 };
        groups.push(frame);
        if (!idat) idat = frame;
      } else if (c.type === "IDAT" || c.type === "fdAT") {
        let g: Group;
        if (c.type === "IDAT") {
          if (!idat) (idat = { w: ihdr.getUint32(0), h: ihdr.getUint32(4), z: [], first: -1 }), groups.push(idat);
          g = idat;
        } else g = frame!;
        g.z.push(c.type === "fdAT" ? c.data.subarray(4) : c.data);
        if (g.first < 0) g.first = i;
        owner[i] = g;
      }
    });
    const result = new Map<Group, Uint8Array>();
    let n = 0;
    for (const g of groups) result.set(g, await recompress(ctx, chunks, g.w, g.h, concat(g.z), n++));

    // write the file again with the new data (one chunk per frame), numbering fcTL and fdAT afresh
    const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
    let seq = 0;
    chunks.forEach((c, i) => {
      const g = owner[i];
      if (c.type === "fcTL") {
        const d = c.data.slice();
        d.set(u32(seq++), 0);
        parts.push(chunkBytes("fcTL", d));
      } else if (g) {
        if (g.first !== i) return;
        const z = result.get(g)!;
        parts.push(c.type === "IDAT" ? chunkBytes("IDAT", z) : chunkBytes("fdAT", concat([u32(seq++), z])));
      } else if (!(dropText && TEXT.has(c.type))) parts.push(chunkBytes(c.type, c.data));
    });
    await Bun.write(output, concat(parts));
  },
};
