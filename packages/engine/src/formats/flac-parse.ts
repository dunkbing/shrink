// FLAC metadata reader (STREAMINFO and the block list).
export interface FlacInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: bigint;
  /** Hex MD5 of the unencoded samples as stored (all zeros when the encoder did not know it). */
  md5: string;
  /** Count of metadata blocks per type (0 STREAMINFO, 1 PADDING, 2 APPLICATION, 3 SEEKTABLE, 4 VORBIS_COMMENT, 5 CUESHEET, 6 PICTURE). */
  blocks: Map<number, number>;
  audioStart: number;
}

export const isFlac = (h: Uint8Array) => h[0] === 0x66 && h[1] === 0x4c && h[2] === 0x61 && h[3] === 0x43;

export function parseFlac(b: Uint8Array): FlacInfo {
  if (b.length < 42 || !isFlac(b)) throw new Error("not a FLAC file");
  let pos = 4, info: FlacInfo | null = null;
  const blocks = new Map<number, number>();
  for (let first = true; ; first = false) {
    if (pos + 4 > b.length) throw new Error("metadata is truncated");
    const last = (b[pos] & 0x80) !== 0, type = b[pos] & 0x7f, len = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
    if (type === 127) throw new Error("invalid metadata block type");
    if (first !== (type === 0)) throw new Error(first ? "STREAMINFO is not first" : "more than one STREAMINFO");
    if (pos + 4 + len > b.length) throw new Error("metadata block is truncated");
    blocks.set(type, (blocks.get(type) ?? 0) + 1);
    if (type === 0) {
      if (len !== 34) throw new Error("bad STREAMINFO");
      const o = pos + 4 + 10;
      const sr = (b[o] << 12) | (b[o + 1] << 4) | (b[o + 2] >> 4);
      const channels = ((b[o + 2] >> 1) & 7) + 1;
      const bps = (((b[o + 2] & 1) << 4) | (b[o + 3] >> 4)) + 1;
      const total = (BigInt(b[o + 3] & 15) << 32n) | (BigInt(b[o + 4]) << 24n) | BigInt((b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]);
      const md5 = Buffer.from(b.subarray(o + 8, o + 24)).toString("hex");
      info = { sampleRate: sr, channels, bitsPerSample: bps, totalSamples: total, md5, blocks, audioStart: 0 };
    }
    pos += 4 + len;
    if (last) break;
  }
  if (pos >= b.length) throw new Error("no audio frames");
  info!.audioStart = pos;
  return info!;
}
