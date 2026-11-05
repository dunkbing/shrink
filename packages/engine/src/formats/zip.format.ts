import { extname } from "node:path";
import { statSync } from "node:fs";
import { crc32 } from "node:zlib";
import { iterations } from "./gzip.format";
import { inPlaceStep } from "../step";
import { SkipFile, type Format, type Settings, type Step } from "../types";
import { bestDeflate, buildZip, type NewMember } from "./zip-build";
import { parseZip, readMember, sha, zipHazards, type Zip } from "./zip-parse";
import { recurseMembers, sameMember } from "./recurse";
import { errorMessage } from "../errors";

const EXTENSIONS = (
  "zip zipx jar war ear epub cbz kmz xps oxps ora vsdx 3mf " +
  "docx docm dotx dotm xlsx xlsm xlsb xltx xltm pptx pptm potx potm ppsx ppsm sldx sldm " +
  "odt ods odp odg odf odb ott ots otp otg air lxf nbk notebook pk3 puz wsz wmz bar itz mmip s3z stz xap"
).split(" ");

/** Packages that carry a signature over the exact bytes: never rewritten. */
const SIGNED_EXT = new Set(["apk", "aab", "ipa", "appx", "msix", "appxbundle", "msixbundle", "xpi", "crx", "vsix", "nupkg", "snupkg"]);

const SIGNATURE_NAMES = /^(META-INF\/[^/]+\.(sf|rsa|dsa|ec)|META-INF\/signatures\.xml|META-INF\/documentsignatures\.xml|_xmlsignatures\/.*|AppxSignature\.p7x|AppxBlockMap\.xml|_signatures\/.*)$/i;

export interface ZipFacts {
  zip: Zip;
  shas: string[];
}

function load(bytes: Uint8Array): ZipFacts {
  if (bytes.length > 2 ** 30) throw new SkipFile("larger than 1 GiB");
  const zip = parseZip(bytes);
  const bad = zipHazards(zip);
  if (bad) throw new SkipFile(bad);
  const names = new Set<string>();
  for (const e of zip.entries) {
    for (let q = 0; q + 4 <= e.extra.length; q += 4 + (e.extra[q + 2] | (e.extra[q + 3] << 8))) {
      const id = e.extra[q] | (e.extra[q + 1] << 8);
      if (id === 0x7075 || id === 0x6375) throw new SkipFile("Unicode path/comment extra fields");
    }
    if (names.has(e.name)) throw new SkipFile("duplicate member names");
    names.add(e.name);
  }
  const shas = zip.entries.map((e) => sha(readMember(zip, e)));
  return { zip, shas };
}

const mustStore = (name: string) => name === "mimetype";

/** Native step: per member the smallest of stored / current / deflate 9. */
const native: Step = {
  id: "zip.deflate",
  async run(input, output) {
    const zip = parseZip(new Uint8Array(await Bun.file(input).arrayBuffer()));
    const members: NewMember[] = zip.entries.map((e) => {
      const cur = { method: e.method, data: zip.bytes.subarray(e.dataOffset, e.dataOffset + e.csize) };
      return e.isDir ? cur : bestDeflate(readMember(zip, e), cur, mustStore(e.name));
    });
    await Bun.write(output, buildZip(zip, members));
  },
};

const advzip = inPlaceStep({
  id: "zip.advzip",
  tool: "advzip",
  minLevel: 2,
  args: (file, ctx) => ["-z", ctx.level >= 4 ? "-4" : "-3", ...(ctx.level >= 4 ? ["-i", String(iterations(ctx.level, statSync(file).size))] : []), file],
});

/** With `archive.recurse`: members that are themselves known files go through their own format. */
const recurse: Step = {
  id: "zip.recurse",
  when: (ctx) => ctx.settings.archive.recurse || "archive.recurse is off",
  async run(input, output, ctx) {
    const zip = parseZip(new Uint8Array(await Bun.file(input).arrayBuffer()));
    const datas = zip.entries.map((e) => (e.isDir ? new Uint8Array(0) : readMember(zip, e)));
    const done = await recurseMembers(zip.entries.map((e, i) => ({ name: e.name, data: datas[i], skip: e.isDir || mustStore(e.name) ? "n/a" : null })), ctx);
    const members = zip.entries.map((e, i) => {
      const cur = { method: e.method, data: zip.bytes.subarray(e.dataOffset, e.dataOffset + e.csize) };
      if (done[i] === datas[i]) return cur;
      e.size = done[i].length;
      e.crc = crc32(done[i]);
      return bestDeflate(done[i], { method: 0, data: done[i] }, false);
    });
    await Bun.write(output, buildZip(zip, members));
  },
};

export const zip: Format = {
  id: "zip",
  extensions: EXTENSIONS,
  detect: (h) => h[0] === 0x50 && h[1] === 0x4b && h[2] === 3 && h[3] === 4,
  flags: (s: Settings) => ({ keepMetadata: s.archive.keepMetadata }),
  async skip(path) {
    if (SIGNED_EXT.has(extname(path).slice(1).toLowerCase())) return "signed package format";
    return null;
  },
  steps: [native, advzip, recurse],
  oracle: {
    async prepare(path, ctx) {
      if (Bun.file(path).size > 2 ** 30) throw new SkipFile("larger than 1 GiB");
      const facts = load(new Uint8Array(await Bun.file(path).arrayBuffer()));
      if (facts.zip.entries.some((e) => SIGNATURE_NAMES.test(e.name))) throw new SkipFile("signed package");
      // an APK signing block sits between the entries and the central directory
      const b = facts.zip.bytes;
      if (Buffer.from(b.buffer, b.byteOffset, b.length).includes("APK Sig Block 42")) throw new SkipFile("signed package");
      void ctx;
      return facts;
    },
    async same(original, candidatePath, ctx) {
      const a = original as ZipFacts;
      let b: ZipFacts;
      try {
        b = load(new Uint8Array(await Bun.file(candidatePath).arrayBuffer()));
      } catch (e) {
        return `the result is not a valid ZIP: ${errorMessage(e)}`;
      }
      const recurse = ctx.settings.archive.recurse;
      if (a.zip.entries.length !== b.zip.entries.length) return `member count ${a.zip.entries.length} became ${b.zip.entries.length}`;
      const keep = ctx.settings.archive.keepMetadata;
      for (let i = 0; i < a.zip.entries.length; i++) {
        const x = a.zip.entries[i], y = b.zip.entries[i];
        if (x.name !== y.name || Buffer.compare(x.nameBytes, y.nameBytes) !== 0) return `member ${i} is "${x.name}", became "${y.name}"`;
        if (x.isDir !== y.isDir) return `${x.name}: directory flag changed`;
        if (a.shas[i] !== b.shas[i]) {
          if (!recurse || x.isDir) return `${x.name}: content differs`;
          const r = await sameMember(x.name, readMember(a.zip, x), readMember(b.zip, y), ctx);
          if (r !== true) return r;
        }
        if (mustStore(x.name) && x.method === 0 && y.method !== 0) return "mimetype is no longer stored";
        if (x.flags & 0x800 && !(y.flags & 0x800)) return `${x.name}: UTF-8 name flag lost`;
        if (keep && (x.dosTime !== y.dosTime || x.dosDate !== y.dosDate || x.extAttr !== y.extAttr || Buffer.compare(x.comment, y.comment) !== 0)) return `${x.name}: attributes or timestamp changed`;
      }
      if (keep && Buffer.compare(a.zip.comment, b.zip.comment) !== 0) return "archive comment changed";
      return true;
    },
  },
};

export const formats: Format[] = [zip];
