// Strict ELF reader, `ar` reader and the "same loadable content" comparison used as the oracle for executables.
export interface ElfSection {
  index: number;
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  entsize: number;
}

export interface ElfSegment {
  type: number;
  flags: number;
  offset: number;
  vaddr: number;
  paddr: number;
  filesz: number;
  memsz: number;
  align: number;
}

export interface Elf {
  bytes: Uint8Array;
  is64: boolean;
  le: boolean;
  type: number;
  machine: number;
  entry: number;
  eflags: number;
  ehsize: number;
  segments: ElfSegment[];
  sections: ElfSection[];
  /** End of everything the headers describe (sections, segments, tables). */
  end: number;
}

export const SHF_ALLOC = 2;
export const SHT_NOBITS = 8;
export const SHT_SYMTAB = 2;
export const SHT_REL = 9;
export const SHT_RELA = 4;
export const ET_REL = 1;
export const PT_LOAD = 1;

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export const isElf = (h: Uint8Array) => h.length >= 20 && h[0] === 0x7f && h[1] === 0x45 && h[2] === 0x4c && h[3] === 0x46;

export function parseElf(bytes: Uint8Array): Elf {
  const fail = (m: string): never => {
    throw new Error(`bad ELF: ${m}`);
  };
  if (!isElf(bytes) || bytes.length < 52) fail("no ELF header");
  const is64 = bytes[4] === 2;
  if (bytes[4] !== 1 && !is64) fail("unknown class");
  if (bytes[5] !== 1 && bytes[5] !== 2) fail("unknown byte order");
  const le = bytes[5] === 1;
  const v = dv(bytes);
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);
  const word = (o: number) => {
    if (!is64) return u32(o);
    const lo = le ? u32(o) : u32(o + 4);
    const hi = le ? u32(o + 4) : u32(o);
    if (hi >= 2 ** 21) fail("offset too large");
    return hi * 2 ** 32 + lo;
  };
  if (is64 && bytes.length < 64) fail("short header");
  const type = u16(16);
  const machine = u16(18);
  const entry = word(24);
  const phoff = is64 ? word(32) : u32(28);
  const shoff = is64 ? word(40) : u32(32);
  const eflags = u32(is64 ? 48 : 36);
  const ehsize = u16(is64 ? 52 : 40);
  const phentsize = u16(is64 ? 54 : 42);
  const phnum = u16(is64 ? 56 : 44);
  const shentsize = u16(is64 ? 58 : 46);
  const shnum = u16(is64 ? 60 : 48);
  const shstrndx = u16(is64 ? 62 : 50);
  let end = ehsize;
  const segments: ElfSegment[] = [];
  if (phnum) {
    if (phentsize < (is64 ? 56 : 32)) fail("bad program header size");
    if (phoff + phnum * phentsize > bytes.length) fail("program headers out of range");
    end = Math.max(end, phoff + phnum * phentsize);
    for (let i = 0; i < phnum; i++) {
      const p = phoff + i * phentsize;
      const s: ElfSegment = is64
        ? { type: u32(p), flags: u32(p + 4), offset: word(p + 8), vaddr: word(p + 16), paddr: word(p + 24), filesz: word(p + 32), memsz: word(p + 40), align: word(p + 48) }
        : { type: u32(p), offset: u32(p + 4), vaddr: u32(p + 8), paddr: u32(p + 12), filesz: u32(p + 16), memsz: u32(p + 20), flags: u32(p + 24), align: u32(p + 28) };
      if (s.offset + s.filesz > bytes.length) fail("a segment runs past the end of the file (truncated)");
      end = Math.max(end, s.offset + s.filesz);
      segments.push(s);
    }
  }
  const sections: ElfSection[] = [];
  if (shoff || shnum) {
    if (!shnum || shnum >= 0xff00) fail("unsupported section count");
    if (shentsize < (is64 ? 64 : 40)) fail("bad section header size");
    if (shoff + shnum * shentsize > bytes.length) fail("section headers out of range");
    end = Math.max(end, shoff + shnum * shentsize);
    const raw: (ElfSection & { nameOff: number })[] = [];
    for (let i = 0; i < shnum; i++) {
      const p = shoff + i * shentsize;
      const s = is64
        ? { index: i, nameOff: u32(p), name: "", type: u32(p + 4), flags: word(p + 8), addr: word(p + 16), offset: word(p + 24), size: word(p + 32), link: u32(p + 40), info: u32(p + 44), entsize: word(p + 56) }
        : { index: i, nameOff: u32(p), name: "", type: u32(p + 4), flags: u32(p + 8), addr: u32(p + 12), offset: u32(p + 16), size: u32(p + 20), link: u32(p + 24), info: u32(p + 28), entsize: u32(p + 36) };
      if (s.type !== SHT_NOBITS && s.type !== 0) {
        if (s.offset + s.size > bytes.length) fail(`section ${i} runs past the end of the file (truncated)`);
        end = Math.max(end, s.offset + s.size);
      }
      raw.push(s);
    }
    const str = shstrndx < raw.length ? raw[shstrndx] : null;
    if (!str) fail("bad section name table index");
    for (const s of raw) {
      let o = str!.offset + s.nameOff;
      let n = "";
      while (o < str!.offset + str!.size && bytes[o]) n += String.fromCharCode(bytes[o++]);
      s.name = n;
      const { nameOff: _, ...clean } = s;
      sections.push(clean);
    }
  }
  return { bytes, is64, le, type, machine, entry, eflags, ehsize, segments, sections, end };
}

