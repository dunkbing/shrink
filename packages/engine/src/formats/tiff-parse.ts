// Reads a classic TIFF's directories: enough to refuse what the tools would damage, to catch truncation, and to compare tags.
import { SkipFile } from "../types";

export interface Tag {
  tag: number;
  type: number;
  count: number;
  /** The value bytes (inline or from the offset). */
  value: Uint8Array;
}
export interface Ifd {
  tags: Map<number, Tag>;
}
export interface Tiff {
  little: boolean;
  ifds: Ifd[];
}

const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
const GEO = [33550, 33922, 34264, 34735, 34736, 34737];
/** Pointer-like or layout tags that change when the data is rewritten. */
export const LAYOUT = new Set([259, 273, 278, 279, 317, 322, 323, 324, 325, 347, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521, 530, 531, 292, 293, 266]);
/** Descriptive metadata that stripping may drop. */
export const DESCRIPTIVE = new Set([270, 305, 306, 315, 316, 33432, 700, 33723, 34377, 34665, 34853, 40091, 40092, 40093, 40094, 40095]);

export function parseTiff(b: Uint8Array): Tiff {
  if (b.length < 8) throw new Error("truncated");
  const little = b[0] === 0x49 && b[1] === 0x49;
  if (!little && !(b[0] === 0x4d && b[1] === 0x4d)) throw new Error("not a TIFF");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => v.getUint16(o, little), u32 = (o: number) => v.getUint32(o, little);
  const magic = u16(2);
  if (magic === 43) throw new SkipFile("BigTIFF is not supported");
  if (magic !== 42) throw new Error("bad TIFF magic");
  const ifds: Ifd[] = [];
  const seen = new Set<number>();
  let at = u32(4);
  while (at !== 0) {
    if (seen.has(at) || ifds.length > 4096) throw new Error("directory loop");
    seen.add(at);
    if (at + 2 > b.length) throw new Error("directory outside the file");
    const n = u16(at);
    if (at + 2 + n * 12 + 4 > b.length) throw new Error("truncated directory");
    const tags = new Map<number, Tag>();
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = (SIZES[type] ?? 1) * count;
      if (SIZES[type] === undefined) continue;
      let start = e + 8;
      if (size > 4) {
        start = u32(e + 8);
        if (start + size > b.length) throw new Error(`tag ${tag} outside the file`);
      }
      tags.set(tag, { tag, type, count, value: b.subarray(start, start + size) });
    }
    ifds.push({ tags });
    at = u32(at + 2 + n * 12);
  }
  if (!ifds.length) throw new Error("no image");
  for (const ifd of ifds) {
    const num = (t: number, i = 0) => {
      const g = ifd.tags.get(t);
      if (!g) return undefined;
      const w = SIZES[g.type];
      if (i >= g.count) return undefined;
      const o = g.value.byteOffset + i * w;
      return w === 2 ? v.getUint16(o, little) : w === 4 ? v.getUint32(o, little) : g.value[i];
    };
    for (const t of GEO) if (ifd.tags.has(t)) throw new SkipFile("GeoTIFF is not supported");
    if (ifd.tags.has(330)) throw new SkipFile("TIFF with sub-images (SubIFD)");
    if (ifd.tags.has(37724)) throw new SkipFile("TIFF with Photoshop layers");
    if (ifd.tags.has(50706)) throw new SkipFile("DNG raw file");
    if (!ifd.tags.has(256) || !ifd.tags.has(257)) throw new Error("missing image size");
    // data must lie inside the file
    const offs = ifd.tags.get(273) ?? ifd.tags.get(324), lens = ifd.tags.get(279) ?? ifd.tags.get(325);
    if (!offs || !lens || offs.count !== lens.count) throw new Error("missing strip or tile table");
    for (let i = 0; i < offs.count; i++) {
      const o = num(offs.tag, i)!, l = num(lens.tag, i)!;
      if (o + l > b.length) throw new Error("image data outside the file (truncated)");
    }
  }
  return { little, ifds };
}

/** Number value of a tag in an IFD (first element). */
export function tagNumber(t: Tiff, ifd: number, tag: number): number | undefined {
  const g = t.ifds[ifd].tags.get(tag);
  if (!g) return undefined;
  const dv = new DataView(g.value.buffer, g.value.byteOffset, g.value.byteLength);
  if (g.type === 3) return dv.getUint16(0, t.little);
  if (g.type === 4) return dv.getUint32(0, t.little);
  return g.value[0];
}

/** Do all tags that describe the picture survive? (Layout tags are rebuilt by the writer.) */
export function sameTags(a: Tiff, b: Tiff, keepAll: boolean): true | string {
  if (a.ifds.length !== b.ifds.length) return `page count ${a.ifds.length} became ${b.ifds.length}`;
  for (let i = 0; i < a.ifds.length; i++) {
    for (const [tag, x] of a.ifds[i].tags) {
      if (LAYOUT.has(tag) || tag === 34665 || tag === 34853 || tag === 330) {
        if (!LAYOUT.has(tag) && keepAll && !b.ifds[i].tags.has(tag)) return `page ${i}: tag ${tag} was dropped`;
        continue;
      }
      const y = b.ifds[i].tags.get(tag);
      if (!y) {
        if (!keepAll && DESCRIPTIVE.has(tag)) continue;
        return `page ${i}: tag ${tag} was dropped`;
      }
      if (x.type !== y.type || x.count !== y.count) return `page ${i}: tag ${tag} changed`;
      // byte order may differ between files: compare per element
      const w = SIZES[x.type];
      if (x.type === 5) {
        // libtiff keeps these as floats: the fraction may be written differently, the value must match
        const dx = new DataView(x.value.buffer, x.value.byteOffset, x.value.byteLength), dy = new DataView(y.value.buffer, y.value.byteOffset, y.value.byteLength);
        for (let k = 0; k < x.count; k++) {
          const p = dx.getUint32(k * 8, a.little) / dx.getUint32(k * 8 + 4, a.little), q = dy.getUint32(k * 8, b.little) / dy.getUint32(k * 8 + 4, b.little);
          if (!(Math.abs(p - q) <= 1e-6 * Math.max(1, Math.abs(p))) && !(p === q)) return `page ${i}: tag ${tag} changed`;
        }
        continue;
      }
      const ew = x.type === 5 || x.type === 10 ? 4 : w;
      for (let k = 0; k < (x.count * w) / ew; k++) {
        for (let j = 0; j < ew; j++) {
          const p = a.little ? j : ew - 1 - j, q = b.little ? j : ew - 1 - j;
          if (x.value[k * ew + p] !== y.value[k * ew + q]) return `page ${i}: tag ${tag} changed`;
        }
      }
    }
  }
  return true;
}
