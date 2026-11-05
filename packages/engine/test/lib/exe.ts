import { peChecksum } from "../../src/formats/pe-parse";
// Writers for small PE, ELF and ar files used by the executable tests (no compiler for those targets is needed).
const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64 = (n: number) => [...u32(n % 2 ** 32), ...u32(Math.floor(n / 2 ** 32))];
const cat = (...parts: (number[] | Uint8Array)[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const pad = (b: Uint8Array | number[], n: number) => cat(b, new Uint8Array(Math.max(0, n - b.length)));
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export interface PeOpts {
  /** DWARF-style debug section (removable). */
  debugSection?: boolean;
  /** COFF symbol table with this many symbols at the end of the file. */
  symbols?: number;
  /** Bytes appended after everything (installer payload). */
  overlay?: number;
  signed?: boolean;
  dotnet?: boolean;
  /** Fill the header checksum. */
  checksum?: boolean;
  /** Zero slack the file carries at the end of .text's raw data (rawSize larger than the virtual size). */
  textRaw?: number;
}

export function makePe(o: PeOpts = {}): Uint8Array {
  const textRaw = o.textRaw ?? 0x200;
  const sections = [
    { name: ".text", vsize: 0x10, vaddr: 0x1000, raw: pad([0x31, 0xc0, 0xc3, ...ascii("shrink-text-content")], textRaw), chars: 0x60000020 },
    { name: ".data", vsize: 0x40, vaddr: 0x2000, raw: pad(ascii("DATA".repeat(8)), 0x200), chars: 0xc0000040 },
  ];
  if (o.debugSection) sections.push({ name: "/4", vsize: 0x400, vaddr: 0x3000, raw: pad(ascii("dwarf-debug-info ".repeat(60)), 0x400), chars: 0x42000040 });
  const optSize = 240;
  const headersEnd = 0x80 + 4 + 20 + optSize + sections.length * 40;
  const sizeOfHeaders = Math.ceil(headersEnd / 0x200) * 0x200;
  let ptr = sizeOfHeaders;
  const placed = sections.map((s) => {
    const p = { ...s, ptr };
    ptr += s.raw.length;
    return p;
  });
  const dirs = new Array(16 * 2).fill(0);
  if (o.signed) (dirs[8] = ptr), (dirs[9] = 0x100);
  if (o.dotnet) (dirs[28] = 0x2000), (dirs[29] = 0x48);
  const symPtr = o.symbols ? ptr : 0;
  const imageSize = 0x1000 + sections.length * 0x1000;
  const file = [
    ...pad([0x4d, 0x5a, ...new Array(0x3a).fill(0), ...u32(0x80)], 0x80),
    ...ascii("PE\0\0"),
    ...u16(0x8664), ...u16(sections.length), ...u32(0x5f000000), ...u32(symPtr), ...u32(o.symbols ?? 0), ...u16(optSize), ...u16(0x22),
    ...u16(0x20b), 14, 0, ...u32(0x200), ...u32(0x200), 0, 0, 0, 0, ...u32(0x1000), ...u32(0x1000),
    ...u64(0x140000000), ...u32(0x1000), ...u32(0x200), ...u16(6), ...u16(0), ...u16(0), ...u16(0), ...u16(6), ...u16(0), ...u32(0),
    ...u32(imageSize), ...u32(sizeOfHeaders), ...u32(0), ...u16(3), ...u16(0x8160),
    ...u64(0x100000), ...u64(0x1000), ...u64(0x100000), ...u64(0x1000), ...u32(0), ...u32(16),
    ...dirs.flatMap(u32),
  ];
  const head = cat(file, ...placed.map((s) => cat(pad(ascii(s.name), 8), u32(s.vsize), u32(s.vaddr), u32(s.raw.length), u32(s.ptr), u32(0), u32(0), u16(0), u16(0), u32(s.chars))));
  const parts: Uint8Array[] = [pad(head, sizeOfHeaders), ...placed.map((s) => s.raw)];
  if (o.symbols) {
    const sym = new Uint8Array(o.symbols * 18);
    for (let i = 0; i < o.symbols; i++) sym.set([...pad(ascii(`sym${i}`), 8), ...u32(i), ...u16(1), ...u16(0), 2, 0], i * 18);
    const strs = ascii("a_long_symbol_name_in_the_string_table\0".repeat(20));
    parts.push(sym, cat(u32(strs.length + 4), strs));
  }
  if (o.signed) parts.push(new Uint8Array(0x100).fill(7));
  if (o.overlay) parts.push(new Uint8Array(o.overlay).fill(0x5a));
  let out = cat(...parts);
  if (o.checksum) {
    const at = 0x80 + 4 + 20 + 64;
    new DataView(out.buffer).setUint32(at, peChecksum(out, at), true);
  }
  return out;
}

export interface ElfOpts {
  /** Relocatable object (with a relocation against an undefined symbol) instead of an executable. */
  rel?: boolean;
  debug?: boolean;
  /** Bytes appended after the section headers. */
  overlay?: number;
  /** A name for the undefined symbol the relocation uses. */
  extern?: string;
}

/** A tiny x86-64 ELF: an executable (one PT_LOAD) or a relocatable object. */
export function makeElf(o: ElfOpts = {}): Uint8Array {
  const code = new Uint8Array([0xb8, 0x3c, 0, 0, 0, 0x31, 0xff, 0x0f, 0x05]);
  const strtab = cat([0], ascii("_start\0"), ascii((o.extern ?? "external_fn") + "\0"), ascii("local_helper_name\0"));
  const symtab = cat(
    new Uint8Array(24),
    [...u32(0), 3, 0, ...u16(1), ...u64(0), ...u64(0)], // section symbol for .text
    [...u32(1), 0x12, 0, ...u16(1), ...u64(0), ...u64(code.length)], // _start
    [...u32(8), 0x10, 0, ...u16(0), ...u64(0), ...u64(0)], // undefined extern
    [...u32(20), 0x02, 0, ...u16(1), ...u64(0), ...u64(0)], // local
  );
  const comment = ascii("GCC: (made by the test writer) 1.0\0");
  const debug = o.debug === false ? new Uint8Array(0) : new Uint8Array(ascii("debug info ".repeat(300)));
  const names = ["", ".text", ".comment", ".debug_info", ".symtab", ".strtab", ".shstrtab"];
  if (o.rel) names.splice(2, 0, ".rela.text");
  const shstr = cat([0], ...names.slice(1).map((n) => ascii(n + "\0")));
  const nameOff: Record<string, number> = {};
  let p = 1;
  for (const n of names.slice(1)) ((nameOff[n] = p), (p += n.length + 1));

  const exec = !o.rel;
  const textOff = exec ? 64 + 56 : 64;
  let cur = textOff + code.length;
  const place = (len: number) => {
    const at = cur;
    cur += len;
    return at;
  };
  const rela = o.rel ? cat([...u64(1), ...u32(2), ...u32(3), ...u64(0)]) : new Uint8Array(0);
  const body: Record<string, { off: number; data: Uint8Array }> = {};
  for (const [n, d] of [[".rela.text", rela], [".comment", new Uint8Array(comment)], [".debug_info", debug], [".symtab", symtab], [".strtab", strtab], [".shstrtab", shstr]] as [string, Uint8Array][]) {
    if (!names.includes(n)) continue;
    body[n] = { off: place(d.length), data: d };
  }
  const shoff = Math.ceil(cur / 8) * 8;
  const sh = (name: string, type: number, flags: number, addr: number, off: number, size: number, link = 0, info = 0, align = 1, ent = 0) =>
    [...u32(nameOff[name] ?? 0), ...u32(type), ...u64(flags), ...u64(addr), ...u64(off), ...u64(size), ...u32(link), ...u32(info), ...u64(align), ...u64(ent)];
  const rows: number[][] = [new Array(64).fill(0), sh(".text", 1, 6, exec ? 0x400000 + textOff : 0, textOff, code.length, 0, 0, 16)];
  const idx = (n: string) => names.indexOf(n);
  for (const n of names.slice(2)) {
    const b = body[n];
    if (n === ".rela.text") rows.push(sh(n, 4, 0x40, 0, b.off, b.data.length, idx(".symtab"), 1, 8, 24));
    else if (n === ".symtab") rows.push(sh(n, 2, 0, 0, b.off, b.data.length, idx(".strtab"), 3, 8, 24));
    else if (n === ".strtab" || n === ".shstrtab") rows.push(sh(n, 3, 0, 0, b.off, b.data.length));
    else rows.push(sh(n, 1, 0, 0, b.off, b.data.length));
  }
  const ehdr = [
    0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...new Array(8).fill(0), ...u16(exec ? 2 : 1), ...u16(62), ...u32(1), ...u64(exec ? 0x400000 + textOff : 0),
    ...u64(exec ? 64 : 0), ...u64(shoff), ...u32(0), ...u16(64), ...u16(exec ? 56 : 0), ...u16(exec ? 1 : 0), ...u16(64), ...u16(rows.length), ...u16(names.indexOf(".shstrtab")),
  ];
  const phdr = exec ? [...u32(1), ...u32(5), ...u64(0), ...u64(0x400000), ...u64(0x400000), ...u64(textOff + code.length), ...u64(textOff + code.length), ...u64(0x1000)] : [];
  const parts = [ehdr, phdr, Array.from(code)] as (number[] | Uint8Array)[];
  for (const n of Object.keys(body)) parts.push(body[n].data);
  let out = cat(...parts);
  out = cat(pad(out, shoff), ...rows);
  if (o.overlay) out = cat(out, new Uint8Array(o.overlay).fill(0x41));
  return out;
}

/** An `ar` archive; names longer than 15 characters go through a GNU `//` table. */
export function makeAr(members: { name: string; data: Uint8Array }[]): Uint8Array {
  const long = members.filter((m) => m.name.length > 15);
  let table = "";
  const offs = new Map<string, number>();
  for (const m of long) (offs.set(m.name, table.length), (table += m.name + "/\n"));
  const hdr = (name: string, size: number) => ascii(name.padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) + "100644".padEnd(8) + String(size).padEnd(10) + "`\n");
  const parts: (number[] | Uint8Array)[] = [ascii("!<arch>\n")];
  const member = (name: string, data: Uint8Array) => parts.push(hdr(name, data.length), data, data.length & 1 ? [0x0a] : []);
  if (long.length) member("//", new Uint8Array(ascii(table)));
  for (const m of members) member(m.name.length > 15 ? `/${offs.get(m.name)}` : m.name + "/", m.data);
  return cat(...parts);
}

export { cat };
