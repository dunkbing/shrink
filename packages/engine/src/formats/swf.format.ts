import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { Format, Step } from "../types";
import { SkipFile } from "../types";
import { sha } from "./zip-parse";

interface Swf {
  sig: string;
  version: number;
  length: number;
  body: Uint8Array;
}

export function parseSwf(b: Uint8Array): Swf {
  if (b.length < 12) throw new Error("too small for SWF");
  const sig = String.fromCharCode(b[0], b[1], b[2]);
  if (!["FWS", "CWS", "ZWS"].includes(sig) || b[3] === 0) throw new Error("not a SWF");
  if (b.length > 2 ** 30) throw new SkipFile("larger than 1 GiB");
  const length = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
  if (sig === "ZWS") throw new SkipFile("LZMA-compressed SWF");
  let body: Uint8Array = b.subarray(8);
  if (sig === "CWS") {
    try {
      body = inflateSync(body, { maxOutputLength: Math.min(Math.max(length - 8, 1), 2 ** 30) + 1 });
    } catch (e: any) {
      throw new Error(`cannot inflate: ${e?.message ?? e}`);
    }
  }
  if (body.length + 8 !== length) throw new Error("length field does not match the body");
  return { sig, version: b[3], length, body };
}

function pack(s: Swf, zlib: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from([0x43, 0x57, 0x53, s.version, s.length & 255, (s.length >>> 8) & 255, (s.length >>> 16) & 255, (s.length >>> 24) & 255]), zlib]);
}

const native: Step = {
  id: "swf.deflate",
  async run(input, output) {
    const s = parseSwf(new Uint8Array(await Bun.file(input).arrayBuffer()));
    if (s.version < 6) throw new Error("SWF before version 6 cannot be compressed");
    await Bun.write(output, pack(s, deflateSync(s.body, { level: 9, memLevel: 9 })));
  },
};

let seq = 0;
const zopfli: Step = {
  id: "swf.zopfli",
  tool: "zopfli",
  minLevel: 3,
  async run(input, output, ctx) {
    const s = parseSwf(new Uint8Array(await Bun.file(input).arrayBuffer()));
    if (s.version < 6) throw new Error("SWF before version 6 cannot be compressed");
    const dir = join(ctx.dir, `swf${++seq}`);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "body");
    await Bun.write(f, s.body);
    await ctx.run("zopfli", ["--zlib", `--i${ctx.level >= 8 ? 60 : ctx.level >= 6 ? 25 : 10}`, f]);
    await Bun.write(output, pack(s, new Uint8Array(await Bun.file(f + ".zlib").arrayBuffer())));
  },
};

export const swf: Format = {
  id: "swf",
  extensions: ["swf"],
  detect: (h) => (h[0] === 0x46 || h[0] === 0x43 || h[0] === 0x5a) && h[1] === 0x57 && h[2] === 0x53 && h[3] > 0 && h[3] < 60,
  steps: [native, zopfli],
  oracle: {
    async prepare(path) {
      const s = parseSwf(new Uint8Array(await Bun.file(path).arrayBuffer()));
      return { ...s, sha: sha(s.body) };
    },
    async same(original, candidate) {
      const a = original as Swf & { sha: string };
      let b: Swf;
      try {
        b = parseSwf(new Uint8Array(await Bun.file(candidate).arrayBuffer()));
      } catch (e: any) {
        return `the result is not a valid SWF: ${e?.message ?? e}`;
      }
      if (b.version !== a.version) return "version changed";
      if (b.length !== a.length || sha(b.body) !== a.sha) return "tag stream differs";
      return true;
    },
  },
};

export const formats: Format[] = [swf];
