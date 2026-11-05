// Strict PE/COFF reader and the "same loadable content" comparison used as the oracle for executables.
export interface PeSection {
  name: string;
  vsize: number;
  vaddr: number;
  rawSize: number;
  rawPtr: number;
  chars: number;
}

export interface Pe {
  bytes: Uint8Array;
  lfanew: number;
  machine: number;
  timestamp: number;
  symPtr: number;
  symCount: number;
  optSize: number;
  characteristics: number;
  plus: boolean;
  optOff: number;
  entry: number;
  imageBase: bigint;
  sectionAlign: number;
  fileAlign: number;
  sizeOfImage: number;
  sizeOfHeaders: number;
  checksum: number;
  subsystem: number;
  dllChars: number;
  dirs: { rva: number; size: number }[];
  sections: PeSection[];
  sectionTableEnd: number;
  /** End of the raw data of the sections (the file end if nothing follows). */
  rawEnd: number;
  /** End of the COFF symbol and string tables, or 0. */
  symEnd: number;
}

export const DIR_DEBUG = 6;
export const DIR_SECURITY = 4;
export const DIR_CLR = 14;

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function isPe(head: Uint8Array): boolean {
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
  const off = dv(head).getUint32(0x3c, true);
  // the PE header may lie beyond the head we see; accept MZ files with a plausible offset
  if (off + 4 <= head.length) return head[off] === 0x50 && head[off + 1] === 0x45 && head[off + 2] === 0 && head[off + 3] === 0;
  return off < 1 << 20;
}

export function parsePe(bytes: Uint8Array): Pe {
  const v = dv(bytes);
  const fail = (m: string): never => {
    throw new Error(`bad PE: ${m}`);
  };
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail("no MZ header");
  const lfanew = v.getUint32(0x3c, true);
  if (lfanew < 0x40 || lfanew + 24 > bytes.length) fail("PE header offset out of range");
  if (v.getUint32(lfanew, true) !== 0x4550) fail("no PE signature");
  const c = lfanew + 4;
  const machine = v.getUint16(c, true);
  const nsec = v.getUint16(c + 2, true);
  const timestamp = v.getUint32(c + 4, true);
  const symPtr = v.getUint32(c + 8, true);
  const symCount = v.getUint32(c + 12, true);
  const optSize = v.getUint16(c + 16, true);
  const characteristics = v.getUint16(c + 18, true);
  const o = c + 20;
  if (optSize < 96 || o + optSize > bytes.length) fail("optional header out of range");
  const magic = v.getUint16(o, true);
  if (magic !== 0x10b && magic !== 0x20b) fail("unknown optional header magic");
  const plus = magic === 0x20b;
  const fixed = plus ? 112 : 96;
  if (optSize < fixed) fail("optional header too small");
  const imageBase = plus ? v.getBigUint64(o + 24, true) : BigInt(v.getUint32(o + 28, true));
  const ndirs = v.getUint32(o + fixed - 4, true);
  if (ndirs > 16 || fixed + ndirs * 8 > optSize) fail("bad data directory count");
  const dirs: { rva: number; size: number }[] = [];
  for (let i = 0; i < 16; i++) dirs.push(i < ndirs ? { rva: v.getUint32(o + fixed + i * 8, true), size: v.getUint32(o + fixed + i * 8 + 4, true) } : { rva: 0, size: 0 });
  const st = o + optSize;
  if (nsec === 0 || nsec > 96) fail("bad section count");
  if (st + nsec * 40 > bytes.length) fail("section table out of range");
  const sections: PeSection[] = [];
  let rawEnd = 0;
  for (let i = 0; i < nsec; i++) {
    const p = st + i * 40;
    let name = "";
    for (let k = 0; k < 8 && bytes[p + k]; k++) name += String.fromCharCode(bytes[p + k]);
    const s: PeSection = { name, vsize: v.getUint32(p + 8, true), vaddr: v.getUint32(p + 12, true), rawSize: v.getUint32(p + 16, true), rawPtr: v.getUint32(p + 20, true), chars: v.getUint32(p + 36, true) };
    if (s.rawSize > 0) {
      if (s.rawPtr + s.rawSize > bytes.length) fail(`section ${name} runs past the end of the file (truncated)`);
      rawEnd = Math.max(rawEnd, s.rawPtr + s.rawSize);
    }
    sections.push(s);
  }
  const sizeOfHeaders = v.getUint32(o + 60, true);
  rawEnd = Math.max(rawEnd, sizeOfHeaders);
  let symEnd = 0;
  if (symPtr) {
    const tab = symPtr + symCount * 18;
    if (tab + 4 > bytes.length) fail("symbol table out of range");
    symEnd = tab + v.getUint32(tab, true);
    if (symEnd > bytes.length || symEnd < tab + 4) fail("string table out of range");
  }
  return {
    bytes, lfanew, machine, timestamp, symPtr, symCount, optSize, characteristics, plus, optOff: o,
    entry: v.getUint32(o + 16, true), imageBase, sectionAlign: v.getUint32(o + 32, true), fileAlign: v.getUint32(o + 36, true),
    sizeOfImage: v.getUint32(o + 56, true), sizeOfHeaders, checksum: v.getUint32(o + 64, true), subsystem: v.getUint16(o + 68, true), dllChars: v.getUint16(o + 70, true),
    dirs, sections, sectionTableEnd: st + nsec * 40, rawEnd, symEnd,
  };
}

