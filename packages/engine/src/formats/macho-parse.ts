// Strict Mach-O reader (thin and fat) and the "same loadable content" comparison used as the oracle for executables.
export interface MachSegment {
  name: string;
  vmaddr: number;
  vmsize: number;
  fileoff: number;
  filesize: number;
  maxprot: number;
  initprot: number;
  flags: number;
  sections: { name: string; seg: string; addr: number; size: number; offset: number; flags: number }[];
}

export interface MachCommand {
  cmd: number;
  /** Bytes of the command. */
  start: number;
  size: number;
}

export interface Macho {
  /** The slice's own bytes. */
  bytes: Uint8Array;
  is64: boolean;
  cputype: number;
  cpusubtype: number;
  filetype: number;
  flags: number;
  commands: MachCommand[];
  segments: MachSegment[];
  symtab: { symoff: number; nsyms: number; stroff: number; strsize: number } | null;
  dysymtab: { indirectsymoff: number; nindirectsyms: number } | null;
  signature: { off: number; size: number } | null;
  /** End of the header and load commands. */
  cmdsEnd: number;
  /** End of the last thing the load commands point at. */
  end: number;
}

export interface Fat {
  slices: { cputype: number; cpusubtype: number; offset: number; size: number; macho: Macho }[];
}

export const LC_SEGMENT = 0x1;
export const LC_SYMTAB = 0x2;
export const LC_DYSYMTAB = 0xb;
export const LC_SEGMENT_64 = 0x19;
export const LC_CODE_SIGNATURE = 0x1d;
export const MH_OBJECT = 1;
export const MH_EXECUTE = 2;

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function isMacho(h: Uint8Array): boolean {
  if (h.length < 8) return false;
  const m = dv(h).getUint32(0, false);
  if (m === 0xcffaedfe || m === 0xcefaedfe) return true;
  if (m === 0xcafebabe || m === 0xcafebabf) {
    const n = dv(h).getUint32(4, false);
    return n > 0 && n < 20 && h.length >= 28 && machoAt(h, dv(h).getUint32(16, false));
  }
  return false;
}

function machoAt(h: Uint8Array, off: number): boolean {
  if (off + 4 > h.length) return true; // beyond the head we see: parsed fully later
  const m = dv(h).getUint32(off, false);
  return m === 0xcffaedfe || m === 0xcefaedfe;
}

function str(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

export function parseThin(bytes: Uint8Array): Macho {
  const fail = (m: string): never => {
    throw new Error(`bad Mach-O: ${m}`);
  };
  if (bytes.length < 32) fail("short header");
  const v = dv(bytes);
  const magic = v.getUint32(0, false);
  if (magic !== 0xcffaedfe && magic !== 0xcefaedfe) fail("not a little-endian Mach-O");
  const is64 = magic === 0xcffaedfe;
  const hdr = is64 ? 32 : 28;
  const ncmds = v.getUint32(16, true);
  const sizeofcmds = v.getUint32(20, true);
  if (hdr + sizeofcmds > bytes.length) fail("load commands out of range");
  const m: Macho = {
    bytes, is64, cputype: v.getUint32(4, true), cpusubtype: v.getUint32(8, true), filetype: v.getUint32(12, true), flags: v.getUint32(24, true),
    commands: [], segments: [], symtab: null, dysymtab: null, signature: null, cmdsEnd: hdr + sizeofcmds, end: hdr + sizeofcmds,
  };
  let p = hdr;
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > hdr + sizeofcmds) fail("load command out of range");
    const cmd = v.getUint32(p, true);
    const size = v.getUint32(p + 4, true);
    if (size < 8 || size % 4 || p + size > hdr + sizeofcmds) fail("bad load command size");
    m.commands.push({ cmd, start: p, size });
    if (cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT) {
      const w = cmd === LC_SEGMENT_64;
      const base = p + 8 + 16;
      // 64-bit: vmaddr, vmsize, fileoff, filesize are 8 bytes; 32-bit: 4 bytes
      const step = w ? 8 : 4;
      const vmaddr = w ? Number(v.getBigUint64(base, true)) : v.getUint32(base, true);
      const vmsize = w ? Number(v.getBigUint64(base + step, true)) : v.getUint32(base + step, true);
      const fileoff = w ? Number(v.getBigUint64(base + 2 * step, true)) : v.getUint32(base + 2 * step, true);
      const filesize = w ? Number(v.getBigUint64(base + 3 * step, true)) : v.getUint32(base + 3 * step, true);
      const q = base + 4 * step;
      const seg: MachSegment = { name: str(bytes, p + 8, 16), vmaddr, vmsize, fileoff, filesize, maxprot: v.getUint32(q, true), initprot: v.getUint32(q + 4, true), flags: v.getUint32(q + 12, true), sections: [] };
      const nsects = v.getUint32(q + 8, true);
      const secSize = w ? 80 : 68;
      if (q + 16 + nsects * secSize > p + size) fail("sections out of range");
      if (seg.fileoff + seg.filesize > bytes.length) fail("a segment runs past the end of the file (truncated)");
      m.end = Math.max(m.end, seg.fileoff + seg.filesize);
      for (let k = 0; k < nsects; k++) {
        const s = q + 16 + k * secSize;
        seg.sections.push({
          name: str(bytes, s, 16), seg: str(bytes, s + 16, 16),
          addr: w ? Number(v.getBigUint64(s + 32, true)) : v.getUint32(s + 32, true),
          size: w ? Number(v.getBigUint64(s + 40, true)) : v.getUint32(s + 36, true),
          offset: v.getUint32(s + (w ? 48 : 40), true), flags: v.getUint32(s + (w ? 64 : 56), true),
        });
      }
      m.segments.push(seg);
    } else if (cmd === LC_SYMTAB) {
      m.symtab = { symoff: v.getUint32(p + 8, true), nsyms: v.getUint32(p + 12, true), stroff: v.getUint32(p + 16, true), strsize: v.getUint32(p + 20, true) };
      const nl = is64 ? 16 : 12;
      if (m.symtab.symoff + m.symtab.nsyms * nl > bytes.length || m.symtab.stroff + m.symtab.strsize > bytes.length) fail("symbol table out of range (truncated)");
    } else if (cmd === LC_DYSYMTAB) {
      m.dysymtab = { indirectsymoff: v.getUint32(p + 56, true), nindirectsyms: v.getUint32(p + 60, true) };
      if (m.dysymtab.indirectsymoff + m.dysymtab.nindirectsyms * 4 > bytes.length) fail("indirect symbols out of range");
    } else if (cmd === LC_CODE_SIGNATURE) {
      m.signature = { off: v.getUint32(p + 8, true), size: v.getUint32(p + 12, true) };
      if (m.signature.off + m.signature.size > bytes.length) fail("signature out of range");
    }
    p += size;
  }
  return m;
}