/** Data after everything the headers describe (appended payloads, self-extractors). */
export const elfOverlay = (e: Elf) => Math.max(0, e.bytes.length - e.end);

const DROPPABLE = /^(\.symtab|\.strtab|\.comment|\.debug.*|\.zdebug.*|\.line|\.stab.*|\.gnu_debuglink|\.gnu_debugaltlink|\.note(\..*)?|\.shstrtab|\.gdb_index|\.GCC\.command\.line)$/;

const segKey = (s: ElfSegment) => [s.type, s.flags, s.vaddr, s.paddr, s.filesz, s.memsz, s.align].join(",");

function eq(a: Uint8Array, ao: number, b: Uint8Array, bo: number, n: number): boolean {
  for (let i = 0; i < n; i++) if (a[ao + i] !== b[bo + i]) return false;
  return true;
}

/** Relocations with their symbols resolved to names, so they compare equal when the symbol table is renumbered. */
function relocKeys(e: Elf): string[] {
  const v = dv(e.bytes);
  const out: string[] = [];
  const name = (strtab: ElfSection, o: number) => {
    let s = "";
    for (let p = strtab.offset + o; p < strtab.offset + strtab.size && e.bytes[p]; p++) s += String.fromCharCode(e.bytes[p]);
    return s;
  };
  for (const r of e.sections) {
    if (r.type !== SHT_REL && r.type !== SHT_RELA) continue;
    const symtab = e.sections[r.link];
    const target = e.sections[r.info];
    if (!symtab || symtab.type === 0) {
      out.push(`${target?.name}:nosym`);
      continue;
    }
    const strtab = e.sections[symtab.link];
    const ent = r.entsize || (e.is64 ? (r.type === SHT_RELA ? 24 : 16) : r.type === SHT_RELA ? 12 : 8);
    const symEnt = symtab.entsize || (e.is64 ? 24 : 16);
    for (let p = r.offset; p + ent <= r.offset + r.size; p += ent) {
      let off: number, sym: number, kind: number, add = 0;
      if (e.is64) {
        off = Number(v.getBigUint64(p, e.le));
        const info = v.getBigUint64(p + 8, e.le);
        sym = Number(info >> 32n);
        kind = Number(info & 0xffffffffn);
        if (r.type === SHT_RELA) add = Number(v.getBigInt64(p + 16, e.le));
      } else {
        off = v.getUint32(p, e.le);
        const info = v.getUint32(p + 4, e.le);
        sym = info >>> 8;
        kind = info & 0xff;
        if (r.type === SHT_RELA) add = v.getInt32(p + 8, e.le);
      }
      let sname = "";
      if (sym) {
        const sp = symtab.offset + sym * symEnt;
        if (sp + symEnt > symtab.offset + symtab.size) {
          sname = "?bad";
        } else {
          const nameOff = v.getUint32(sp, e.le);
          const shndx = v.getUint16(sp + (e.is64 ? 6 : 14), e.le);
          const sv = e.is64 ? Number(v.getBigUint64(sp + 8, e.le)) : v.getUint32(sp + 4, e.le);
          sname = nameOff ? name(strtab, nameOff) : shndx && shndx < e.sections.length ? `section:${e.sections[shndx].name}` : "";
          if (!nameOff) sname += `+${sv}`;
        }
      }
      out.push(`${target?.name}:${off}:${kind}:${add}:${sname}`);
    }
  }
  return out;
}

