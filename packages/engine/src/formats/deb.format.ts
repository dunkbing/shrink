// Debian packages and plain `ar` archives (docs/FORMATS.md section 12, tier 3): the gzip and xz members (control.tar.*,
// data.tar.*) are recompressed and the archive is rebuilt with the other headers untouched. Oracle: same member names and
// headers, same decompressed bytes in every member. Static libraries (ar of objects) belong to the executable format.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { SkipFile, type Context, type Format, type Step } from "../types";
import { buildAr, isArBytes, looksLikeDeb, looksLikeLibrary, packedKind, parseArMembers, type ArMem } from "./deb-ar";
import { iterations } from "./gzip.format";
import { parseGzip, wrapGzip } from "./gzip-parse";
import { sha } from "./zip-parse";
import { needXz, xzCheck, xzDigest, xzRecompress } from "./xz-util";
import { errorMessage } from "../errors";

const MAX = 1 << 30;
let seq = 0;

type Redo = (m: ArMem, dir: string, ctx: Context) => Promise<Uint8Array | null>;

function rebuildStep(id: string, redo: Redo, extra: Partial<Step> = {}): Step {
  return {
    id,
    ...extra,
    async run(input, output, ctx) {
      const b = new Uint8Array(await Bun.file(input).arrayBuffer());
      const members = parseArMembers(b);
      const dir = join(ctx.dir, `ar${++seq}`);
      mkdirSync(dir, { recursive: true });
      const out: { header: Uint8Array; data: Uint8Array }[] = [];
      let n = 0;
      for (const m of members) {
        let data: Uint8Array = m.data;
        if (packedKind(m)) {
          const mdir = join(dir, String(n++));
          mkdirSync(mdir);
          const better = await redo(m, mdir, ctx).catch((e) => (e instanceof SkipFile ? null : Promise.reject(e)));
          if (better && better.length < m.data.length) data = better;
        }
        out.push({ header: m.header, data });
      }
      await Bun.write(output, buildAr(out));
    },
  };
}

const keep = (ctx: Context) => ctx.settings.archive.keepMetadata;

/** Gzip members: best zlib; xz members: `xz -9e`. */
const native = rebuildStep("deb.recompress", async (m, dir, ctx) => {
  if (packedKind(m) === "gz") {
    const gz = parseGzip(m.data);
    return wrapGzip(deflateRawSync(gz.data, { level: 9, memLevel: 9 }), gz.data, keep(ctx) ? gz.header : undefined);
  }
  const cmd = await needXz(ctx);
  const out = join(dir, "out.xz");
  await xzRecompress(cmd, m.data, join(dir, "raw"), out, { check: xzCheck(m.data), signal: ctx.signal });
  return new Uint8Array(await Bun.file(out).arrayBuffer());
});

const zopfli = rebuildStep(
  "deb.zopfli",
  async (m, dir, ctx) => {
    if (packedKind(m) !== "gz") return null;
    const gz = parseGzip(m.data);
    const f = join(dir, "data");
    await Bun.write(f, gz.data);
    await ctx.run("zopfli", ["--deflate", `--i${iterations(ctx.level, gz.data.length)}`, f]);
    return wrapGzip(new Uint8Array(await Bun.file(f + ".deflate").arrayBuffer()), gz.data, keep(ctx) ? gz.header : undefined);
  },
  { tool: "zopfli", minLevel: 3 },
);

interface Facts {
  members: { header: Uint8Array; name: string; data: Uint8Array; sha: string | null }[];
}

/** Decompressed digest of a gzip/xz member. */
async function inner(m: ArMem, ctx: Context): Promise<string> {
  if (packedKind(m) === "gz") return sha(parseGzip(m.data).data);
  const r = await xzDigest(await needXz(ctx), m.data, ctx.signal);
  return `${r.size}:${r.sha}`;
}

const oracle = {
  async prepare(path: string, ctx: Context) {
    const f = Bun.file(path);
    if (f.size > MAX) throw new SkipFile("larger than 1 GiB");
    const members = parseArMembers(new Uint8Array(await f.arrayBuffer()));
    if (!members.length) throw new Error("no members");
    const out = [];
    for (const m of members) {
      // the compressed members must decode now, so a damaged package is never rebuilt
      out.push({ ...m, sha: packedKind(m) ? await inner(m, ctx) : null });
    }
    return { members: out } satisfies Facts;
  },
  async same(original: unknown, candidate: string, ctx: Context): Promise<true | string> {
    const a = (original as Facts).members;
    let b: ArMem[];
    try {
      b = parseArMembers(new Uint8Array(await Bun.file(candidate).arrayBuffer()));
    } catch (e) {
      return `the result is not a valid ar archive: ${errorMessage(e)}`;
    }
    if (a.length !== b.length) return "member count differs";
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.name !== y.name) return `member ${i} is named differently`;
      if (Buffer.compare(x.header.subarray(0, 48), y.header.subarray(0, 48)) !== 0 || Buffer.compare(x.header.subarray(58), y.header.subarray(58)) !== 0) return `${x.name}: header fields were changed`;
      if (x.data.length === y.data.length && Buffer.compare(x.data, y.data) === 0) continue;
      if (x.sha === null || packedKind(x) !== packedKind(y)) return `${x.name}: content differs`;
      let got: string;
      try {
        got = await inner(y, ctx);
      } catch (e) {
        if (e instanceof SkipFile) throw e;
        return `${x.name}: the recompressed member does not decode: ${errorMessage(e)}`;
      }
      if (got !== x.sha) return `${x.name}: decompressed bytes differ`;
    }
    return true;
  },
};

export const deb: Format = {
  id: "deb",
  extensions: ["deb", "udeb"],
  detect: (h) => looksLikeDeb(h),
  steps: [native, zopfli],
  oracle,
};

export const ar: Format = {
  id: "ar",
  extensions: ["ar", "a", "lib"],
  detect: (h) => isArBytes(h) && !looksLikeDeb(h) && !looksLikeLibrary(h),
  steps: [native, zopfli],
  oracle,
};

export const formats: Format[] = [deb, ar];
