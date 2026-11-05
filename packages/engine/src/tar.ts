import { createReadStream } from "node:fs";
import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, symlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const text = (b: Uint8Array, from: number, len: number) => {
  const s = Buffer.from(b.subarray(from, from + len)).toString("utf8");
  const z = s.indexOf("\0");
  return z < 0 ? s : s.slice(0, z);
};

function octal(b: Uint8Array, from: number, len: number): number {
  if (b[from] & 0x80) {
    // base-256 (GNU) for big sizes
    let n = b[from] & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + b[from + i];
    return n;
  }
  return parseInt(text(b, from, len).trim() || "0", 8);
}

/** Reads `key=value` records of a pax header. */
function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(data.subarray(i, sp).toString());
    if (!(len > 0)) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Unpacks a .tar.gz into `dest` (streamed; refuses paths that leave it). Handles ustar, GNU long names and pax headers. */
export async function extractTarGz(file: string, dest: string): Promise<void> {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  let buf: Buffer = Buffer.alloc(0);
  let state: "header" | "data" | "pad" = "header";
  let left = 0;
  let pad = 0;
  let fd: number | null = null;
  let meta: Buffer[] = []; // data of a long-name / pax entry
  let kind = "0";
  let path = "";
  let link = "";
  let mode = 0o644;
  let over: { path?: string; link?: string } = {}; // set by the preceding L / K / x entry

  const target = (name: string) => {
    const t = resolve(root, name);
    if (isAbsolute(name) || !inside(t)) throw new Error(`unsafe path in archive: ${name}`);
    return t;
  };
  const finish = () => {
    if (kind === "L") over.path = Buffer.concat(meta).toString("utf8").replace(/\0.*$/s, "");
    else if (kind === "K") over.link = Buffer.concat(meta).toString("utf8").replace(/\0.*$/s, "");
    else if (kind === "x") {
      const p = pax(Buffer.concat(meta));
      if (p.path) over.path = p.path;
      if (p.linkpath) over.link = p.linkpath;
    }
    if (fd !== null) {
      closeSync(fd);
      fd = null;
      chmodSync(path, mode & 0o777 || 0o644); // already resolved by header()
    }
    meta = [];
  };
  const header = (h: Buffer) => {
    if (h.every((x) => x === 0)) return;
    const prefix = text(h, 345, 155);
    const name = text(h, 0, 100);
    kind = String.fromCharCode(h[156] || 48);
    const size = octal(h, 124, 12);
    mode = octal(h, 100, 8);
    left = size;
    pad = (512 - (size % 512)) % 512;
    if (kind === "L" || kind === "K" || kind === "x") {
      meta = [];
    } else if (kind !== "g") {
      path = over.path ?? (prefix && text(h, 257, 5) === "ustar" ? `${prefix}/${name}` : name);
      link = over.link ?? text(h, 157, 100);
      over = {};
      const t = target(path.replace(/^\.\//, "") || ".");
      if (kind === "5") mkdirSync(t, { recursive: true });
      else if (kind === "0" || kind === "7") {
        mkdirSync(dirname(t), { recursive: true });
        fd = openSync(t, "w", 0o600);
      } else if (kind === "2") {
        mkdirSync(dirname(t), { recursive: true });
        if (!inside(resolve(dirname(t), link))) throw new Error(`unsafe link in archive: ${link}`);
        try {
          symlinkSync(link, t);
        } catch {} // Windows without the privilege: packs do not rely on links
      } else if (kind === "1") {
        mkdirSync(dirname(t), { recursive: true });
        copyFileSync(target(link), t);
      }
      path = t;
    }
    state = left > 0 ? "data" : pad > 0 ? "pad" : "header";
    if (left === 0) finish();
  };
  const feed = (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (state === "header") {
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        header(h);
      } else if (state === "data") {
        const take = Math.min(left, buf.length);
        if (!take) return;
        const part = buf.subarray(0, take);
        if (fd !== null) writeSync(fd, part);
        else meta.push(Buffer.from(part));
        buf = buf.subarray(take);
        left -= take;
        if (left === 0) {
          finish();
          state = pad > 0 ? "pad" : "header";
        }
      } else {
        const skip = Math.min(pad, buf.length);
        buf = buf.subarray(skip);
        pad -= skip;
        if (pad > 0) return;
        state = "header";
      }
    }
  };
  try {
    await pipeline(createReadStream(file), createGunzip(), async (src: AsyncIterable<Buffer>) => {
      for await (const c of src) feed(c);
    });
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

