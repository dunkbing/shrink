// .xz and .lzma files (docs/FORMATS.md section 12, tier 3): recompressed with `xz -9e -T1`. The oracle decompresses both
// with xz and compares length and SHA-256; a file xz cannot decode is damaged.
import { join } from "node:path";
import { SkipFile, type Context, type Format, type Step } from "../types";
import { needXz, xzCheck, xzDigest, xzRecompress } from "./xz-util";

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const isXz = (h: Uint8Array) => h.length >= 12 && XZ_MAGIC.every((b, i) => h[i] === b);

/** .lzma ("lzma alone") has no magic: properties byte, power-of-two-ish dictionary size, 64-bit size (or all ones). */
export function isLzmaAlone(h: Uint8Array, name: string): boolean {
  if (h.length < 13 || h[0] >= 225) return false;
  const dict = (h[1] | (h[2] << 8) | (h[3] << 16) | (h[4] << 24)) >>> 0;
  const p2 = (d: number) => d >= 4096 && (d & (d - 1)) === 0;
  const pow2 = p2(dict) || (dict % 3 === 0 && p2((dict / 3) * 2));
  const allOnes = h.subarray(5, 13).every((b) => b === 0xff);
  const small = h[10] === 0 && h[11] === 0 && h[12] === 0;
  const ext = name.toLowerCase().endsWith(".lzma");
  return (pow2 || ext) && (allOnes || small) && (ext || h[0] === 0x5d);
}

let seq = 0;
const step = (id: string, lzma: boolean): Step => ({
  id,
  tool: "xz",
  async run(input, output, ctx: Context) {
    const cmd = await needXz(ctx);
    const head = new Uint8Array(await Bun.file(input).slice(0, 16).arrayBuffer());
    await xzRecompress(cmd, Bun.file(input), join(ctx.dir, `xz${++seq}`), output, { lzma, check: lzma ? undefined : xzCheck(head), signal: ctx.signal });
  },
});

const oracle = {
  async prepare(path: string, ctx: Context) {
    const cmd = await needXz(ctx);
    return await xzDigest(cmd, Bun.file(path), ctx.signal); // throws when truncated or corrupt
  },
  async same(original: unknown, candidate: string, ctx: Context): Promise<true | string> {
    const a = original as { sha: string; size: number };
    let b;
    try {
      b = await xzDigest(await needXz(ctx), Bun.file(candidate), ctx.signal);
    } catch (e: any) {
      if (e instanceof SkipFile) throw e;
      return `xz cannot decode the result: ${e?.message ?? e}`;
    }
    return a.size === b.size && a.sha === b.sha ? true : "decompressed bytes differ";
  },
};

export const xz: Format = { id: "xz", extensions: ["xz", "txz"], detect: (h) => isXz(h), steps: [step("xz.recompress", false)], oracle };
export const lzma: Format = { id: "lzma", extensions: ["lzma", "tlz"], detect: (h, n) => isLzmaAlone(h, n), steps: [step("lzma.recompress", true)], oracle };

export const formats: Format[] = [xz, lzma];
