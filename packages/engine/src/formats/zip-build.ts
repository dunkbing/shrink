// Rebuilds a ZIP from a parsed one with new member data: same names, order, flags, attributes, comments.
import { deflateRawSync } from "node:zlib";
import type { Zip, ZipEntry } from "./zip-parse";

const w16 = (v: number) => Uint8Array.of(v & 255, (v >> 8) & 255);
const w32 = (v: number) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
const r16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

/** Drops the zip64 extra block (ids are rewritten only when needed, which this builder does not support). */
function noZip64(extra: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let q = 0; q + 4 <= extra.length; ) {
    const len = r16(extra, q + 2);
    if (r16(extra, q) !== 1) parts.push(extra.subarray(q, q + 4 + len));
    q += 4 + len;
  }
  return Buffer.concat(parts);
}

export interface NewMember {
  /** 0 stored, 8 deflate. */
  method: number;
  /** The bytes as stored in the archive (compressed for method 8). */
  data: Uint8Array;
}

/** `members[i]` replaces entry i's data. Throws if the result would need zip64. */
export function buildZip(z: Zip, members: NewMember[]): Uint8Array {
  const out: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => (out.push(b), (pos += b.length));
  z.entries.forEach((e: ZipEntry, i) => {
    const m = members[i];
    const lnl = r16(z.bytes, e.offset + 26), lel = r16(z.bytes, e.offset + 28);
    const localExtra = noZip64(z.bytes.subarray(e.offset + 30 + lnl, e.offset + 30 + lnl + lel));
    const flags = e.flags & ~8;
    const version = m.method === 8 ? 20 : 10;
    const offset = pos;
    if (offset > 0xfffffffe || m.data.length > 0xfffffffe || e.size > 0xfffffffe) throw new Error("needs zip64");
    push(Buffer.concat([w32(0x04034b50), w16(version), w16(flags), w16(m.method), w16(e.dosTime), w16(e.dosDate), w32(e.crc), w32(m.data.length), w32(e.size), w16(e.nameBytes.length), w16(localExtra.length), e.nameBytes, localExtra]));
    push(m.data);
    const cextra = noZip64(e.extra);
    central.push(Buffer.concat([w32(0x02014b50), w16(e.versionMadeBy), w16(version), w16(flags), w16(m.method), w16(e.dosTime), w16(e.dosDate), w32(e.crc), w32(m.data.length), w32(e.size), w16(e.nameBytes.length), w16(cextra.length), w16(e.comment.length), w16(0), w16(0), w32(e.extAttr), w32(offset), e.nameBytes, cextra, e.comment]));
  });
  const cd = Buffer.concat(central);
  if (z.entries.length > 0xfffe || pos + cd.length > 0xfffffffe) throw new Error("needs zip64");
  const cdOff = pos;
  push(cd);
  push(Buffer.concat([w32(0x06054b50), w16(0), w16(0), w16(z.entries.length), w16(z.entries.length), w32(cd.length), w32(cdOff), w16(z.comment.length), z.comment]));
  return Buffer.concat(out);
}

/** Smallest of: stored, the current form, deflate level 9. Names that must stay stored (`mimetype`) are never compressed. */
export function bestDeflate(raw: Uint8Array, current: NewMember, mustStore: boolean): NewMember {
  if (mustStore) return { method: 0, data: raw };
  let best = current;
  if (raw.length === 0) return best;
  const d = deflateRawSync(raw, { level: 9, memLevel: 9 });
  if (d.length < best.data.length) best = { method: 8, data: d };
  if (raw.length < best.data.length) best = { method: 0, data: raw };
  return best;
}