export function parseMacho(bytes: Uint8Array): { fat: boolean; slices: Fat["slices"] } {
  const v = dv(bytes);
  const magic = bytes.length >= 4 ? v.getUint32(0, false) : 0;
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const wide = magic === 0xcafebabf;
    const n = v.getUint32(4, false);
    const ent = wide ? 32 : 20;
    if (n === 0 || n > 20 || 8 + n * ent > bytes.length) throw new Error("bad Mach-O: bad fat header");
    const slices: Fat["slices"] = [];
    for (let i = 0; i < n; i++) {
      const p = 8 + i * ent;
      const offset = wide ? Number(v.getBigUint64(p + 8, false)) : v.getUint32(p + 8, false);
      const size = wide ? Number(v.getBigUint64(p + 16, false)) : v.getUint32(p + 12, false);
      if (offset + size > bytes.length) throw new Error("bad Mach-O: a fat slice runs past the end of the file (truncated)");
      slices.push({ cputype: v.getUint32(p, false), cpusubtype: v.getUint32(p + 4, false), offset, size, macho: parseThin(bytes.subarray(offset, offset + size)) });
    }
    return { fat: true, slices };
  }
  const macho = parseThin(bytes);
  return { fat: false, slices: [{ cputype: macho.cputype, cpusubtype: macho.cpusubtype, offset: 0, size: bytes.length, macho }] };
}

/** Code signature facts: whether one exists and whether it is only the linker's/ad hoc one. */
export function signatureKind(m: Macho): "none" | "linker" | "adhoc" | "identity" {
  if (!m.signature) return "none";
  const b = m.bytes.subarray(m.signature.off, m.signature.off + m.signature.size);
  if (b.length < 12) return "identity";
  const v = dv(b);
  if (v.getUint32(0, false) !== 0xfade0cc0) return "identity";
  const count = v.getUint32(8, false);
  let cd = -1;
  let cms = false;
  for (let i = 0; i < count && 12 + i * 8 + 8 <= b.length; i++) {
    const type = v.getUint32(12 + i * 8, false);
    const off = v.getUint32(16 + i * 8, false);
    if (type === 0) cd = off;
    if (type === 0x10000 && off + 8 <= b.length && v.getUint32(off + 4, false) > 8) cms = true;
  }
  if (cd < 0 || cd + 16 > b.length) return "identity";
  const flags = v.getUint32(cd + 12, false);
  if (cms) return "identity";
  if (flags & 0x20000) return "linker";
  if (flags & 0x2) return "adhoc";
  return "identity";
}

const LINKEDIT_DATA = new Set([0x1d, 0x1e, 0x26, 0x29, 0x2b, 0x2e, 0x33, 0x34, 0x35, 0x36]);

/** A load command with its link-edit offsets blanked and the data they point at appended, so a moved blob compares equal. */
function normalised(m: Macho, c: MachCommand): string {
  const b = m.bytes.subarray(c.start, c.start + c.size);
  const v = dv(m.bytes);
  const blob = (off: number, size: number) => Buffer.from(m.bytes.subarray(off, off + size)).toString("base64");
  if (LINKEDIT_DATA.has(c.cmd)) return `${c.cmd}:${c.size}:${blob(v.getUint32(c.start + 8, true), v.getUint32(c.start + 12, true))}`;
  if (c.cmd === 0x22 || c.cmd === 0x80000022) {
    let s = `${c.cmd}`;
    for (let i = 0; i < 5; i++) {
      const size = v.getUint32(c.start + 12 + i * 8, true);
      s += `:${size ? blob(v.getUint32(c.start + 8 + i * 8, true), size) : ""}`;
    }
    return s;
  }
  return Buffer.from(b).toString("base64");
}