/** true when `b` loads the same thing as `a`: same loadable segments and allocated sections, only symbols, debug and notes gone. */
export function sameElf(a: Elf, b: Elf): true | string {
  if (a.is64 !== b.is64 || a.le !== b.le) return "class or byte order changed";
  if (a.type !== b.type) return "file type changed";
  if (a.machine !== b.machine) return "machine changed";
  if (a.entry !== b.entry) return "entry point changed";
  if (a.eflags !== b.eflags) return "flags changed";
  if (a.segments.length !== b.segments.length) return `segment count ${a.segments.length} became ${b.segments.length}`;
  for (let i = 0; i < a.segments.length; i++) {
    const x = a.segments[i];
    const y = b.segments[i];
    if (segKey(x) !== segKey(y)) return `program header ${i} changed`;
    // the ELF header itself (section table position) legitimately differs
    const skip = x.offset === 0 ? a.ehsize : 0;
    const skipB = y.offset === 0 ? b.ehsize : 0;
    if (skip !== skipB) return `segment ${i} moved`;
    if (!eq(a.bytes, x.offset + skip, b.bytes, y.offset + skip, x.filesz - skip)) return `segment ${i} contents changed`;
  }
  const alloc = (e: Elf) => e.sections.filter((s) => s.index && (s.flags & SHF_ALLOC) !== 0);
  const aa = alloc(a);
  const ab = alloc(b);
  if (aa.length !== ab.length) return "allocated section count changed";
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i];
    const y = ab[i];
    if (x.name !== y.name || x.type !== y.type || x.flags !== y.flags || x.addr !== y.addr || x.size !== y.size) return `section ${x.name} changed`;
    if (x.type !== SHT_NOBITS && !eq(a.bytes, x.offset, b.bytes, y.offset, x.size)) return `section ${x.name} contents changed`;
  }
  const rel = a.type === ET_REL;
  const plain = (e: Elf) => e.sections.filter((s) => s.index && !(s.flags & SHF_ALLOC));
  const bNames = new Set(plain(b).map((s) => s.name));
  const aNames = new Set(plain(a).map((s) => s.name));
  for (const s of plain(b)) if (!aNames.has(s.name)) return `section ${s.name} appeared`;
  for (const s of plain(a)) {
    if (bNames.has(s.name)) continue;
    if (!DROPPABLE.test(s.name)) return `section ${s.name} was removed`;
    // in an object file the symbols are what the linker resolves relocations against
    if (rel && (s.type === SHT_SYMTAB || s.name === ".strtab") && a.sections.some((r) => r.type === SHT_REL || r.type === SHT_RELA)) return "symbols of an object file were removed";
  }
  for (const s of plain(a)) {
    const t = plain(b).find((u) => u.name === s.name);
    if (!t || DROPPABLE.test(s.name) || s.type === SHT_REL || s.type === SHT_RELA) continue;
    if (s.type !== t.type || s.size !== t.size || (s.type !== SHT_NOBITS && !eq(a.bytes, s.offset, b.bytes, t.offset, s.size))) return `section ${s.name} changed`;
  }
  if (rel) {
    const ka = relocKeys(a);
    const kb = relocKeys(b);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return "relocations changed";
  }
  if (elfOverlay(b)) return "the result has data after its sections";
  return true;
}

