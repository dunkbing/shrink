// Test ZIP writer: independent of the engine's reader/builder; can make odd variants on purpose.
import { crc32, deflateRawSync } from "node:zlib";

export interface ZMember {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored, 8 deflate (default 8 at the lowest level so there is something to gain). */
  method?: 0 | 8;
  level?: number;
  descriptor?: boolean;
  utf8?: boolean;
  encrypted?: boolean;
  dosTime?: number;
  dosDate?: number;
  extAttr?: number;
  comment?: string;
}

const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const le = (n: number, bytes: number) => {
  const b = Buffer.alloc(bytes);
  if (bytes === 2) b.writeUInt16LE(n);
  else b.writeUInt32LE(n >>> 0);
  return b;
};

export function makeZip(members: readonly ZMember[], o: { comment?: string; prefix?: Uint8Array; suffix?: Uint8Array; spanned?: boolean; zip64?: boolean; unicodeExtra?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let pos = o.prefix?.length ?? 0;
  if (o.prefix) parts.push(Buffer.from(o.prefix));
  for (const m of members) {
    const raw = Buffer.from(m.data ?? "");
    const isDir = m.name.endsWith("/");
    const method = isDir ? 0 : (m.method ?? 8);
    const comp = method === 8 ? deflateRawSync(raw, { level: m.level ?? 1 }) : raw;
    const name = Buffer.from(m.name, "utf8");
    const flags = (m.utf8 === false ? 0 : 0x800) | (m.descriptor ? 8 : 0) | (m.encrypted ? 1 : 0);
    const crc = crc32(raw);
    const t = m.dosTime ?? 0x6000, d = m.dosDate ?? 0x5821;
    const offset = pos;
    const local = Buffer.concat([le(0x04034b50, 4), le(20, 2), le(flags, 2), le(method, 2), le(t, 2), le(d, 2), le(m.descriptor ? 0 : crc, 4), le(m.descriptor ? 0 : comp.length, 4), le(m.descriptor ? 0 : raw.length, 4), le(name.length, 2), le(0, 2), name]);
    parts.push(local, comp);
    pos += local.length + comp.length;
    if (m.descriptor) {
      const dd = Buffer.concat([le(0x08074b50, 4), le(crc, 4), le(comp.length, 4), le(raw.length, 4)]);
      parts.push(dd);
      pos += dd.length;
    }
    const cm = Buffer.from(m.comment ?? "");
    const z64 = o.zip64 ? Buffer.concat([le(1, 2), le(24, 2), u64(raw.length), u64(comp.length), u64(offset)]) : Buffer.alloc(0);
    const uni = o.unicodeExtra ? Buffer.concat([le(0x7075, 2), le(5 + name.length, 2), Buffer.from([1]), le(0, 4), name]) : Buffer.alloc(0);
    const ex = Buffer.concat([z64, uni]);
    const f32 = (v: number) => (o.zip64 ? 0xffffffff : v);
    central.push(Buffer.concat([le(0x02014b50, 4), le(0x031e, 2), le(o.zip64 ? 45 : 20, 2), le(flags, 2), le(method, 2), le(t, 2), le(d, 2), le(crc, 4), le(f32(comp.length), 4), le(f32(raw.length), 4), le(name.length, 2), le(ex.length, 2), le(cm.length, 2), le(0, 2), le(0, 2), le(m.extAttr ?? (isDir ? 0x41ed0010 : 0x81a40000), 4), le(f32(offset), 4), name, ex, cm]));
  }
  const cd = Buffer.concat(central);
  const comment = Buffer.from(o.comment ?? "");
  parts.push(cd);
  if (o.zip64) {
    const z64pos = pos + cd.length;
    parts.push(Buffer.concat([le(0x06064b50, 4), u64(44), le(45, 2), le(45, 2), le(0, 4), le(0, 4), u64(members.length), u64(members.length), u64(cd.length), u64(pos)]));
    parts.push(Buffer.concat([le(0x07064b50, 4), le(0, 4), u64(z64pos), le(1, 4)]));
  }
  parts.push(Buffer.concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(o.zip64 ? 0xffff : members.length, 2), le(o.zip64 ? 0xffff : members.length, 2), le(o.zip64 ? 0xffffffff : cd.length, 4), le(o.zip64 ? 0xffffffff : pos, 4), le(comment.length, 2), comment]));
  if (o.suffix) parts.push(Buffer.from(o.suffix));
  return Buffer.concat(parts);
}

/** Compressible text, deterministic. */
export const lorem = (n: number, seed = 1) => {
  const words = ["alpha", "beta", "gamma", "delta", "shrink", "archive", "member", "stream", "block", "entry", "deflate", "zopfli"];
  let s = "", x = seed;
  while (s.length < n) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += words[x % words.length] + (x % 7 === 0 ? ".\n" : " ");
  }
  return s.slice(0, n);
};

/** Deterministic incompressible bytes. */
export const noise = (n: number, seed = 7) => {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) (x = (x * 1664525 + 1013904223) >>> 0), (b[i] = x >>> 24);
  return b;
};