/** Bytes after the sections (and symbol tables): installer payloads, signatures... */
export function peOverlay(pe: Pe): number {
  return Math.max(0, pe.bytes.length - Math.max(pe.rawEnd, pe.symEnd));
}

/** The PE checksum (what `CheckSumMappedFile` computes): 16-bit words with carry folding, plus the file length. */
export function peChecksum(bytes: Uint8Array, checksumOffset: number): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    if (i === checksumOffset || i === checksumOffset + 2) continue;
    sum += bytes[i] | ((bytes[i + 1] ?? 0) << 8);
    sum = (sum & 0xffff) + Math.floor(sum / 65536);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return ((sum & 0xffff) + bytes.length) >>> 0;
}

/** Drops the COFF symbol and string tables when they are the last thing in the file. Returns null when there is nothing to drop. */
export function stripPeSymbols(pe: Pe): Uint8Array | null {
  if (!pe.symPtr || pe.symEnd !== pe.bytes.length || pe.symPtr < pe.rawEnd) return null;
  const out = pe.bytes.slice(0, pe.symPtr);
  const v = dv(out);
  v.setUint32(pe.lfanew + 4 + 8, 0, true);
  v.setUint32(pe.lfanew + 4 + 12, 0, true);
  if (pe.checksum) v.setUint32(pe.optOff + 64, peChecksum(out, pe.optOff + 64), true);
  return out;
}

const DEBUG_NAME = /^(\.debug|\.zdebug|\.stab|\/\d+$)/;

/** What the loader maps from a section: its raw bytes padded with zeros to the virtual size. */
function sameSectionBytes(a: Pe, sa: PeSection, b: Pe, sb: PeSection): boolean {
  const la = Math.min(sa.rawSize, sa.vsize || sa.rawSize);
  const lb = Math.min(sb.rawSize, sb.vsize || sb.rawSize);
  const n = Math.min(la, lb);
  const x = a.bytes.subarray(sa.rawPtr, sa.rawPtr + la);
  const y = b.bytes.subarray(sb.rawPtr, sb.rawPtr + lb);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  for (let i = n; i < la; i++) if (x[i] !== 0) return false;
  for (let i = n; i < lb; i++) if (y[i] !== 0) return false;
  return true;
}

/** true when `b` maps the same sections with the same bytes as `a`, differing only in debug sections, symbols and slack. */
export function samePe(a: Pe, b: Pe): true | string {
  const d = (what: string, x: unknown, y: unknown) => `${what} changed (${x} -> ${y})`;
  if (a.machine !== b.machine) return d("machine", a.machine, b.machine);
  if (a.characteristics !== b.characteristics) return d("characteristics", a.characteristics, b.characteristics);
  if (a.timestamp !== b.timestamp) return d("timestamp", a.timestamp, b.timestamp);
  if (a.plus !== b.plus) return "PE32/PE32+ changed";
  if (a.entry !== b.entry) return d("entry point", a.entry, b.entry);
  if (a.imageBase !== b.imageBase) return d("image base", a.imageBase, b.imageBase);
  if (a.sectionAlign !== b.sectionAlign) return d("section alignment", a.sectionAlign, b.sectionAlign);
  if (a.subsystem !== b.subsystem || a.dllChars !== b.dllChars) return "subsystem or DLL flags changed";
  for (let i = 0; i < 16; i++) {
    if (i === DIR_SECURITY) {
      if (b.dirs[i].rva || b.dirs[i].size) return "a signature was added";
      continue;
    }
    if (a.dirs[i].rva !== b.dirs[i].rva || a.dirs[i].size !== b.dirs[i].size) return `data directory ${i} changed`;
  }
  if (b.dirs[DIR_CLR].rva) return "a .NET header appeared";
  const dropped = new Set<PeSection>();
  const rest = a.sections.filter((s) => {
    const droppable = DEBUG_NAME.test(s.name) && !(a.dirs[DIR_DEBUG].rva >= s.vaddr && a.dirs[DIR_DEBUG].rva < s.vaddr + Math.max(s.vsize, 1));
    if (droppable && !b.sections.some((t) => t.name === s.name && t.vaddr === s.vaddr)) {
      dropped.add(s);
      return false;
    }
    return true;
  });
  if (rest.length !== b.sections.length) return `section count ${a.sections.length} became ${b.sections.length}`;
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    const y = b.sections[i];
    if (x.name !== y.name || x.vaddr !== y.vaddr || x.vsize !== y.vsize || x.chars !== y.chars) return `section ${x.name} header changed`;
    if (!sameSectionBytes(a, x, b, y)) return `section ${x.name} contents changed`;
  }
  if (!dropped.size && a.sizeOfImage !== b.sizeOfImage) return d("image size", a.sizeOfImage, b.sizeOfImage);
  if (b.sizeOfImage > a.sizeOfImage) return "image size grew";
  if (peOverlay(b)) return "the result has data after its sections";
  return true;
}
