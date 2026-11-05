// Small container parsers for the video formats: detection and "is this file whole?" checks.
// Content equality is proved by ffmpeg (video-common.ts), not by these.
import { openSync, readSync, closeSync, fstatSync } from "node:fs";

function readAt(fd: number, pos: number, len: number): Uint8Array {
  const b = new Uint8Array(len);
  const n = readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

// ---- ISO base media (MP4, MOV, 3GP) ----

export interface Mp4Info {
  brand: string;
  fragmented: boolean;
  boxes: string[];
}

/** Walks the top-level boxes: they must tile the file exactly and include `moov`. Throws if damaged. */
export function parseMp4(path: string): Mp4Info {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let pos = 0;
    const boxes: string[] = [];
    let brand = "";
    let fragmented = false;
    while (pos < size) {
      const h = readAt(fd, pos, 16);
      if (h.length < 8) throw new Error("truncated box header");
      let len = dv(h).getUint32(0);
      const type = ascii(h, 4, 4);
      if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) throw new Error(`bad box type at ${pos}`);
      if (len === 1) {
        if (h.length < 16) throw new Error("truncated box header");
        len = Number(dv(h).getBigUint64(8));
      } else if (len === 0) len = size - pos;
      if (len < 8 || pos + len > size) throw new Error(`box '${type}' runs past the end of the file (truncated)`);
      boxes.push(type);
      if (type === "ftyp" && !brand) brand = ascii(readAt(fd, pos + 8, 4), 0, 4);
      if (type === "moof") fragmented = true;
      if (type === "moov" && !fragmented) {
        // an mvex box inside moov marks a fragmented file
        const moov = readAt(fd, pos + 8, Math.min(len - 8, 1 << 20));
        let p = 0;
        while (p + 8 <= moov.length) {
          const l = dv(moov).getUint32(p);
          if (ascii(moov, p + 4, 4) === "mvex") fragmented = true;
          if (l < 8) break;
          p += l;
        }
      }
      pos += len;
    }
    if (!boxes.includes("moov")) throw new Error("no moov box (truncated or not finished)");
    if (!fragmented && !boxes.includes("mdat")) throw new Error("no mdat box");
    return { brand, fragmented, boxes };
  } finally {
    closeSync(fd);
  }
}

const AUDIO_BRANDS = ["M4A ", "M4B ", "M4P ", "M4R "];
const IMAGE_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "avif", "avis", "mif1", "msf1", "mif2", "jxl "];

export function detectMp4(head: Uint8Array, name: string): boolean {
  if (head.length < 12) return false;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["m4a", "m4b", "m4p", "m4r", "heic", "heif", "avif"].includes(ext)) return false;
  const type = ascii(head, 4, 4);
  if (type === "ftyp") {
    const brand = ascii(head, 8, 4);
    return !AUDIO_BRANDS.includes(brand) && !IMAGE_BRANDS.includes(brand);
  }
  return ["mov", "qt"].includes(ext) && ["moov", "mdat", "wide", "free", "skip", "pnot"].includes(type);
}

// ---- Matroska / WebM (EBML) ----

export interface EbmlInfo {
  docType: string;
  docTypeVersion: number;
  /** Segment end if its size is known. */
  segmentEnd: number | null;
}

