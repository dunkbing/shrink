import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Context, Format, Settings, Step } from "../types";
import { parseGzip, wrapGzip, type Gzip } from "./gzip-parse";
import { sha } from "./zip-parse";
import { errorMessage } from "../errors";

let seq = 0;

/** A step that recompresses the payload with `make` (writes the raw deflate stream) and rewraps it in the right header. */
function payloadStep(id: string, tool: string | undefined, make: (data: Uint8Array, dir: string, ctx: Context) => Promise<Uint8Array>, extra: Partial<Step> = {}): Step {
  return {
    id,
    tool,
    ...extra,
    async run(input, output, ctx) {
      const gz = parseGzip(new Uint8Array(await Bun.file(input).arrayBuffer()));
      const dir = join(ctx.dir, `gz${++seq}`);
      mkdirSync(dir, { recursive: true });
      const payload = await make(gz.data, dir, ctx);
      // without keepMetadata the name, time and comment go; the original header is kept only to keep them
      const header = ctx.settings.archive.keepMetadata ? gz.header : undefined;
      await Bun.write(output, wrapGzip(payload, gz.data, header));
    },
  };
}

const native = payloadStep("gzip.deflate", undefined, async (data) => deflateRawSync(data, { level: 9, memLevel: 9 }));

const libdeflate = payloadStep(
  "gzip.libdeflate",
  "libdeflate-gzip",
  async (data, dir, ctx) => {
    const f = join(dir, "data");
    await Bun.write(f, data);
    await ctx.run("libdeflate-gzip", ["-12", "-k", "-f", f]);
    return parseGzip(new Uint8Array(await Bun.file(f + ".gz").arrayBuffer())).payload;
  },
);

/** Zopfli iterations: by level, fewer for big inputs. */
export const iterations = (level: number, size: number) => Math.max(2, Math.floor((level >= 8 ? 60 : level >= 6 ? 25 : 10) / (size > 4 << 20 ? 5 : size > 1 << 20 ? 2 : 1)));

const zopfli = payloadStep(
  "gzip.zopfli",
  "zopfli",
  async (data, dir, ctx) => {
    const f = join(dir, "data");
    await Bun.write(f, data);
    await ctx.run("zopfli", ["--deflate", `--i${iterations(ctx.level, data.length)}`, f]);
    return new Uint8Array(await Bun.file(f + ".deflate").arrayBuffer());
  },
  { minLevel: 3 },
);

const same = (a: Uint8Array | null, b: Uint8Array | null) => (a === null || b === null ? a === b : Buffer.compare(a, b) === 0);

interface Facts {
  gz: Gzip;
  sha: string;
}

export const gzip: Format = {
  id: "gzip",
  extensions: ["gz", "tgz", "svgz", "gzip"],
  detect: (h, name) => h[0] === 0x1f && h[1] === 0x8b && h[2] === 8 && !/\.svgz$/i.test(name), // .svgz goes to the SVG format
  flags: (s: Settings) => ({ keepMetadata: s.archive.keepMetadata }),
  steps: [native, libdeflate, zopfli],
  oracle: {
    async prepare(path) {
      const gz = parseGzip(new Uint8Array(await Bun.file(path).arrayBuffer()));
      return { gz, sha: sha(gz.data) } satisfies Facts;
    },
    async same(original, candidate, ctx) {
      const a = original as Facts;
      let b: Gzip;
      try {
        b = parseGzip(new Uint8Array(await Bun.file(candidate).arrayBuffer()));
      } catch (e) {
        return `the result is not a valid gzip member: ${errorMessage(e)}`;
      }
      if (b.data.length !== a.gz.data.length || sha(b.data) !== a.sha) return "decompressed bytes differ";
      if (ctx.settings.archive.keepMetadata && (a.gz.mtime !== b.mtime || !same(a.gz.name, b.name) || !same(a.gz.comment, b.comment) || !same(a.gz.extra, b.extra))) return "header fields were changed";
      return true;
    },
  },
};

export const formats: Format[] = [gzip];
