// A WebP's container: which kind it is and what metadata it carries.
import { readOrientation } from "./exif";

export interface WebpInfo {
  width: number;
  height: number;
  lossless: boolean;
  animated: boolean;
  alpha: boolean;
  icc: Uint8Array | null;
  exif: Uint8Array | null;
  xmp: boolean;
  orientation: number;
  chunks: string[];
}

export function parseWebp(b: Uint8Array): WebpInfo {
  if (b.length < 20 || String.fromCharCode(...b.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...b.subarray(8, 12)) !== "WEBP") throw new Error("not a WebP");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riff = v.getUint32(4, true) + 8;
  if (riff > b.length) throw new Error("truncated");
  const info: WebpInfo = { width: 0, height: 0, lossless: false, animated: false, alpha: false, icc: null, exif: null, xmp: false, orientation: 1, chunks: [] };
  let at = 12, image = false;
  while (at + 8 <= riff) {
    const type = String.fromCharCode(...b.subarray(at, at + 4));
    const len = v.getUint32(at + 4, true);
    if (at + 8 + len > riff) throw new Error("truncated");
    const d = b.subarray(at + 8, at + 8 + len);
    info.chunks.push(type);
    if (type === "VP8X") {
      const flags = d[0];
      info.animated = !!(flags & 2);
      info.alpha = !!(flags & 0x10);
      info.width = 1 + (d[4] | (d[5] << 8) | (d[6] << 16));
      info.height = 1 + (d[7] | (d[8] << 8) | (d[9] << 16));
    } else if (type === "VP8L") {
      image = true;
      info.lossless = true;
      if (!info.width) {
        const bits = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
        info.width = (bits & 0x3fff) + 1;
        info.height = ((bits >> 14) & 0x3fff) + 1;
      }
    } else if (type === "VP8 ") {
      image = true;
      if (!info.width && len >= 10) {
        info.width = (d[6] | (d[7] << 8)) & 0x3fff;
        info.height = (d[8] | (d[9] << 8)) & 0x3fff;
      }
    } else if (type === "ANMF") image = true;
    else if (type === "ICCP") info.icc = d;
    else if (type === "EXIF") {
      info.exif = d;
      info.orientation = readOrientation(d);
    } else if (type === "XMP ") info.xmp = true;
    at += 8 + len + (len & 1);
  }
  if (!image) throw new Error("no image data");
  return info;
}
