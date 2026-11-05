// Strict TAR reader (v7, ustar, GNU long names, pax). Keeps byte ranges so entries can be copied verbatim.
import { SkipFile } from "../types";

export interface TarEntry {
  /** First byte of the entry, including any pax or GNU long-name header before it. */
  start: number;
  /** The file's own header block. */
  header: number;
  dataOffset: number;
  size: number;
  /** One past the padded data. */
  end: number;
  type: string;
  name: string;
  linkname: string;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  pax: Record<string, string>;
  sparse: boolean;
}

const td = new TextDecoder("utf-8", { fatal: false });
const str = (b: Uint8Array, o: number, n: number) => {
  let e = o;
  while (e < o + n && b[e] !== 0) e++;
  return td.decode(b.subarray(o, e));
};
function num(b: Uint8Array, o: number, n: number): number {
  if (b[o] & 0x80) {
    // base-256
    let v = b[o] & 0x7f;
    for (let i = 1; i < n; i++) v = v * 256 + b[o + i];
    return v;
  }
  const s = str(b, o, n).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error("bad octal field");
  return parseInt(s, 8);
}
export function checksumOk(b: Uint8Array, o: number): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[o + i];
  const f = str(b, o + 148, 8).trim();
  return /^[0-7]+$/.test(f) && parseInt(f, 8) === sum;
}
const isZero = (b: Uint8Array, o: number) => {
  for (let i = 0; i < 512; i++) if (b[o + i]) return false;
  return true;
};

function parsePax(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < b.length) {
    let s = p;
    while (s < b.length && b[s] !== 32) s++;
    const len = parseInt(td.decode(b.subarray(p, s)), 10);
    if (!(len > 0) || p + len > b.length) throw new Error("bad pax record");
    const rec = td.decode(b.subarray(s + 1, p + len - 1));
    const eq = rec.indexOf("=");
    if (eq < 0) throw new Error("bad pax record");
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

export function looksLikeTar(h: Uint8Array): boolean {
  if (h.length < 512 || h[0] === 0 || !checksumOk(h, 0)) return false;
  return /^[0-7\0 ]$/.test(String.fromCharCode(h[156])) || "1234567xgLKS".includes(String.fromCharCode(h[156]));
}

export function parseTar(b: Uint8Array): { entries: TarEntry[]; tail: number } {
  if (b.length < 512) throw new Error("too small for tar");
  const entries: TarEntry[] = [];
  let p = 0;
  let start = 0;
  let longName: string | null = null, longLink: string | null = null, pax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  while (p + 512 <= b.length) {
    if (isZero(b, p)) break;
    if (!checksumOk(b, p)) throw new Error(`bad header checksum at ${p}`);
    const type = String.fromCharCode(b[p + 156] || 48);
    if (type === "S") throw new SkipFile("old GNU sparse files");
    const meta = type === "x" || type === "g" || type === "L" || type === "K";
    const px = { ...globalPax, ...pax };
    const size = !meta && px.size !== undefined && /^\d+$/.test(px.size) ? Number(px.size) : num(b, p + 124, 12);
    const hasData = !"123456".includes(type); // links, devices, directories and fifos carry no data
    const dataOffset = p + 512;
    if (hasData && dataOffset + size > b.length) throw new Error("truncated: data runs past the end");
    const end = Math.min(hasData ? dataOffset + Math.ceil(size / 512) * 512 : dataOffset, b.length);
    if (type === "x") pax = { ...pax, ...parsePax(b.subarray(dataOffset, dataOffset + size)) };
    else if (type === "g") globalPax = { ...globalPax, ...parsePax(b.subarray(dataOffset, dataOffset + size)) };
    else if (type === "L") longName = str(b, dataOffset, size);
    else if (type === "K") longLink = str(b, dataOffset, size);
    else {
      let name = str(b, p, 100);
      if (str(b, p + 257, 5) === "ustar" && b[p + 345]) name = str(b, p + 345, 155) + "/" + name;
      const all = { ...globalPax, ...pax };
      entries.push({
        start, header: p, dataOffset, size: hasData ? size : 0, end, type, mode: num(b, p + 100, 8), uid: num(b, p + 108, 8), gid: num(b, p + 116, 8), mtime: num(b, p + 136, 12),
        name: all.path ?? longName ?? name, linkname: all.linkpath ?? longLink ?? str(b, p + 157, 100), pax: all,
        sparse: Object.keys(all).some((k) => k.startsWith("GNU.sparse")),
      });
      longName = longLink = null;
      pax = {};
    }
    p = end;
    if (type !== "x" && type !== "L" && type !== "K") start = p; // g headers stand alone
  }
  if (longName !== null || longLink !== null || Object.keys(pax).length) throw new Error("extended header without a file");
  for (let i = p; i < b.length; i++) if (b[i]) throw new SkipFile("data after the end of the tar");
  return { entries, tail: p };
}
