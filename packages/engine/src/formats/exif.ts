/** The EXIF Orientation tag (1 when absent). */
export function readOrientation(e: Uint8Array): number {
  const v = new DataView(e.buffer, e.byteOffset, e.byteLength);
  const t = e[0] === 0x45 && e[1] === 0x78 ? 6 : 0; // an "Exif\0\0" prefix
  const le = e[t] === 0x49;
  try {
    const ifd = t + v.getUint32(t + 4, le);
    const n = v.getUint16(ifd, le);
    for (let i = 0; i < n; i++) if (v.getUint16(ifd + 2 + i * 12, le) === 0x112) return v.getUint16(ifd + 2 + i * 12 + 8, le);
  } catch {}
  return 1;
}

