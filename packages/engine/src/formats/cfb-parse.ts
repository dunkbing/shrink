// Compound File Binary (OLE2): strict reader and a compacting writer (defragments, drops free and orphan sectors).
import { SkipFile } from "../types";

const FREE = 0xffffffff, END = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc, NOSTREAM = 0xffffffff;
const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export interface Dirent {
  /** The 128 raw bytes of the directory entry. */
  raw: Uint8Array;
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  size: number;
  /** The stream bytes (type 2 only; the root's mini stream is kept apart). */
  data: Uint8Array | null;
}

export interface Cfb {
  header: Uint8Array;
  major: number;
  secSize: number;
  miniSize: number;
  cutoff: number;
  dirents: Dirent[];
  /** path -> index for every entry reachable from the root. */
  paths: Map<string, number>;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 255, b[o + 1] = (v >>> 8) & 255, b[o + 2] = (v >>> 16) & 255, b[o + 3] = (v >>> 24) & 255;
};

export const looksLikeCfb = (h: Uint8Array) => MAGIC.every((v, i) => h[i] === v);

export function readCfb(b: Uint8Array): Cfb {
  if (b.length < 1536) throw new Error("too small for a compound file");
  if (!looksLikeCfb(b)) throw new Error("no compound file signature");
  if (u16(b, 0x1c) !== 0xfffe) throw new Error("bad byte order mark");
  const major = u16(b, 0x1a);
  const shift = u16(b, 0x1e);
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) throw new Error(`unsupported version ${major} / sector shift ${shift}`);
  const secSize = 1 << shift;
  const miniShift = u16(b, 0x20);
  if (miniShift !== 6) throw new Error("unsupported mini sector size");
  const miniSize = 64;
  const nSec = Math.floor((b.length - secSize) / secSize);
  const off = (s: number) => (s + 1) * secSize;
  const sector = (s: number) => {
    if (s >= nSec) throw new Error(`sector ${s} is past the end of the file`);
    return b.subarray(off(s), off(s) + secSize);
  };
  const epc = secSize / 4;
  const numFat = u32(b, 0x2c), firstDir = u32(b, 0x30), cutoff = u32(b, 0x38), firstMini = u32(b, 0x3c), numMini = u32(b, 0x40), firstDifat = u32(b, 0x44), numDifat = u32(b, 0x48);
  if (cutoff !== 4096) throw new Error("unsupported mini stream cutoff");
  if (numFat === 0 || numFat > nSec) throw new Error("bad FAT sector count");
  // DIFAT -> FAT sector list
  const fatSecs: number[] = [];
  for (let i = 0; i < 109 && fatSecs.length < numFat; i++) fatSecs.push(u32(b, 0x4c + i * 4));
  let d = firstDifat;
  for (let n = 0; fatSecs.length < numFat; n++) {
    if (n >= numDifat || d >= nSec) throw new Error("broken DIFAT");
    const s = sector(d);
    for (let i = 0; i < epc - 1 && fatSecs.length < numFat; i++) fatSecs.push(u32(s, i * 4));
    d = u32(s, secSize - 4);
  }
  const fat = new Uint32Array(numFat * epc);
  fatSecs.forEach((fs, i) => {
    const s = sector(fs);
    for (let j = 0; j < epc; j++) fat[i * epc + j] = u32(s, j * 4);
  });
  for (const fs of fatSecs) if (fat[fs] !== FATSECT) throw new Error("FAT sector not marked in the FAT");
  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    let s = start;
    while (s !== END) {
      if (s >= limit || s >= table.length) throw new Error(`chain goes to invalid sector ${s}`);
      out.push(s);
      if (out.length > table.length) throw new Error("chain loops");
      s = table[s];
    }
    return out;
  };
  const read = (start: number, size: number): Uint8Array => {
    const c = chain(start, fat, nSec);
    if (c.length * secSize < size) throw new Error("stream chain shorter than its size");
    const out = new Uint8Array(c.length * secSize);
    c.forEach((s, i) => out.set(sector(s), i * secSize));
    return out.subarray(0, size);
  };
  // directory
  const dirChain = chain(firstDir, fat, nSec);
  if (dirChain.length === 0) throw new Error("no directory");
  const dirBytes = new Uint8Array(dirChain.length * secSize);
  dirChain.forEach((s, i) => dirBytes.set(sector(s), i * secSize));
  const count = dirBytes.length / 128;
  const dirents: Dirent[] = [];
  for (let i = 0; i < count; i++) {
    const raw = dirBytes.slice(i * 128, i * 128 + 128);
    const nl = u16(raw, 64);
    const type = raw[66];
    if (![0, 1, 2, 5].includes(type)) throw new Error(`bad directory entry type ${type}`);
    if (type !== 0 && (nl < 2 || nl > 64 || nl % 2)) throw new Error("bad directory name length");
    const name = type === 0 ? "" : new TextDecoder("utf-16le").decode(raw.subarray(0, nl - 2));
    const size = major === 3 ? u32(raw, 120) : u32(raw, 120) + u32(raw, 124) * 2 ** 32;
    dirents.push({ raw, name, type, left: u32(raw, 68), right: u32(raw, 72), child: u32(raw, 76), size, data: null });
  }
  if (dirents[0].type !== 5) throw new Error("first directory entry is not the root");
  // mini FAT and mini stream
  const miniFatBytes = numMini ? read(firstMini, numMini * secSize) : new Uint8Array(0);
  if (numMini && chain(firstMini, fat, nSec).length !== numMini) throw new Error("mini FAT length mismatch");
  const miniFat = new Uint32Array(miniFatBytes.length / 4);
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = u32(miniFatBytes, i * 4);
  const root = dirents[0];
  const rootStart = u32(root.raw, 116);
  let mini: Uint8Array | null = null;
  const miniStream = () => (mini ??= root.size ? read(rootStart, root.size) : new Uint8Array(0));
  // tree walk
  const paths = new Map<string, number>();
  const seen = new Set<number>([0]);
  const walk = (id: number, prefix: string, depth: number) => {
    // iterative over siblings through left/right, recursive over children
    const stack = [id];
    while (stack.length) {
      const i = stack.pop()!;
      if (i === NOSTREAM) continue;
      if (i >= dirents.length) throw new Error("directory link out of range");
      if (seen.has(i)) throw new Error("directory tree has a cycle or shared entry");
      seen.add(i);
      const e = dirents[i];
      if (e.type === 0) throw new Error("directory tree points at a free entry");
      if (e.type === 5) throw new Error("second root entry");
      stack.push(e.left, e.right);
      const p = prefix + "/" + e.name;
      if (paths.has(p)) throw new Error("duplicate name in a storage");
      paths.set(p, i);
      if (e.type === 1) {
        if (depth > 200) throw new Error("directory nesting too deep");
        walk(e.child, p, depth + 1);
      } else if (e.child !== NOSTREAM && e.child !== 0) {
        throw new Error("a stream has children");
      }
    }
  };
  walk(root.child, "", 0);
  for (const [, i] of paths) {
    const e = dirents[i];
    if (e.type !== 2) continue;
    const start = u32(e.raw, 116);
    if (e.size === 0) {
      e.data = new Uint8Array(0);
    } else if (e.size < cutoff) {
      const c = chain(start, miniFat, miniFat.length);
      if (c.length * miniSize < e.size) throw new Error(`mini stream ${e.name} is shorter than its size`);
      const ms = miniStream();
      const out = new Uint8Array(c.length * miniSize);
      c.forEach((s, k) => {
        if (s * miniSize >= ms.length) throw new Error("mini sector past the mini stream");
        out.set(ms.subarray(s * miniSize, (s + 1) * miniSize), k * miniSize);
      });
      e.data = out.subarray(0, e.size);
    } else {
      e.data = read(start, e.size);
    }
  }
  return { header: b.slice(0, secSize), major, secSize, miniSize, cutoff, dirents, paths };
}