function vint(b: Uint8Array, p: number, keepMarker: boolean): { value: bigint; len: number; unknown: boolean } | null {
  if (p >= b.length) return null;
  const first = b[p];
  if (first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (p + len > b.length) return null;
  let v = BigInt(keepMarker ? first : first & (0xff >> len));
  let allOnes = (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = (v << 8n) | BigInt(b[p + i]);
    if (b[p + i] !== 0xff) allOnes = false;
  }
  return { value: v, len, unknown: allOnes };
}

export function parseEbml(head: Uint8Array): EbmlInfo | null {
  if (head.length < 8 || head[0] !== 0x1a || head[1] !== 0x45 || head[2] !== 0xdf || head[3] !== 0xa3) return null;
  const size = vint(head, 4, false);
  if (!size) return null;
  let p = 4 + size.len;
  const end = Math.min(head.length, p + Number(size.value));
  let docType = "";
  let docTypeVersion = 1;
  while (p < end) {
    const id = vint(head, p, true);
    if (!id) break;
    const sz = vint(head, p + id.len, false);
    if (!sz) break;
    const data = p + id.len + sz.len;
    const n = Number(sz.value);
    if (data + n > head.length) break;
    if (id.value === 0x4282n) docType = ascii(head, data, n);
    else if (id.value === 0x4287n) {
      docTypeVersion = 0;
      for (let i = 0; i < n; i++) docTypeVersion = docTypeVersion * 256 + head[data + i];
    }
    p = data + n;
  }
  // the Segment follows the header
  let segmentEnd: number | null = null;
  const sid = vint(head, p, true);
  if (sid && sid.value === 0x18538067n) {
    const ss = vint(head, p + sid.len, false);
    if (ss && !ss.unknown) segmentEnd = p + sid.len + ss.len + Number(ss.value);
  }
  return { docType, docTypeVersion, segmentEnd };
}

export const detectMatroska = (head: Uint8Array, name: string) => {
  const info = parseEbml(head);
  if (!info || (info.docType !== "matroska" && info.docType !== "webm")) return false;
  return !/\.(mka|weba)$/i.test(name);
};

/** Throws if the Segment claims more bytes than the file holds. */
export function checkMatroskaWhole(path: string, size: number): EbmlInfo {
  const fd = openSync(path, "r");
  try {
    const info = parseEbml(readAt(fd, 0, 4096));
    if (!info) throw new Error("not a Matroska file");
    if (info.segmentEnd !== null && info.segmentEnd > size) throw new Error("the Segment runs past the end of the file (truncated)");
    return info;
  } finally {
    closeSync(fd);
  }
}

// ---- Ogg ----

/** The head holds the first pages: is a Theora stream announced? */
export function oggHasTheora(head: Uint8Array): boolean {
  if (ascii(head, 0, 4) !== "OggS") return false;
  let p = 0;
  while (p + 27 <= head.length && ascii(head, p, 4) === "OggS") {
    const type = head[p + 5];
    if (!(type & 2)) return false; // past the BOS pages
    const nseg = head[p + 26];
    if (p + 27 + nseg > head.length) return false;
    let body = 0;
    for (let i = 0; i < nseg; i++) body += head[p + 27 + i];
    const d = p + 27 + nseg;
    if (head[d] === 0x80 && ascii(head, d + 1, 6) === "theora") return true;
    p = d + body;
  }
  return false;
}

/** Throws if the last page is cut or does not end its stream. */
export function checkOggWhole(path: string): void {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 70000);
    const tail = readAt(fd, size - tailLen, tailLen);
    let last = -1;
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && ascii(tail, i, 4) === "OggS") {
        const nseg = tail[i + 26];
        if (i + 27 + nseg > tail.length) continue;
        let body = 0;
        for (let k = 0; k < nseg; k++) body += tail[i + 27 + k];
        if (i + 27 + nseg + body === tail.length) {
          last = i;
          break;
        }
        // a page that does not end at the file end: keep looking back for one that does
      }
    }
    if (last < 0) throw new Error("the last Ogg page is cut (truncated)");
    if (!(tail[last + 5] & 4)) throw new Error("the last Ogg page does not end the stream (truncated)");
  } finally {
    closeSync(fd);
  }
}

// ---- AVI, FLV, MPEG ----

export const detectAvi = (h: Uint8Array) => ascii(h, 0, 4) === "RIFF" && ascii(h, 8, 4) === "AVI ";
export const detectFlv = (h: Uint8Array) => ascii(h, 0, 3) === "FLV" && h[3] === 1;
/** MPEG program stream: pack start code, then the MPEG-1 (0010) or MPEG-2 (01) marker. */
export const detectMpegPs = (h: Uint8Array) => h.length >= 14 && h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0xba && ((h[4] & 0xf0) === 0x20 || (h[4] & 0xc0) === 0x40);

export function checkAviWhole(path: string): void {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const h = readAt(fd, 0, 12);
    const riff = dv(h).getUint32(4, true) + 8;
    if (riff > size) throw new Error("the RIFF chunk runs past the end of the file (truncated)");
  } finally {
    closeSync(fd);
  }
}

/** Walks the tag chain: it must end exactly at the file end. */
export function checkFlvWhole(path: string): void {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const h = readAt(fd, 0, 9);
    let pos = dv(h).getUint32(5) + 4;
    while (pos < size) {
      const t = readAt(fd, pos, 11);
      if (t.length < 11) throw new Error("truncated FLV tag header");
      const len = (t[1] << 16) | (t[2] << 8) | t[3];
      pos += 11 + len + 4;
    }
    if (pos !== size) throw new Error("truncated FLV tag");
  } finally {
    closeSync(fd);
  }
}
