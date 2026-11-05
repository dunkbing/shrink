// Strict ZIP reader: central directory, zip64, member data. Throws on anything inconsistent.
import { crc32, inflateRawSync } from "node:zlib";
import { SkipFile } from "../types";

export interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  csize: number;
  size: number;
  extAttr: number;
  versionMadeBy: number;
  offset: number;
  extra: Uint8Array;
  comment: Uint8Array;
  /** Offset of the compressed data. */
  dataOffset: number;
  isDir: boolean;
}

export interface Zip {
  entries: ZipEntry[];
  comment: Uint8Array;
  bytes: Uint8Array;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const dec = new TextDecoder("utf-8");

const CP437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
export function entryName(b: Uint8Array, flags: number): string {
  if (flags & 0x800) return dec.decode(b);
  let s = "";
  for (const c of b) s += c < 128 ? String.fromCharCode(c) : CP437[c - 128];
  return s;
}

/** Parses the archive; the whole file must be exactly one ZIP (no prefix data, no trailing data). */
export function parseZip(bytes: Uint8Array): Zip {
  const n = bytes.length;
  if (n < 22) throw new Error("too small for a ZIP");
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw new Error("no local header at the start");
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) {
    if (u32(bytes, i) === 0x06054b50 && i + 22 + u16(bytes, i + 20) === n) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory (truncated or data after the archive)");
  const disk = u16(bytes, eocd + 4), cdDisk = u16(bytes, eocd + 6);
  if (disk !== 0 || cdDisk !== 0) throw new SkipFile("multi-part archive");
  let count = u16(bytes, eocd + 10);
  let cdSize = u32(bytes, eocd + 12);
  let cdOff = u32(bytes, eocd + 16);
  const comment = bytes.subarray(eocd + 22, n);
  let zip64End = eocd;
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(bytes, loc) !== 0x07064b50) throw new Error("zip64 locator missing");
    if (u32(bytes, loc + 4) !== 0 || u32(bytes, loc + 16) !== 1) throw new SkipFile("multi-part archive");
    const z = u64(bytes, loc + 8);
    if (z + 56 > n || u32(bytes, z) !== 0x06064b50) throw new Error("zip64 end record missing");
    count = u64(bytes, z + 32);
    cdSize = u64(bytes, z + 40);
    cdOff = u64(bytes, z + 48);
    zip64End = z;
  }
  if (cdOff + cdSize > zip64End) throw new Error("central directory out of range");
  const entries: ZipEntry[] = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOff + cdSize || u32(bytes, p) !== 0x02014b50) throw new Error("bad central directory entry");
    const flags = u16(bytes, p + 8);
    let csize = u32(bytes, p + 20), size = u32(bytes, p + 24), offset = u32(bytes, p + 42);
    const nl = u16(bytes, p + 28), el = u16(bytes, p + 30), cl = u16(bytes, p + 32);
    if (p + 46 + nl + el + cl > cdOff + cdSize) throw new Error("central directory entry overruns");
    const nameBytes = bytes.subarray(p + 46, p + 46 + nl);
    const extra = bytes.subarray(p + 46 + nl, p + 46 + nl + el);
    for (let q = 0; q + 4 <= extra.length; ) {
      const id = u16(extra, q), len = u16(extra, q + 2);
      if (q + 4 + len > extra.length) throw new Error("bad extra field");
      if (id === 1) {
        let r = q + 4;
        if (size === 0xffffffff) (size = u64(extra, r)), (r += 8);
        if (csize === 0xffffffff) (csize = u64(extra, r)), (r += 8);
        if (offset === 0xffffffff) offset = u64(extra, r);
      }
      q += 4 + len;
    }
    const name = entryName(nameBytes, flags);
    entries.push({
      name, nameBytes, flags, method: u16(bytes, p + 10), dosTime: u16(bytes, p + 12), dosDate: u16(bytes, p + 14), crc: u32(bytes, p + 16),
      csize, size, extAttr: u32(bytes, p + 38), versionMadeBy: u16(bytes, p + 4), offset, extra,
      comment: bytes.subarray(p + 46 + nl + el, p + 46 + nl + el + cl), dataOffset: 0, isDir: name.endsWith("/"),
    });
    p += 46 + nl + el + cl;
  }
  if (p !== cdOff + cdSize) throw new Error("central directory size mismatch");
  for (const e of entries) {
    if (e.offset + 30 > cdOff || u32(bytes, e.offset) !== 0x04034b50) throw new Error(`bad local header for ${e.name}`);
    const nl = u16(bytes, e.offset + 26), el = u16(bytes, e.offset + 28);
    const ln = bytes.subarray(e.offset + 30, e.offset + 30 + nl);
    if (ln.length !== e.nameBytes.length || ln.some((v, i) => v !== e.nameBytes[i])) throw new Error(`local name differs from central name for ${e.name}`);
    e.dataOffset = e.offset + 30 + nl + el;
    if (e.dataOffset + e.csize > cdOff) throw new Error(`data of ${e.name} overruns`);
  }
  return { entries, comment, bytes };
}

/** Reasons a ZIP is not touched, or null. */
export function zipHazards(z: Zip): string | null {
  let total = 0;
  for (const e of z.entries) {
    if (e.flags & 1) return "encrypted entries";
    if (e.flags & 0x40) return "strong encryption";
    if (/(^|[\\/])\.\.([\\/]|$)/.test(e.name) || e.name.startsWith("/") || /^[A-Za-z]:/.test(e.name) || e.name.includes("\0")) return `unsafe member name "${e.name}"`;
    total += e.size;
    if (e.size > 1 << 24 && e.size / Math.max(1, e.csize) > 500) return "zip bomb (huge expansion ratio)";
  }
  if (total > 4 * 2 ** 30) return "zip bomb (more than 4 GiB uncompressed)";
  if (total > 2 ** 20 && total / Math.max(1, z.bytes.length) > 2000) return "zip bomb (huge expansion ratio)";
  return null;
}

/** Inflates one member and checks size and CRC. */
export function readMember(z: Zip, e: ZipEntry): Uint8Array {
  const raw = z.bytes.subarray(e.dataOffset, e.dataOffset + e.csize);
  let out: Uint8Array;
  if (e.method === 0) {
    if (e.csize !== e.size) throw new Error(`stored size mismatch in ${e.name}`);
    out = raw;
  } else if (e.method === 8) {
    try {
      out = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) + 1 });
    } catch (err: any) {
      throw new Error(`cannot inflate ${e.name}: ${err?.message ?? err}`);
    }
  } else throw new SkipFile(`unsupported compression method ${e.method}`);
  if (out.length !== e.size) throw new Error(`size mismatch in ${e.name}`);
  if (crc32(out) !== e.crc) throw new Error(`CRC mismatch in ${e.name}`);
  return out;
}

export const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
