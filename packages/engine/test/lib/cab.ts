// Test cabinet writer, independent of the engine's reader: stored or MSZIP folders in 32 KiB blocks.
import { deflateRawSync } from "node:zlib";

export interface CabIn {
  name: string;
  data: Uint8Array | string;
}
export interface CabFolderIn {
  files: CabIn[];
  /** 0 stored, 1 MSZIP (default). */
  type?: 0 | 1;
  level?: number;
  /** MSZIP blocks use the previous block as a dictionary (like makecab). */
  history?: boolean;
}

function sum(data: Uint8Array, seed = 0): number {
  let c = seed >>> 0, i = 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (; i + 4 <= data.length; i += 4) c = (c ^ dv.getUint32(i, true)) >>> 0;
  let t = 0;
  for (let k = data.length - 1, s = 0; k >= i; k--, s += 8) t |= data[k] << s;
  return (c ^ t) >>> 0;
}

export function makeCab(folders: CabFolderIn[], o: { flags?: number } = {}): Buffer {
  const fileRecs: Buffer[] = [];
  const blocks: Buffer[][] = [];
  folders.forEach((f, fi) => {
    const datas = f.files.map((x) => Buffer.from(x.data));
    let off = 0;
    f.files.forEach((x, i) => {
      const r = Buffer.alloc(16 + x.name.length + 1);
      r.writeUInt32LE(datas[i].length, 0);
      r.writeUInt32LE(off, 4);
      r.writeUInt16LE(fi, 8);
      r.writeUInt16LE(0x2c21, 10); // 1996-01-01
      r.writeUInt16LE(0x6000, 12); // 12:00:00
      r.writeUInt16LE(0x20, 14);
      r.write(x.name, 16, "latin1");
      fileRecs.push(r);
      off += datas[i].length;
    });
    const all = Buffer.concat(datas);
    const recs: Buffer[] = [];
    for (let p = 0; p < all.length || p === 0; p += 32768) {
      const raw = all.subarray(p, p + 32768);
      const dict = f.history && p > 0 ? all.subarray(Math.max(0, p - 32768), p) : undefined;
      const body = f.type === 0 ? raw : Buffer.concat([Buffer.from("CK"), deflateRawSync(raw, { level: f.level ?? 1, dictionary: dict })]);
      const r = Buffer.alloc(8 + body.length);
      r.writeUInt16LE(body.length, 4);
      r.writeUInt16LE(raw.length, 6);
      r.set(body, 8);
      r.writeUInt32LE(sum(r.subarray(4, 8), sum(body)), 0);
      recs.push(r);
    }
    blocks.push(recs);
  });
  const files = Buffer.concat(fileRecs);
  const coffFiles = 36 + 8 * folders.length;
  let start = coffFiles + files.length;
  const folderRecs = folders.map((f, i) => {
    const r = Buffer.alloc(8);
    r.writeUInt32LE(start, 0);
    r.writeUInt16LE(blocks[i].length, 4);
    r.writeUInt16LE(f.type ?? 1, 6);
    start += blocks[i].reduce((s, b) => s + b.length, 0);
    return r;
  });
  const h = Buffer.alloc(36);
  h.write("MSCF", 0);
  h.writeUInt32LE(start, 8);
  h.writeUInt32LE(coffFiles, 16);
  h[24] = 3;
  h[25] = 1;
  h.writeUInt16LE(folders.length, 26);
  h.writeUInt16LE(fileRecs.length, 28);
  h.writeUInt16LE(o.flags ?? 0, 30);
  return Buffer.concat([h, ...folderRecs, files, ...blocks.flat()]);
}
