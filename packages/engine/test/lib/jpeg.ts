// JPEG fixtures: encoded with Bun.Image, with metadata segments added by hand.
import { makePng } from "./png";

export async function makeJpeg(o: { width?: number; height?: number; quality?: number; progressive?: boolean; gray?: boolean; seed?: number } = {}): Promise<Uint8Array> {
  const w = o.width ?? 96, h = o.height ?? 64, ch = o.gray ? 1 : 3;
  const data = new Uint8Array(w * h * ch);
  let r = (o.seed ?? 1) * 2654435761;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < ch; c++) {
        r = (r * 1103515245 + 12345) >>> 0;
        data[(y * w + x) * ch + c] = Math.min(255, Math.max(0, (x * 2 + y * 3 + c * 40 + ((r >>> 16) & 31)) & 255));
      }
  const png = makePng({ width: w, height: h, colorType: o.gray ? 0 : 2, bitDepth: 8, data });
  return new Uint8Array(await new Bun.Image(png).jpeg({ quality: o.quality ?? 85, progressive: o.progressive ?? false }).bytes());
}

const u16 = (n: number) => [n >> 8, n & 255];

/** Inserts a segment right after SOI. */
export function addSegment(jpeg: Uint8Array, marker: number, payload: Uint8Array): Uint8Array {
  const seg = new Uint8Array([0xff, marker, ...u16(payload.length + 2), ...payload]);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2));
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

export const comment = (jpeg: Uint8Array, s: string) => addSegment(jpeg, 0xfe, text(s));

/** An EXIF segment with an Orientation tag (and some padding text so there is something to strip). */
export function exif(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  return addSegment(jpeg, 0xe1, cat(text("Exif\0\0"), Uint8Array.from(tiff), text("Camera: Test, padding padding padding padding".repeat(4))));
}

/** An APP2 ICC profile chunk (the profile bytes are not a real profile; the decoder does not read them). */
export const icc = (jpeg: Uint8Array, profile = text("fake-profile-".repeat(40))) => addSegment(jpeg, 0xe2, cat(text("ICC_PROFILE\0"), Uint8Array.from([1, 1]), profile));

export const mpf = (jpeg: Uint8Array) => addSegment(jpeg, 0xe2, cat(text("MPF\0"), new Uint8Array(20)));

/** A JPEG made by mozjpeg's cjpeg from a generated image, for kinds Bun.Image can't write (gray, arithmetic, subsampling, restart markers). */
export async function cjpeg(opts: { gray?: boolean; args?: string[]; width?: number; height?: number } = {}): Promise<Uint8Array | null> {
  const bin = "/opt/homebrew/opt/mozjpeg/bin/cjpeg";
  if (!(await Bun.file(bin).exists())) return null;
  const w = opts.width ?? 128, h = opts.height ?? 96;
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) px.set([(i * 7) & 255, ((i >> 3) * 5) & 255, (i * 3 + (i >> 5)) & 255], i * 3);
  const ppm = Uint8Array.from([...new TextEncoder().encode(`P6\n${w} ${h}\n255\n`), ...px]);
  const p = Bun.spawn([bin, ...(opts.gray ? ["-grayscale"] : []), ...(opts.args ?? [])], { stdin: new Response(ppm), stdout: "pipe", stderr: "ignore" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}
