import { createHash } from "node:crypto";
import { SkipFile, type Format, type Settings, type Step } from "../types";
import { recurseMembers, sameMember } from "./recurse";
import { looksLikeTar, parseTar, type TarEntry } from "./tar-parse";
import { errorMessage } from "../errors";

const MAX = 2 ** 30;
const REGULAR = (e: TarEntry) => (e.type === "0" || e.type === "7") && !e.sparse && e.pax.size === undefined;

/** Writes a header's size field and checksum again (octal, so sizes up to 8 GiB). */
function resize(block: Uint8Array, size: number): Uint8Array {
  const h = Uint8Array.from(block);
  h.set(new TextEncoder().encode(size.toString(8).padStart(11, "0") + "\0"), 124);
  h.fill(32, 148, 156);
  let sum = 0;
  for (const v of h) sum += v;
  h.set(new TextEncoder().encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}

const recurse: Step = {
  id: "tar.recurse",
  when: (ctx) => ctx.settings.archive.recurse || "archive.recurse is off",
  async run(input, output, ctx) {
    const b = new Uint8Array(await Bun.file(input).arrayBuffer());
    const { entries } = parseTar(b);
    const done = await recurseMembers(
      entries.map((e) => ({ name: e.name, data: REGULAR(e) ? b.subarray(e.dataOffset, e.dataOffset + e.size) : new Uint8Array(0), skip: REGULAR(e) && e.size >= 16 ? null : "n/a" })),
      ctx,
    );
    const parts: Uint8Array[] = [];
    let pos = 0;
    entries.forEach((e, i) => {
      parts.push(b.subarray(pos, e.header));
      const orig = b.subarray(e.dataOffset, e.dataOffset + e.size);
      if (!REGULAR(e) || done[i].length >= e.size || done[i].length === 0) {
        parts.push(b.subarray(e.header, e.end));
      } else {
        const pad = (512 - (done[i].length % 512)) % 512;
        parts.push(resize(b.subarray(e.header, e.header + 512), done[i].length), done[i], new Uint8Array(pad));
      }
      void orig;
      pos = e.end;
    });
    parts.push(b.subarray(pos));
    await Bun.write(output, Buffer.concat(parts));
  },
};

interface Facts {
  b: Uint8Array;
  entries: TarEntry[];
  sha: string[];
}
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export const tar: Format = {
  id: "tar",
  extensions: ["tar"],
  detect: (h) => looksLikeTar(h),
  flags: (s: Settings) => ({ keepMetadata: s.archive.keepMetadata }),
  steps: [recurse],
  oracle: {
    async prepare(path) {
      if (Bun.file(path).size > MAX) throw new SkipFile("larger than 1 GiB");
      const b = new Uint8Array(await Bun.file(path).arrayBuffer());
      const { entries } = parseTar(b);
      return { b, entries, sha: entries.map((e) => digest(b.subarray(e.dataOffset, e.dataOffset + e.size))) } satisfies Facts;
    },
    async same(original, candidate, ctx) {
      const a = original as Facts;
      let nb: Uint8Array, entries: TarEntry[];
      try {
        nb = new Uint8Array(await Bun.file(candidate).arrayBuffer());
        entries = parseTar(nb).entries;
      } catch (e) {
        return `the result is not a valid tar: ${errorMessage(e)}`;
      }
      if (entries.length !== a.entries.length) return `entry count ${a.entries.length} became ${entries.length}`;
      for (let i = 0; i < entries.length; i++) {
        const x = a.entries[i], y = entries[i];
        if (x.name !== y.name || x.type !== y.type || x.linkname !== y.linkname || x.mode !== y.mode || x.uid !== y.uid || x.gid !== y.gid || x.mtime !== y.mtime) return `${x.name}: header differs`;
        // everything before the file header (pax, long names) and the rest of the header must be byte-equal
        const px = a.b.subarray(x.start, x.header), py = nb.subarray(y.start, y.header);
        if (Buffer.compare(px, py) !== 0) return `${x.name}: extended header differs`;
        const hx = Buffer.from(a.b.subarray(x.header, x.header + 512)), hy = Buffer.from(nb.subarray(y.header, y.header + 512));
        for (const [s, e] of [[124, 136], [148, 156]]) hx.fill(0, s, e), hy.fill(0, s, e);
        if (!hx.equals(hy)) return `${x.name}: header fields differ`;
        const d = nb.subarray(y.dataOffset, y.dataOffset + y.size);
        if (x.size !== y.size || digest(d) !== a.sha[i]) {
          if (!ctx.settings.archive.recurse || !REGULAR(x)) return `${x.name}: content differs`;
          const r = await sameMember(x.name, a.b.subarray(x.dataOffset, x.dataOffset + x.size), d, ctx);
          if (r !== true) return r;
        }
      }
      return true;
    },
  },
};

export const formats: Format[] = [tar];
