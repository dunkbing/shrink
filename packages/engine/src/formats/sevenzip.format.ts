import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { crc32 } from "node:zlib";
import { basename, join } from "node:path";
import type { Context, Format, Step } from "../types";
import { SkipFile } from "../types";
import { errorMessage } from "../errors";

const NOPASS = "-pshrink-no-password";

/** Signature header check without any tool: magic, start-header CRC, next header inside the file and its CRC. */
export async function check7zHeader(path: string): Promise<void> {
  const f = Bun.file(path);
  const b = new Uint8Array(await f.slice(0, 32).arrayBuffer());
  if (b.length < 32) throw new Error("too small for 7z");
  const sig = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
  if (sig.some((v, i) => b[i] !== v)) throw new Error("not a 7z signature");
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (dv.getUint32(8, true) !== crc32(b.subarray(12, 32))) throw new Error("start header CRC mismatch");
  const off = Number(dv.getBigUint64(12, true)), size = Number(dv.getBigUint64(20, true));
  if (size === 0 && off === 0) return; // empty archive
  if (32 + off + size > f.size) throw new Error("truncated: header runs past the end");
  if (size > 1 << 28) throw new SkipFile("archive header larger than 256 MiB");
  if (dv.getUint32(28, true) !== crc32(new Uint8Array(await f.slice(32 + off, 32 + off + size).arrayBuffer()))) throw new Error("header CRC mismatch");
}

interface Item {
  path: string;
  size: string;
  folder: boolean;
  crc: string;
  attr: string;
  mtime: string;
  encrypted: boolean;
}

/** `7zz l -slt` output as items (the archive's own block is not one of them). */
function parseListing(out: string): { items: Item[]; info: Record<string, string> } {
  const [head, body = ""] = out.split(/\n----------\n/);
  const info: Record<string, string> = {};
  for (const l of (head.split(/\n--\n/)[1] ?? "").split("\n")) {
    const i = l.indexOf(" = ");
    if (i > 0) info[l.slice(0, i)] = l.slice(i + 3);
  }
  const items: Item[] = [];
  for (const blk of body.split(/\n\n+/)) {
    if (!blk.includes("Path = ")) continue;
    const f: Record<string, string> = {};
    for (const l of blk.split("\n")) {
      const i = l.indexOf(" = ");
      if (i > 0) f[l.slice(0, i)] = l.slice(i + 3);
    }
    const attr = f.Attributes ?? "";
    items.push({ path: f.Path, size: f.Size ?? "", folder: f.Folder === "+" || attr.startsWith("D"), crc: f.CRC ?? "", attr, mtime: (f.Modified ?? "").replace(/\.\d+$/, ""), encrypted: f.Encrypted === "+" });
  }
  return { items, info };
}

async function list(path: string, ctx: Context) {
  const r = await ctx.run("7zz", ["l", "-slt", NOPASS, "--", path]);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim();
    if (/Cannot open encrypted archive|Wrong password/i.test(msg)) throw new SkipFile("encrypted archive");
    throw new Error(`7zz cannot list it: ${msg.split("\n").find((l) => /error/i.test(l)) ?? msg.split("\n")[0]}`);
  }
  return parseListing(r.stdout);
}

async function test7z(path: string, ctx: Context) {
  const r = await ctx.run("7zz", ["t", NOPASS, "--", path]);
  if (r.code !== 0) throw new Error("integrity test failed");
}

const key = (i: Item) => i.path;
function compare(a: Item[], b: Item[]): true | string {
  if (a.length !== b.length) return `item count ${a.length} became ${b.length}`;
  const sa = [...a].sort((x, y) => (key(x) < key(y) ? -1 : 1)), sb = [...b].sort((x, y) => (key(x) < key(y) ? -1 : 1));
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i], y = sb[i];
    if (x.path !== y.path) return `"${x.path}" became "${y.path}"`;
    if (x.folder !== y.folder || x.size !== y.size || x.crc !== y.crc) return `${x.path}: content differs`;
    // an archive made on Windows has only the DOS letters: compare those; the unix mode is then not part of the content
    const [xa, xu] = [x.attr.split(" ")[0], x.attr.split(" ")[1]];
    if (x.attr && (xu ? x.attr !== y.attr : xa !== y.attr.split(" ")[0])) return `${x.path}: attributes changed`;
    if (x.mtime && x.mtime !== y.mtime) return `${x.path}: time changed`;
  }
  return true;
}

