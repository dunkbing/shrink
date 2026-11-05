// A strict `ar` reader and writer for archives of plain files (Debian packages, generic .ar). Member headers are kept
// byte for byte except the size field.
import { SkipFile } from "../types";

export const AR_MAGIC = "!<arch>\n";
export interface ArMem {
  /** The 60-byte header as stored. */
  header: Uint8Array;
  /** The name without the GNU trailing slash. */
  name: string;
  data: Uint8Array;
}

const latin = new TextDecoder("latin1");
export const isArBytes = (b: Uint8Array) => b.length >= 8 && latin.decode(b.subarray(0, 8)) === AR_MAGIC;
export const arName = (h: Uint8Array, at = 8) => latin.decode(h.subarray(at, at + 16)).trimEnd().replace(/\/$/, "");

export function parseArMembers(b: Uint8Array): ArMem[] {
  if (!isArBytes(b)) throw new Error("not an ar archive");
  const out: ArMem[] = [];
  let p = 8;
  while (p < b.length) {
    if (p + 60 > b.length) throw new Error("truncated member header");
    if (b[p + 58] !== 0x60 || b[p + 59] !== 0x0a) throw new Error("bad member header");
    const sizeText = latin.decode(b.subarray(p + 48, p + 58)).trim();
    if (!/^\d+$/.test(sizeText)) throw new Error("bad member size");
    const size = Number(sizeText);
    if (p + 60 + size > b.length) throw new Error("truncated member");
    const name = arName(b, p);
    out.push({ header: b.subarray(p, p + 60), name, data: b.subarray(p + 60, p + 60 + size) });
    p += 60 + size + (size & 1);
  }
  for (const m of out) {
    if (m.name === "" || m.name === "__.SYMDEF" || m.name === "__.SYMDEF SORTED" || m.name.startsWith("/SYM64") || m.name === "/") throw new SkipFile("has a symbol table (it holds member offsets)");
    if (/^#1\/\d+$/.test(m.name)) throw new SkipFile("BSD-style long member names");
  }
  return out;
}

/** The archive for `members`, size fields rewritten and members padded to even length. */
export function buildAr(members: { header: Uint8Array; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [Buffer.from(AR_MAGIC)];
  for (const m of members) {
    const h = Uint8Array.from(m.header);
    h.set(Buffer.from(String(m.data.length).padEnd(10, " "), "latin1"), 48);
    parts.push(h, m.data);
    if (m.data.length & 1) parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

export type Packed = "gz" | "xz" | null;
/** A member holding a gzip or xz stream, by name and by content. */
export function packedKind(m: { name: string; data: Uint8Array }): Packed {
  const d = m.data;
  if (/\.gz$/i.test(m.name) && d[0] === 0x1f && d[1] === 0x8b && d[2] === 8) return "gz";
  if (/\.xz$/i.test(m.name) && d.length >= 12 && [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0].every((v, i) => d[i] === v)) return "xz";
  return null;
}

const OBJECT_MAGIC: number[][] = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe],
  [0x4d, 0x5a],
  [0x4c, 0x01], [0x64, 0x86], [0x64, 0xaa], [0x00, 0x00, 0xff, 0xff],
];
/** Does the archive hold compiled objects (a static library)? Those belong to the executable format. */
export function looksLikeLibrary(head: Uint8Array): boolean {
  if (!isArBytes(head) || head.length < 68) return false;
  const first = arName(head);
  if (first === "" || first === "/" || first === "//" || first.startsWith("__.SYMDEF") || first.startsWith("/SYM64") || /^#1\//.test(first)) return true;
  return OBJECT_MAGIC.some((m) => m.every((v, i) => head[68 + i] === v));
}
export const looksLikeDeb = (head: Uint8Array) => isArBytes(head) && head.length >= 68 && arName(head) === "debian-binary";