export interface ArMember {
  name: string;
  data: Uint8Array;
}

export const isAr = (h: Uint8Array) => h.length >= 8 && new TextDecoder().decode(h.subarray(0, 8)) === "!<arch>\n";

/** Members of an `ar` archive with long names resolved; the symbol index and name table are left out (`special`). */
export function parseAr(bytes: Uint8Array): { members: ArMember[]; special: number } {
  if (!isAr(bytes)) throw new Error("bad archive: no signature");
  const text = new TextDecoder("latin1");
  const members: ArMember[] = [];
  let longNames: Uint8Array | null = null;
  let special = 0;
  let p = 8;
  while (p < bytes.length) {
    if (p + 60 > bytes.length) throw new Error("bad archive: truncated header");
    if (bytes[p + 58] !== 0x60 || bytes[p + 59] !== 0x0a) throw new Error("bad archive: bad header magic");
    const raw = text.decode(bytes.subarray(p, p + 16)).trimEnd();
    const sizeText = text.decode(bytes.subarray(p + 48, p + 58)).trim();
    if (!/^\d+$/.test(sizeText)) throw new Error("bad archive: bad size");
    let size = Number(sizeText);
    let dataStart = p + 60;
    let name = raw;
    if (/^#1\/\d+$/.test(raw)) {
      const n = Number(raw.slice(3));
      if (n > size || dataStart + n > bytes.length) throw new Error("bad archive: bad BSD name");
      name = text.decode(bytes.subarray(dataStart, dataStart + n)).replace(/\0+$/, "");
      dataStart += n;
      size -= n;
    }
    if (dataStart + size > bytes.length) throw new Error("bad archive: truncated member (truncated)");
    const data = bytes.subarray(dataStart, dataStart + size);
    if (raw === "//") longNames = data;
    else if (raw === "/" || raw === "/SYM64/" || raw.startsWith("__.SYMDEF")) special++;
    else {
      const m = /^\/(\d+)$/.exec(raw);
      if (m) {
        if (!longNames) throw new Error("bad archive: long name without a name table");
        const o = Number(m[1]);
        let e = o;
        while (e < longNames.length && longNames[e] !== 0x0a) e++;
        name = text.decode(longNames.subarray(o, e)).replace(/\/$/, "");
      } else name = name.replace(/\/$/, "");
      members.push({ name, data });
    }
    p = dataStart + size + (((dataStart + size) & 1) as number);
    if (p > bytes.length + 1) throw new Error("bad archive: truncated");
  }
  return { members, special };
}

/** Same member names and order; ELF members must pass `sameElf`, others must be byte-equal. */
export function sameAr(a: ArMember[], b: ArMember[]): true | string {
  if (a.length !== b.length) return `member count ${a.length} became ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name) return `member ${i} renamed`;
    if (isElf(a[i].data)) {
      let x: Elf, y: Elf;
      try {
        x = parseElf(a[i].data);
        y = parseElf(b[i].data);
      } catch (e: any) {
        return `member ${a[i].name}: ${e?.message ?? e}`;
      }
      const r = sameElf(x, y);
      if (r !== true) return `member ${a[i].name}: ${r}`;
    } else if (a[i].data.length !== b[i].data.length || !eq(a[i].data, 0, b[i].data, 0, a[i].data.length)) return `member ${a[i].name} changed`;
  }
  return true;
}
