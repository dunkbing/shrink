// Microsoft Cabinet (.cab) reader and MSZIP rewriter for a single, unsigned cabinet. Only the CFDATA blocks of MSZIP
// (and stored) folders are rewritten; every other byte is copied, with the offsets that moved patched.
import { inflateRawSync } from "node:zlib";
import { SkipFile } from "../types";

export interface CabBlock {
  /** Offset of the CFDATA record. */
  at: number;
  cbData: number;
  cbUncomp: number;
  csum: number;
}
export interface CabFolder {
  /** Offset of the CFFOLDER entry. */
  entry: number;
  start: number;
  type: number;
  blocks: CabBlock[];
}
export interface CabFile {
  name: string;
  size: number;
  offset: number;
  folder: number;
  date: number;
  time: number;
  attribs: number;
}
export interface Cab {
  bytes: Uint8Array;
  folders: CabFolder[];
  files: CabFile[];
  /** End of the folder/file tables = start of the first CFDATA. */
  dataStart: number;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
export const isCab = (h: Uint8Array) => h.length >= 36 && h[0] === 0x4d && h[1] === 0x53 && h[2] === 0x43 && h[3] === 0x46;

export function parseCab(b: Uint8Array): Cab {
  if (b.length > 2 ** 30) throw new SkipFile("larger than 1 GiB");
  if (!isCab(b)) throw new Error("not a cabinet");
  const cbCabinet = u32(b, 8);
  if (cbCabinet > b.length) throw new Error("truncated: the header says the cabinet is longer");
  if (cbCabinet < b.length) throw new SkipFile("data after the cabinet (a signature or an appended payload)");
  const coffFiles = u32(b, 16), cFolders = u16(b, 26), cFiles = u16(b, 28), flags = u16(b, 30);
  if (flags & 3) throw new SkipFile("part of a multi-cabinet set");
  if (flags & 4) throw new SkipFile("has reserved areas (signed or carrying custom data)");
  if (b[25] !== 1 || b[24] > 3) throw new SkipFile(`cabinet version ${b[25]}.${b[24]}`);
  if (36 + 8 * cFolders > b.length || coffFiles < 36 + 8 * cFolders || coffFiles > b.length) throw new Error("bad folder or file table");
  const folders: CabFolder[] = [];
  for (let i = 0; i < cFolders; i++) {
    const e = 36 + 8 * i, n = u16(b, e + 4);
    const f: CabFolder = { entry: e, start: u32(b, e), type: u16(b, e + 6), blocks: [] };
    let p = f.start;
    for (let k = 0; k < n; k++) {
      if (p + 8 > b.length) throw new Error("truncated data block");
      const cbData = u16(b, p + 4), cbUncomp = u16(b, p + 6);
      if (p + 8 + cbData > b.length) throw new Error("truncated data block");
      f.blocks.push({ at: p, cbData, cbUncomp, csum: u32(b, p) });
      p += 8 + cbData;
    }
    folders.push(f);
  }
  const files: CabFile[] = [];
  let p = coffFiles;
  for (let i = 0; i < cFiles; i++) {
    if (p + 17 > b.length) throw new Error("truncated file table");
    let e = p + 16;
    while (e < b.length && b[e] !== 0) e++;
    if (e >= b.length) throw new Error("truncated file name");
    const folder = u16(b, p + 8);
    if (folder >= 0xfffd) throw new SkipFile("file continued from another cabinet");
    if (folder >= cFolders) throw new Error("file points at a missing folder");
    files.push({ name: Buffer.from(b.subarray(p + 16, e)).toString("latin1"), size: u32(b, p), offset: u32(b, p + 4), folder, date: u16(b, p + 10), time: u16(b, p + 12), attribs: u16(b, p + 14) });
    p = e + 1;
  }
  // the usual layout: header, folders, files, then every folder's data in order up to the end
  const dataStart = folders.length ? folders[0].start : p;
  if (p > dataStart) throw new SkipFile("unusual layout (data before the file table)");
  let at = dataStart;
  for (const f of folders) {
    if (f.start !== at) throw new SkipFile("unusual layout (folders out of order)");
    if (f.blocks.length) at = f.blocks[f.blocks.length - 1].at + 8 + f.blocks[f.blocks.length - 1].cbData;
  }
  if (folders.length && at !== cbCabinet) throw new SkipFile("unusual layout (bytes after the last block)");
  for (const f of files) {
    const total = folders[f.folder].blocks.reduce((s, x) => s + x.cbUncomp, 0);
    if (f.offset + f.size > total) throw new Error("file runs past its folder");
  }
  return { bytes: b, folders, files, dataStart };
}

/** The cabinet checksum (as in libmspack): XOR of little-endian words, the tail bytes as one word. */
export function csum(data: Uint8Array, seed = 0): number {
  let c = seed >>> 0, i = 0;
  for (; i + 4 <= data.length; i += 4) c = (c ^ u32(data, i)) >>> 0;
  let t = 0;
  const left = data.length - i;
  if (left === 3) t = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  else if (left === 2) t = (data[i] << 8) | data[i + 1];
  else if (left === 1) t = data[i];
  return (c ^ t) >>> 0;
}

function record(raw: Uint8Array, cbUncomp: number): Uint8Array {
  const r = Buffer.alloc(8 + raw.length);
  r.writeUInt16LE(raw.length, 4);
  r.writeUInt16LE(cbUncomp, 6);
  r.set(raw, 8);
  r.writeUInt32LE(csum(r.subarray(4, 8), csum(raw)), 0);
  return r;
}

export const MSZIP = 1;
export const STORED = 0;
const WINDOW = 32768;

/** Uncompressed blocks of an MSZIP or stored folder (MSZIP blocks may use the 32 KiB before them as a dictionary). */
export function folderBlocks(c: Cab, f: CabFolder): Uint8Array[] {
  const out: Uint8Array[] = [];
  let hist: Uint8Array = new Uint8Array(0);
  for (const k of f.blocks) {
    const d = c.bytes.subarray(k.at + 8, k.at + 8 + k.cbData);
    if (k.cbUncomp === 0 || k.cbUncomp > WINDOW) throw new SkipFile("unusual block (continued or oversized)");
    let raw: Uint8Array;
    if ((f.type & 15) === STORED) raw = d;
    else {
      if (d[0] !== 0x43 || d[1] !== 0x4b) throw new Error("MSZIP block without its signature");
      try {
        raw = inflateRawSync(d.subarray(2), hist.length ? { dictionary: hist } : undefined);
      } catch (e: any) {
        throw new Error(`cannot inflate a block: ${e?.message ?? e}`);
      }
    }
    if (raw.length !== k.cbUncomp) throw new Error("block size does not match its header");
    out.push(raw);
    hist = Buffer.concat([hist, raw]).subarray(-WINDOW);
  }
  return out;
}

/**
 * Rewrites MSZIP and stored folders: `compress(raw, current)` returns the deflate stream for one block (no "CK"), or
 * null to keep the current block. A stored folder becomes MSZIP only when that is smaller. Blocks are made independent
 * of earlier blocks, which every MSZIP decoder accepts.
 */
export async function repackCab(c: Cab, compress: (raw: Uint8Array, current: Uint8Array | null) => Promise<Uint8Array | null>): Promise<Uint8Array> {
  const b = c.bytes;
  const head = Uint8Array.from(b.subarray(0, c.dataStart));
  const dv = new DataView(head.buffer);
  const body: Uint8Array[] = [];
  let pos = c.dataStart;
  for (const f of c.folders) {
    dv.setUint32(f.entry, pos, true);
    const kind = f.type & 15;
    const copy = () => f.blocks.map((k) => b.subarray(k.at, k.at + 8 + k.cbData));
    let recs: Uint8Array[];
    if ((kind !== MSZIP && kind !== STORED) || f.blocks.length === 0) recs = copy();
    else {
      const raws = folderBlocks(c, f);
      const next: Uint8Array[] = [];
      let size = 0, old = 0, allBetter = true;
      for (let i = 0; i < raws.length; i++) {
        const k = f.blocks[i];
        const orig = b.subarray(k.at, k.at + 8 + k.cbData);
        const cur = kind === MSZIP ? b.subarray(k.at + 8 + 2, k.at + 8 + k.cbData) : null;
        const better = await compress(raws[i], cur);
        const wins = !!better && (cur ? better.length < cur.length : better.length + 2 < k.cbData);
        if (!wins) allBetter = false;
        const rec = wins ? record(Buffer.concat([Buffer.from("CK"), better!]), k.cbUncomp) : orig;
        next.push(rec);
        size += rec.length;
        old += orig.length;
      }
      // a stored folder changes method only when every block shrank and the folder got smaller
      if (kind === STORED && !(allBetter && size < old)) recs = copy();
      else {
        if (kind === STORED) dv.setUint16(f.entry + 6, (f.type & ~15) | MSZIP, true);
        recs = next;
      }
    }
    for (const r of recs) {
      body.push(r);
      pos += r.length;
    }
  }
  dv.setUint32(8, pos, true);
  return Buffer.concat([head, ...body]);
}