/** "A -rwsr-xr--" -> the mode bits, or null when the archive has no unix part. */
export function unixMode(attr: string): number | null {
  const m = attr.split(" ")[1];
  if (!m || m.length < 10) return null;
  let v = 0;
  for (let i = 0; i < 9; i++) if (m[i + 1] !== "-" && m[i + 1] !== "S" && m[i + 1] !== "T") v |= 1 << (8 - i);
  if ("sS".includes(m[3])) v |= 0o4000;
  if ("sS".includes(m[6])) v |= 0o2000;
  if ("tT".includes(m[9])) v |= 0o1000;
  return v;
}

let seq = 0;
const repack: Step = {
  id: "7z.repack",
  tool: "7zz",
  minLevel: 5,
  async run(input, output, ctx) {
    const dir = join(ctx.dir, `7z${++seq}`);
    mkdirSync(dir, { recursive: true });
    try {
      const r = await ctx.run("7zz", ["x", "-snl", "-y", NOPASS, `-o${dir}`, "--", input]);
      if (r.code !== 0) throw new Error("extraction failed: " + (r.stderr || r.stdout).trim().split("\n")[0]);
      // extraction applies the umask; put the stored unix modes back so they are packed as they were
      for (const it of (await list(input, ctx)).items) {
        const mode = unixMode(it.attr);
        const p = join(dir, it.path);
        if (mode !== null && !it.attr.split(" ")[1].startsWith("l") && existsSync(p)) chmodSync(p, mode);
      }
      const mx = ctx.level >= 7 ? "9" : "7";
      // 7zz appends ".7z" to a name without that extension
      const a = await ctx.run("7zz", ["a", "-t7z", `-mx=${mx}`, "-snl", "-y", output + ".7z", "."], { cwd: dir });
      if (a.code !== 0) throw new Error("repack failed: " + (a.stderr || a.stdout).trim().split("\n")[0]);
      renameSync(output + ".7z", output);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

export const sevenzip: Format = {
  id: "7z",
  extensions: ["7z"],
  detect: (h) => h[0] === 0x37 && h[1] === 0x7a && h[2] === 0xbc && h[3] === 0xaf && h[4] === 0x27 && h[5] === 0x1c,
  async skip(path) {
    return /\.7z\.\d+$/i.test(basename(path)) ? "multi-volume archive" : null;
  },
  steps: [repack],
  oracle: {
    async prepare(path, ctx) {
      await check7zHeader(path);
      if (!(await ctx.tools.locate("7zz"))) throw new SkipFile("7zz not available, cannot verify");
      const l = await list(path, ctx);
      if (l.items.some((i) => i.encrypted) || /AES|7zAES/.test(l.info.Method ?? "")) throw new SkipFile("encrypted archive");
      if (l.info.Multivolume === "+" || l.info.Volumes) throw new SkipFile("multi-volume archive");
      if (l.items.reduce((s, i) => s + (Number(i.size) || 0), 0) > 4 * 2 ** 30) throw new SkipFile("more than 4 GiB uncompressed");
      await test7z(path, ctx);
      return l.items;
    },
    async same(original, candidate, ctx) {
      try {
        await check7zHeader(candidate);
        await test7z(candidate, ctx);
        return compare(original as Item[], (await list(candidate, ctx)).items);
      } catch (e) {
        return `the result is not a valid 7z: ${errorMessage(e)}`;
      }
    },
  },
};

export const formats: Format[] = [sevenzip];
