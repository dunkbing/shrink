// Microsoft Cabinet files (docs/FORMATS.md section 12, tier 3). No cabinet writer is installable from Homebrew
// (gcab and lcab are not formulae), so MSZIP and stored folders are repacked natively: every data block is recompressed
// on its own with the best zlib (and zopfli at level 3+); LZX and Quantum folders are copied untouched.
// Oracle: the cabinet's own file table (names, sizes, dates, attributes, folder layout) and the bytes `cabextract`
// extracts must be equal. Multi-cabinet sets, signed or reserve-carrying cabinets are skipped.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { SkipFile, type Context, type Format, type Step } from "../types";
import { isCab, parseCab, repackCab, type Cab } from "./cab-parse";
import { iterations } from "./gzip.format";
import { errorMessage } from "../errors";

const MAX = 1 << 30;
let seq = 0;

const load = async (path: string) => parseCab(new Uint8Array(await Bun.file(path).arrayBuffer()));

const native: Step = {
  id: "cab.mszip",
  async run(input, output) {
    const c = await load(input);
    await Bun.write(output, await repackCab(c, async (raw) => deflateRawSync(raw, { level: 9, memLevel: 9 })));
  },
};

const zopfli: Step = {
  id: "cab.zopfli",
  tool: "zopfli",
  minLevel: 3,
  async run(input, output, ctx) {
    const c = await load(input);
    const blocks = c.folders.reduce((n, f) => n + f.blocks.length, 0);
    if (blocks > 3000) throw new Error(`${blocks} blocks is too many for zopfli`);
    const dir = join(ctx.dir, `cabz${++seq}`);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "block");
    await Bun.write(output, await repackCab(c, async (raw, cur) => {
      await Bun.write(f, raw);
      await ctx.run("zopfli", ["--deflate", `--i${Math.min(iterations(ctx.level, raw.length), 30)}`, f]);
      const z = new Uint8Array(await Bun.file(f + ".deflate").arrayBuffer());
      return cur && z.length >= cur.length ? null : z;
    }));
  },
};

/** What a cabinet holds, as `cabextract` extracts it: path to SHA-256. */
async function extracted(path: string, ctx: Context): Promise<Map<string, string>> {
  const cmd = await ctx.tools?.locate("cabextract");
  if (!cmd) throw new SkipFile("cabextract is not installed, so the result cannot be verified");
  const dir = join(ctx.dir, `cabx${++seq}`);
  mkdirSync(dir, { recursive: true });
  const r = await ctx.run("cabextract", ["-q", "-d", dir, path]);
  if (r.code !== 0) throw new Error(`cabextract could not extract it: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`);
  const out = new Map<string, string>();
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true, onlyFiles: true })) {
    const h = new Bun.CryptoHasher("sha256");
    h.update(new Uint8Array(await Bun.file(join(dir, f)).arrayBuffer()));
    out.set(f, h.digest("hex"));
  }
  return out;
}

const listing = (c: Cab) => JSON.stringify([c.folders.map((f) => [f.type, f.blocks.reduce((s, k) => s + k.cbUncomp, 0)]), c.files.map((f) => [f.name, f.size, f.offset, f.folder, f.date, f.time, f.attribs])]);

interface Facts {
  list: string;
  files: Map<string, string>;
}

export const cab: Format = {
  id: "cab",
  extensions: ["cab"],
  detect: (h) => isCab(h),
  steps: [native, zopfli],
  oracle: {
    async prepare(path, ctx) {
      if (Bun.file(path).size > MAX) throw new SkipFile("larger than 1 GiB");
      const c = await load(path);
      return { list: listing(c), files: await extracted(path, ctx) } satisfies Facts;
    },
    async same(original, candidate, ctx) {
      const a = original as Facts;
      let c: Cab;
      try {
        c = await load(candidate);
      } catch (e) {
        if (e instanceof SkipFile) return `the result is not a plain cabinet: ${e.message}`;
        return `the result is not a valid cabinet: ${errorMessage(e)}`;
      }
      const l = JSON.parse(listing(c));
      const o = JSON.parse(a.list);
      // a stored folder may become MSZIP (the method changes, never the size or the files)
      if (JSON.stringify(l[1]) !== JSON.stringify(o[1])) return "file table differs";
      if (l[0].length !== o[0].length || l[0].some((f: number[], i: number) => f[1] !== o[0][i][1])) return "folder layout differs";
      let b: Map<string, string>;
      try {
        b = await extracted(candidate, ctx);
      } catch (e) {
        if (e instanceof SkipFile) throw e;
        return `cabextract cannot read the result: ${errorMessage(e)}`;
      }
      if (b.size !== a.files.size) return "extracted file list differs";
      for (const [k, v] of a.files) if (b.get(k) !== v) return `${k}: extracted bytes differ`;
      return true;
    },
  },
};

export const formats: Format[] = [cab];
