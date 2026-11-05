// Strict single-member gzip reader and writer.
import { crc32, inflateRawSync } from "node:zlib";
import { SkipFile } from "../types";

export interface Gzip {
  flags: number;
  mtime: number;
  xfl: number;
  os: number;
  name: Uint8Array | null;
  comment: Uint8Array | null;
  extra: Uint8Array | null;
  /** The header exactly as stored. */
  header: Uint8Array;
  /** The raw deflate stream. */
  payload: Uint8Array;
  data: Uint8Array;
}

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Output cap for inflating: a bomb is skipped, not allocated. */
const MAX_OUT = 2 ** 29;

export function parseGzip(b: Uint8Array): Gzip {
  if (b.length > MAX_OUT) throw new SkipFile("larger than 1 GiB");
  if (b.length < 18) throw new Error("too small for gzip");
  if (b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw new Error("not a gzip member");
  const flags = b[3];
  if (flags & 0xe0) throw new Error("reserved flags set");
  let p = 10, extra: Uint8Array | null = null, name: Uint8Array | null = null, comment: Uint8Array | null = null;
  const cstr = () => {
    const s = p;
    while (p < b.length && b[p] !== 0) p++;
    if (p >= b.length) throw new Error("header runs past the end");
    return b.subarray(s, p++);
  };
  if (flags & 4) {
    const l = b[p] | (b[p + 1] << 8);
    p += 2;
    if (p + l > b.length) throw new Error("extra field runs past the end");
    extra = b.subarray(p, p + l);
    p += l;
  }
  if (flags & 8) name = cstr();
  if (flags & 16) comment = cstr();
  if (flags & 2) {
    if (p + 2 > b.length) throw new Error("header runs past the end");
    const want = crc32(b.subarray(0, p)) & 0xffff;
    if (want !== (b[p] | (b[p + 1] << 8))) throw new Error("header CRC mismatch");
    p += 2;
  }
  if (p + 8 > b.length) throw new Error("truncated");
  const trailer = b.length - 8;
  let data: Buffer;
  let used = 0;
  try {
    const r: any = inflateRawSync(b.subarray(p, trailer), { info: true, maxOutputLength: MAX_OUT });
    data = r.buffer;
    used = r.engine.bytesWritten;
  } catch (e: any) {
    if (e?.code === "ERR_BUFFER_TOO_LARGE" || /larger than|too large/i.test(String(e?.message))) throw new SkipFile("zip bomb (more than 512 MiB uncompressed)");
    throw new Error(`cannot inflate: ${e?.message ?? e}`);
  }
  if (p + used !== trailer) {
    // the stream ended early: more data follows (another member, padding or junk)
    throw new SkipFile(b[p + used + 8] === 0x1f && b[p + used + 9] === 0x8b ? "multi-member gzip" : "data after the gzip member");
  }
  if (u32(b, trailer) !== crc32(data)) throw new Error("CRC mismatch");
  if (u32(b, trailer + 4) !== data.length >>> 0) throw new Error("size mismatch");
  return { flags, mtime: u32(b, 4), xfl: b[8], os: b[9], name, comment, extra, header: b.subarray(0, p), payload: b.subarray(p, trailer), data };
}

/** A gzip member from a raw deflate stream; the header is kept as given, or a bare one is written. */
export function wrapGzip(payload: Uint8Array, data: Uint8Array, header?: Uint8Array): Uint8Array {
  const h = header ?? Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255);
  const t = Buffer.alloc(8);
  t.writeUInt32LE(crc32(data), 0);
  t.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([h, payload, t]);
}
