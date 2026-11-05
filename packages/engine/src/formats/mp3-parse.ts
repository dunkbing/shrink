// MPEG audio frame headers and tag regions (ID3v2 at the start, ID3v1 / APE at the end).

const V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES = [44100, 48000, 32000];

/** Length in bytes of the frame whose header is at `o`, or 0 if it is not a valid fixed-bitrate frame header. */
export function frameLength(b: Uint8Array, o: number): number {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return 0;
  const ver = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3, bi = b[o + 2] >> 4, si = (b[o + 2] >> 2) & 3, pad = (b[o + 2] >> 1) & 1;
  if (ver === 1 || layer === 0 || bi === 0 || bi === 15 || si === 3) return 0;
  const v1 = ver === 3;
  const table = layer === 3 ? (v1 ? V1_L1 : V2_L1) : v1 ? (layer === 2 ? V1_L2 : V1_L3) : V2_L23;
  const rate = RATES[si] >> (ver === 2 ? 1 : ver === 0 ? 2 : 0);
  const br = table[bi] * 1000;
  if (layer === 3) return (Math.floor((12 * br) / rate) + pad) * 4;
  return Math.floor(((layer === 1 && !v1 ? 72 : 144) * br) / rate) + pad;
}

/** Do `n` frames follow each other from `o` (fewer only when the data ends)? */
export function frameChain(b: Uint8Array, o: number, n: number): boolean {
  for (let i = 0; i < n; i++) {
    if (o >= b.length) return i >= 1;
    const len = frameLength(b, o);
    if (!len) return false;
    o += len;
  }
  return true;
}

/** Size of an ID3v2 tag at `o` (header, body and footer), or 0. */
export function id3v2Size(b: Uint8Array, o: number): number {
  if (o + 10 > b.length || b[o] !== 0x49 || b[o + 1] !== 0x44 || b[o + 2] !== 0x33 || b[o + 3] === 0xff || b[o + 4] === 0xff) return 0;
  if ([6, 7, 8, 9].some((i) => b[o + i] & 0x80)) return 0;
  const size = (b[o + 6] << 21) | (b[o + 7] << 14) | (b[o + 8] << 7) | b[o + 9];
  const total = 10 + size + (b[o + 5] & 0x10 ? 10 : 0);
  return o + total <= b.length ? total : 0;
}

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** The audio region [start, end) with the leading tags, junk before the first frame and trailing ID3v1/APE tags removed. */
export function audioRegion(b: Uint8Array, stripJunk: boolean): { tagEnd: number; start: number; end: number; tagBytes: Uint8Array[] } {
  let start = 0, end = b.length;
  const tagBytes: Uint8Array[] = [];
  for (let t; (t = id3v2Size(b, start)); start += t) tagBytes.push(b.subarray(start, start + t));
  for (let again = true; again; ) {
    again = false;
    if (end - start >= 128 && ascii(b, end - 128, 3) === "TAG") {
      if (end - start >= 355 && ascii(b, end - 355, 4) === "TAG+") (end -= 355), tagBytes.push(b.subarray(end, end + 355));
      else (end -= 128), tagBytes.push(b.subarray(end, end + 128));
      again = true;
    }
    if (end - start >= 32 && ascii(b, end - 32, 8) === "APETAGEX") {
      const dv = new DataView(b.buffer, b.byteOffset + end - 32, 32);
      const size = dv.getUint32(12, true), flags = dv.getUint32(20, true);
      const total = size + (flags & 0x80000000 ? 32 : 0);
      if (size >= 32 && total <= end - start) (end -= total), tagBytes.push(b.subarray(end, end + total)), (again = true);
    }
  }
  const tagEnd = start;
  if (stripJunk && !frameLength(b, start)) {
    // Junk is dropped only when a long run of frames starts right after it.
    for (let p = start + 1; p < Math.min(end, start + 65536); p++) {
      if (b[p] === 0xff && frameLength(b, p) && frameChain(b.subarray(0, end), p, 20)) {
        start = p;
        break;
      }
    }
  }
  return { tagEnd, start, end, tagBytes };
}
