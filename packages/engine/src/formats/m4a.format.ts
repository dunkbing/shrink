import type { Context, Format, Settings, Step } from "../types";
import { audioSig, sameAudio, type AudioSig } from "./audio-oracle";

const BRANDS = ["M4A ", "M4B ", "M4P ", "M4R ", "F4A ", "F4B "];
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** The top-level box named `name`, as [data start, end). */
function findBox(b: Uint8Array, name: string): [number, number] | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 0; p + 8 <= b.length; ) {
    let size = dv.getUint32(p), hdr = 8;
    if (size === 1 && p + 16 <= b.length) (size = Number(dv.getBigUint64(p + 8))), (hdr = 16);
    else if (size === 0) size = b.length - p;
    if (size < hdr) return null;
    if (ascii(b, p + 4, 4) === name) return [p + hdr, Math.min(p + size, b.length)];
    p += size;
  }
  return null;
}

const ffmpegArgs = (input: string, output: string, ctx: Context, keep: boolean, brand: string | null) => [
  "-v", "error", "-nostdin", "-y", "-i", input,
  ...(keep ? ["-map", "0", "-map_metadata", "0"] : ["-map", "0:a", "-map_metadata", "-1"]),
  "-map_chapters", "0", "-dn", "-c", "copy", "-fflags", "+bitexact", "-flags:a", "+bitexact",
  "-movflags", "+faststart", ...(brand ? ["-brand", brand] : []), "-f", "ipod", output,
];

async function remux(input: string, output: string, ctx: Context, keep: boolean) {
  const head = new Uint8Array(await Bun.file(input).slice(0, 12).arrayBuffer());
  const brand = ascii(head, 8, 4);
  const r = await ctx.run("ffmpeg", ffmpegArgs(input, output, ctx, keep, brand.length === 4 ? brand : null));
  if (r.code !== 0) throw new Error(`ffmpeg exited with ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
}

const steps: Step[] = [
  {
    id: "m4a.remux",
    tool: "ffmpeg",
    async run(input, output, ctx) {
      await remux(input, output, ctx, true);
    },
  },
  {
    id: "m4a.strip",
    tool: "ffmpeg",
    strip: true,
    async run(input, output, ctx) {
      await remux(input, output, ctx, false);
    },
  },
];

export const m4a: Format = {
  id: "m4a",
  extensions: ["m4a", "m4b", "m4p", "m4r"],
  detect: (h, name) => ascii(h, 4, 4) === "ftyp" && (BRANDS.includes(ascii(h, 8, 4)) || /\.(m4a|m4b|m4p|m4r)$/i.test(name)),
  flags: (s: Settings) => ({ keepMetadata: s.audio.keepMetadata }),
  async skip(path, head) {
    if (ascii(head, 8, 4) === "M4P ") return "DRM protected";
    const b = new Uint8Array(await Bun.file(path).arrayBuffer());
    const moov = findBox(b, "moov");
    if (!moov) return null; // prepare reports the damage
    const m = Buffer.from(b.subarray(moov[0], moov[1]));
    for (const w of ["drms", "drmi", "sinf", "enca", "encv"]) if (m.includes(w)) return "DRM or encrypted";
    for (let i = m.indexOf("hdlr"); i >= 0; i = m.indexOf("hdlr", i + 4)) if (m.toString("latin1", i + 12, i + 16) === "vide") return "video stream";
    return null;
  },
  steps,
  oracle: {
    async prepare(path, ctx): Promise<AudioSig> {
      const b = new Uint8Array(await Bun.file(path).arrayBuffer());
      if (!findBox(b, "moov")) throw new Error("no moov box");
      const sig = await audioSig(path, ctx);
      if (sig.errors) throw new Error(sig.errors.split("\n")[0]);
      return sig;
    },
    async same(original, candidate, ctx) {
      let b: AudioSig;
      try {
        b = await audioSig(candidate, ctx);
      } catch (e: any) {
        return `the result does not decode: ${e?.message ?? e}`;
      }
      if (b.errors) return `the result decodes with errors: ${b.errors.split("\n")[0]}`;
      return sameAudio(original as AudioSig, b, ctx.settings.audio.keepMetadata);
    },
  },
};

export const formats: Format[] = [m4a];