/** External symbol names (what other images can bind to) and the indirect-symbol names stubs use. */
function symbols(m: Macho): { external: string[]; indirect: string[] } {
  if (!m.symtab) return { external: [], indirect: [] };
  const v = dv(m.bytes);
  const nl = m.is64 ? 16 : 12;
  const name = (i: number) => {
    const o = m.symtab!.stroff + v.getUint32(m.symtab!.symoff + i * nl, true);
    let s = "";
    for (let p = o; p < m.symtab!.stroff + m.symtab!.strsize && m.bytes[p]; p++) s += String.fromCharCode(m.bytes[p]);
    return s;
  };
  const external: string[] = [];
  for (let i = 0; i < m.symtab.nsyms; i++) {
    const type = m.bytes[m.symtab.symoff + i * nl + 4];
    if (type & 0x01) external.push(name(i) + `:${type}`);
  }
  const indirect: string[] = [];
  if (m.dysymtab) {
    for (let i = 0; i < m.dysymtab.nindirectsyms; i++) {
      const idx = v.getUint32(m.dysymtab.indirectsymoff + i * 4, true);
      indirect.push(idx >= m.symtab.nsyms ? `#${(idx >>> 0).toString(16)}` : name(idx));
    }
  }
  return { external, indirect: indirect };
}

const IGNORED = new Set([LC_SYMTAB, LC_DYSYMTAB, LC_CODE_SIGNATURE]);

export function sameThin(a: Macho, b: Macho, allowSignatureChange: boolean): true | string {
  if (a.is64 !== b.is64 || a.cputype !== b.cputype || a.cpusubtype !== b.cpusubtype || a.filetype !== b.filetype || a.flags !== b.flags) return "header changed";
  if (a.segments.length !== b.segments.length) return "segment count changed";
  for (let i = 0; i < a.segments.length; i++) {
    const x = a.segments[i];
    const y = b.segments[i];
    if (x.name !== y.name || x.vmaddr !== y.vmaddr || x.maxprot !== y.maxprot || x.initprot !== y.initprot || x.flags !== y.flags) return `segment ${x.name} changed`;
    if (x.sections.length !== y.sections.length) return `segment ${x.name} sections changed`;
    for (let k = 0; k < x.sections.length; k++) {
      const s = x.sections[k];
      const t = y.sections[k];
      if (s.name !== t.name || s.seg !== t.seg || s.addr !== t.addr || s.size !== t.size || s.flags !== t.flags) return `section ${s.seg},${s.name} changed`;
    }
    if (x.name === "__LINKEDIT") continue; // link-edit data is compared through the load commands
    if (x.vmsize !== y.vmsize || x.filesize !== y.filesize) return `segment ${x.name} size changed`;
    // the header and load commands (at the start of the first segment) are compared as commands below
    const skip = x.fileoff === 0 ? Math.max(a.cmdsEnd, b.cmdsEnd) : 0;
    for (let k = skip; k < x.filesize; k++) if (a.bytes[x.fileoff + k] !== b.bytes[y.fileoff + k]) return `segment ${x.name} contents changed`;
  }
  const ca = a.commands.filter((c) => !IGNORED.has(c.cmd) && c.cmd !== LC_SEGMENT_64 && c.cmd !== LC_SEGMENT);
  const cb = b.commands.filter((c) => !IGNORED.has(c.cmd) && c.cmd !== LC_SEGMENT_64 && c.cmd !== LC_SEGMENT);
  if (ca.length !== cb.length) return "load command count changed";
  for (let i = 0; i < ca.length; i++) if (ca[i].cmd !== cb[i].cmd || normalised(a, ca[i]) !== normalised(b, cb[i])) return `load command 0x${ca[i].cmd.toString(16)} changed`;
  if (!allowSignatureChange && (!a.signature !== !b.signature || (a.signature && b.signature && a.signature.size !== b.signature.size))) return "code signature changed";
  const sa = symbols(a);
  const sb = symbols(b);
  if (sa.external.join("\n") !== sb.external.join("\n")) return "exported or imported symbols changed";
  if (sa.indirect.join("\n") !== sb.indirect.join("\n")) return "stub symbols changed";
  if (b.end > b.bytes.length) return "the result is truncated";
  return true;
}

export function sameMacho(a: ReturnType<typeof parseMacho>, b: ReturnType<typeof parseMacho>, allowSignatureChange: boolean): true | string {
  if (a.fat !== b.fat || a.slices.length !== b.slices.length) return "architectures changed";
  for (let i = 0; i < a.slices.length; i++) {
    if (a.slices[i].cputype !== b.slices[i].cputype || a.slices[i].cpusubtype !== b.slices[i].cpusubtype) return "architectures changed";
    const r = sameThin(a.slices[i].macho, b.slices[i].macho, allowSignatureChange);
    if (r !== true) return r;
  }
  return true;
}
