// Formats we recognise but can not shrink without a loss or a risk: they are skipped with a clear reason
// (`unsupported: ...`) instead of "unsupported format". Each has a `skip` hook that always returns its reason.
import type { Format } from "../types";

interface Known {
  id: string;
  extensions: string[];
  /** Content check; `ext` is the lower-case extension. */
  magic(h: Uint8Array, ext: string): boolean;
  reason: string;
}

const ascii = (h: Uint8Array, from: number, n: number) => String.fromCharCode(...h.subarray(from, from + n));
const startsWith = (h: Uint8Array, bytes: number[]) => bytes.every((b, i) => h[i] === b);
const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

const AVIF = new Set(["avif", "avis"]);
const HEIC = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
/** The brands of an ISO base media file: the major brand and the compatible ones that fit in the head. */
function brands(h: Uint8Array): string[] {
  if (h.length < 16 || ascii(h, 4, 4) !== "ftyp") return [];
  const out = [ascii(h, 8, 4)];
  const size = Math.min(new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(0), h.length);
  for (let p = 16; p + 4 <= size; p += 4) out.push(ascii(h, p, 4));
  return out;
}

const table: Known[] = [
  {
    id: "avif",
    extensions: ["avif", "avifs"],
    magic: (h, ext) => {
      const b = brands(h);
      return b.some((x) => AVIF.has(x)) || (["mif1", "msf1"].includes(b[0]) && ext === "avif" && !b.some((x) => HEIC.has(x)));
    },
    reason: "AVIF is already compressed with a modern codec and there is no lossless recompressor for it yet",
  },
  {
    id: "heic",
    extensions: ["heic", "heif", "hif", "heics", "heifs"],
    magic: (h, ext) => {
      const b = brands(h);
      return (b.some((x) => HEIC.has(x)) && !b.some((x) => AVIF.has(x))) || (["mif1", "msf1"].includes(b[0]) && ["heic", "heif", "hif"].includes(ext));
    },
    reason: "HEIC/HEIF is already compressed with HEVC and there is no lossless recompressor for it yet",
  },
  {
    id: "jxl",
    extensions: ["jxl"],
    magic: (h) => (h[0] === 0xff && h[1] === 0x0a) || startsWith(h, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    reason: "JPEG XL is already compressed; a lossless recompressor does not exist yet",
  },
  {
    id: "ipsw",
    extensions: ["ipsw"],
    magic: (h) => startsWith(h, [0x50, 0x4b, 3, 4]),
    reason: "Apple firmware image: signed, and its parts are verified byte for byte",
  },
  {
    id: "crx",
    extensions: ["crx"],
    magic: (h) => ascii(h, 0, 4) === "Cr24",
    reason: "Chrome extension: the package carries a signature over its exact bytes",
  },
  {
    id: "chm",
    extensions: ["chm", "chi", "chq", "chs", "chw"],
    magic: (h) => ascii(h, 0, 4) === "ITSF",
    reason: "Compiled HTML Help: its LZX-compressed sections can not be rewritten and proven identical without a CHM compiler",
  },
  {
    id: "lit",
    extensions: ["lit"],
    magic: (h) => ascii(h, 0, 8) === "ITOLITLS",
    reason: "Microsoft Reader e-book: DRM-capable container with no safe rewriter",
  },
  {
    id: "lnk",
    extensions: ["lnk"],
    magic: (h) => startsWith(h, [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46]),
    reason: "Windows shortcut: a few hundred bytes of link data, nothing to remove",
  },
  {
    id: "ink",
    extensions: ["ink"],
    magic: (_h, ext) => ext === "ink",
    reason: "Ink/shortcut data: tiny and structured, nothing to remove",
  },
  {
    id: "access",
    extensions: ["mdb", "accdb", "mde", "accde"],
    magic: (h) => ascii(h, 4, 15) === "Standard Jet DB" || ascii(h, 4, 15) === "Standard ACE DB",
    reason: "Microsoft Access database: no compactor that can be verified outside Access",
  },
  {
    id: "access-extra",
    extensions: ["mdt", "mdz"],
    magic: (_h, ext) => ext === "mdt" || ext === "mdz",
    reason: "Microsoft Access add-in data: no compactor that can be verified outside Access",
  },
  {
    id: "onenote",
    extensions: ["one", "onenote", "onetoc2"],
    magic: (h) => startsWith(h, [0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8, 0xa7, 0x4d, 0xae, 0xb1, 0x53, 0x78, 0xd0, 0x29, 0x96, 0xd3]) || startsWith(h, [0xa1, 0x2f, 0xff, 0x43, 0xd9, 0xef, 0x76, 0x4c, 0x9e, 0xe2, 0x10, 0xea, 0x57, 0x22, 0x76, 0x5f]),
    reason: "OneNote section: a proprietary binary store with no safe rewriter",
  },
  {
    id: "vcard",
    extensions: ["vcf", "vcard"],
    magic: (h) => /^\s*BEGIN:VCARD/i.test(ascii(h, 0, Math.min(h.length, 64))),
    reason: "plain-text contact card: every line is data (folded lines and embedded photos are content), nothing safe to remove",
  },
];

export const formats: Format[] = table.map((k) => ({
  id: `unsupported.${k.id}`,
  extensions: k.extensions,
  detect: (h, name) => k.magic(h, extOf(name)) && (k.extensions.includes(extOf(name)) || !extOf(name) || k.id === "avif" || k.id === "heic" || k.id === "jxl"),
  async skip() {
    return `unsupported: ${k.reason}`;
  },
  steps: [],
  oracle: { same: async () => "unsupported" },
}));