const emptyEntry = () => {
  const r = new Uint8Array(128);
  put32(r, 68, NOSTREAM), put32(r, 72, NOSTREAM), put32(r, 76, NOSTREAM);
  return r;
};

/** Writes the model compactly: directory, mini FAT, mini stream, big streams, FAT, DIFAT. */
export function writeCfb(c: Cfb): Uint8Array {
  const { secSize, miniSize, cutoff, major } = c;
  const epc = secSize / 4;
  const reachable = new Set(c.paths.values());
  const ents = c.dirents.map((e, i) => ({ ...e, raw: Uint8Array.from(e.raw), keep: i === 0 || reachable.has(i) }));
  // drop entries that are not part of the tree (free ones included), only at the tail so indexes stay valid
  let n = ents.length;
  while (n > 1 && !ents[n - 1].keep) n--;
  const used = ents.slice(0, n);
  const dirSecs = Math.ceil(n / (secSize / 128));
  // streams
  const miniData: Uint8Array[] = [];
  const miniFat: number[] = [];
  const big: { idx: number; data: Uint8Array }[] = [];
  let miniCount = 0;
  used.forEach((e, i) => {
    if (e.type === 2 && e.keep) {
      const data = e.data!;
      if (data.length === 0) return;
      if (data.length < cutoff) {
        const k = Math.ceil(data.length / miniSize);
        for (let j = 0; j < k; j++) miniFat.push(j === k - 1 ? END : miniCount + j + 1);
        const padded = new Uint8Array(k * miniSize);
        padded.set(data);
        miniData.push(padded);
        put32(e.raw, 116, miniCount);
        miniCount += k;
      } else big.push({ idx: i, data });
    }
  });
  const miniFatSecs = Math.ceil((miniFat.length * 4) / secSize);
  const miniStreamLen = miniCount * miniSize;
  const miniStreamSecs = Math.ceil(miniStreamLen / secSize);
  const bigSecs = big.reduce((s, b) => s + Math.ceil(b.data.length / secSize), 0);
  const body = dirSecs + miniFatSecs + miniStreamSecs + bigSecs;
  let fatSecs = 1, difSecs = 0;
  for (;;) {
    difSecs = fatSecs > 109 ? Math.ceil((fatSecs - 109) / (epc - 1)) : 0;
    if (fatSecs * epc >= body + fatSecs + difSecs) break;
    fatSecs++;
  }
  const total = body + fatSecs + difSecs;
  const fat = new Uint32Array(fatSecs * epc).fill(FREE);
  const out = new Uint8Array(secSize * (1 + total));
  let next = 0;
  const alloc = (data: Uint8Array | null, count: number): number => {
    const start = next;
    for (let j = 0; j < count; j++) fat[start + j] = j === count - 1 ? END : start + j + 1;
    if (data) out.set(data, secSize * (1 + start));
    next += count;
    return count ? start : END;
  };
  // streams first need their start sectors, so lay the sectors out in order and patch entries
  const dirStart = next;
  next += dirSecs;
  for (let j = 0; j < dirSecs; j++) fat[dirStart + j] = j === dirSecs - 1 ? END : dirStart + j + 1;
  const miniFatBytes = new Uint8Array(miniFatSecs * secSize).fill(0xff);
  miniFat.forEach((v, i) => put32(miniFatBytes, i * 4, v));
  const miniFatStart = miniFatSecs ? alloc(miniFatBytes, miniFatSecs) : END;
  const miniBytes = new Uint8Array(miniStreamSecs * secSize);
  let mp = 0;
  for (const m of miniData) (miniBytes.set(m, mp), (mp += m.length));
  const miniStart = miniStreamSecs ? alloc(miniBytes, miniStreamSecs) : END;
  for (const b of big) {
    const k = Math.ceil(b.data.length / secSize);
    const padded = new Uint8Array(k * secSize);
    padded.set(b.data);
    put32(used[b.idx].raw, 116, alloc(padded, k));
  }
  // directory entries
  const dirBytes = new Uint8Array(dirSecs * secSize);
  for (let i = 0; i < dirSecs * (secSize / 128); i++) {
    const e = i < n ? used[i] : null;
    let raw: Uint8Array;
    if (!e || !e.keep) raw = emptyEntry();
    else {
      raw = e.raw;
      if (e.type === 2 && e.data!.length === 0) (put32(raw, 116, END), put32(raw, 120, 0), put32(raw, 124, 0));
      if (e.type === 1) (put32(raw, 116, 0), put32(raw, 120, 0), put32(raw, 124, 0));
      if (e.type === 5) (put32(raw, 116, miniStart), put32(raw, 120, miniStreamLen), put32(raw, 124, 0));
      if (e.type === 2 && major === 3) put32(raw, 124, 0);
    }
    dirBytes.set(raw, i * 128);
  }
  out.set(dirBytes, secSize * (1 + dirStart));
  // FAT and DIFAT sectors
  const fatStart = next;
  for (let j = 0; j < fatSecs; j++) fat[fatStart + j] = FATSECT;
  next += fatSecs;
  const difStart = next;
  for (let j = 0; j < difSecs; j++) fat[difStart + j] = DIFSECT;
  next += difSecs;
  for (let j = 0; j < fatSecs; j++) for (let k = 0; k < epc; k++) put32(out, secSize * (1 + fatStart + j) + k * 4, fat[j * epc + k]);
  // header
  const h = out.subarray(0, secSize);
  h.set(c.header.subarray(0, 0x4c));
  put32(h, 0x28, major === 4 ? dirSecs : 0);
  put32(h, 0x2c, fatSecs);
  put32(h, 0x30, dirStart);
  put32(h, 0x34, 0);
  put32(h, 0x3c, miniFatStart);
  put32(h, 0x40, miniFatSecs);
  put32(h, 0x44, difSecs ? difStart : END);
  put32(h, 0x48, difSecs);
  for (let i = 0; i < 109; i++) put32(h, 0x4c + i * 4, i < fatSecs ? fatStart + i : FREE);
  for (let j = 0; j < difSecs; j++) {
    const base = secSize * (1 + difStart + j);
    for (let k = 0; k < epc - 1; k++) {
      const idx = 109 + j * (epc - 1) + k;
      put32(out, base + k * 4, idx < fatSecs ? fatStart + idx : FREE);
    }
    put32(out, base + secSize - 4, j === difSecs - 1 ? END : difStart + j + 1);
  }
  return out;
}

/** What makes two compound files the same: every path with its type, CLSID, state, times and stream bytes. */
export function describe(c: Cfb): Map<string, string> {
  const m = new Map<string, string>();
  const rootRaw = c.dirents[0].raw;
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  m.set("/", `5 ${hex(rootRaw.subarray(80, 96))} ${hex(rootRaw.subarray(96, 100))}`);
  for (const [p, i] of c.paths) {
    const e = c.dirents[i];
    const sha = e.data ? new Bun.CryptoHasher("sha256").update(e.data).digest("hex") : "";
    m.set(p, `${e.type} ${hex(e.raw.subarray(80, 96))} ${hex(e.raw.subarray(96, 116))} ${e.data ? e.data.length : 0} ${sha}`);
  }
  return m;
}

export function signed(c: Cfb): boolean {
  for (const p of c.paths.keys()) if (/\/\u0005(Msi)?DigitalSignature/.test(p)) return true;
  return false;
}
export { SkipFile };
