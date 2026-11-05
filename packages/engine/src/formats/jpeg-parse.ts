// Reads a JPEG's structure (not its pixels): size, kind, the metadata segments, and whether it is complete.
import { readOrientation } from "./exif";

export interface JpegInfo {
  width: number;
  height: number;
  precision: number;
  components: number;
  /** SOF marker: 0xC0 baseline, 0xC1 extended, 0xC2 progressive, 0xC3 lossless, 0xC9/0xCA arithmetic... */
  sof: number;
  progressive: boolean;
  scans: number;
  /** The ICC profile (all APP2 chunks joined), if any. */
  icc: Uint8Array | null;
  exif: Uint8Array | null;
  orientation: number;
  /** Adobe APP14 colour transform (0 = RGB/CMYK, 1 = YCbCr, 2 = YCCK), if present. */
  adobe: number | null;
  /** Multi-picture / gain-map data (APP2 "MPF"). */
  multiPicture: boolean;
  /** Bytes after EOI. */
  trailing: number;
  /** Marker codes of the segments before the image data, in order (for tests). */
  markers: number[];
  comments: number;
}

const fail = (m: string): never => {
  throw new Error(m);
};

export function parseJpeg(b: Uint8Array): JpegInfo {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) fail("not a JPEG");
  const info: JpegInfo = { width: 0, height: 0, precision: 0, components: 0, sof: 0, progressive: false, scans: 0, icc: null, exif: null, orientation: 1, adobe: null, multiPicture: false, trailing: 0, markers: [], comments: 0 };
  const icc: { seq: number; data: Uint8Array }[] = [];
  const ascii = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
  let at = 2;
  let eoi = false;
  while (at < b.length) {
    if (b[at] !== 0xff) fail("bad marker");
    while (b[at] === 0xff && at < b.length) at++; // fill bytes
    const m = b[at++];
    if (m === undefined) break;
    if (m === 0xd9) {
      eoi = true;
      info.trailing = b.length - at;
      break;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue;
    if (at + 2 > b.length) fail("truncated");
    const len = (b[at] << 8) | b[at + 1];
    if (len < 2 || at + len > b.length) fail("truncated");
    const d = at + 2, n = len - 2;
    info.markers.push(m);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (n < 6) fail("bad frame header");
      info.sof = m;
      info.precision = b[d];
      info.height = (b[d + 1] << 8) | b[d + 2];
      info.width = (b[d + 3] << 8) | b[d + 4];
      info.components = b[d + 5];
      info.progressive = m === 0xc2 || m === 0xca;
    } else if (m === 0xfe) info.comments++;
    else if (m === 0xe1 && ascii(d, 6) === "Exif\0\0") {
      info.exif = b.subarray(d, d + n);
      info.orientation = readOrientation(info.exif);
    } else if (m === 0xe2 && ascii(d, 12) === "ICC_PROFILE\0") icc.push({ seq: b[d + 12], data: b.subarray(d + 14, d + n) });
    else if (m === 0xe2 && ascii(d, 4) === "MPF\0") info.multiPicture = true;
    else if (m === 0xee && ascii(d, 5) === "Adobe" && n >= 12) info.adobe = b[d + 11];
    at += len;
    if (m === 0xda) {
      info.scans++;
      // entropy-coded data runs until a marker that is not a stuffed zero or a restart
      while (at < b.length && !(b[at] === 0xff && b[at + 1] !== 0 && !(b[at + 1] >= 0xd0 && b[at + 1] <= 0xd7) && b[at + 1] !== 0xff)) at++;
    }
  }
  if (!eoi) fail("no end of image (truncated)");
  if (!info.sof || !info.width || !info.height) fail("no frame header");
  if (info.scans === 0) fail("no image data");
  if (icc.length) info.icc = Buffer.concat(icc.sort((x, y) => x.seq - y.seq).map((c) => c.data));
  return info;
}
