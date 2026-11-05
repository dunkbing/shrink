// MIME messages (.eml .emlx .mht .mhtml): base64 image parts (PNG, JPEG, GIF) are recompressed with the image tools;
// everything else in the message stays byte-identical. Signed or DKIM-signed messages are not touched.
import { basename } from "node:path";
import { SkipFile, type Context, type Format, type Step } from "../types";
import { pixels, samePicture } from "./bun-pixels";
import { decodeGif, sameGif } from "./gif-decode";
import { build, contentType, decodeBase64, encodeBase64Like, flatten, parseEntity, transferEncoding, type Entity, type Leaf } from "./mime-parse";
import { decodePng, samePixels } from "./png-decode";

const EXT = ["eml", "emlx", "mht", "mhtml"];
const MAX = 128 * 1024 * 1024;
const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

interface Msg {
  /** emlx: the byte count line before the message, and the property list after it. */
  prefix: string;
  suffix: string;
  root: Entity;
}

function parseMessage(text: string, emlx: boolean): Msg {
  let prefix = "";
  let suffix = "";
  let body = text;
  if (emlx) {
    const m = /^(\d+)[ \t]*\n/.exec(text);
    if (!m) throw new Error("emlx without a length line");
    const n = Number(m[1]);
    if (m[0].length + n > text.length) throw new Error("emlx message is shorter than its length line (truncated)");
    prefix = m[0];
    body = text.slice(m[0].length, m[0].length + n);
    suffix = text.slice(m[0].length + n);
  }
  if (!/^[A-Za-z][\x21-\x39\x3b-\x7e]*:/.test(body)) throw new Error("no message headers");
  return { prefix, suffix, root: parseEntity(body) };
}

const looksLikeMessage = (head: Uint8Array) => {
  const t = latin1(head.subarray(0, 512));
  return /^(\d+[ \t]*\r?\n)?[A-Za-z][\x21-\x39\x3b-\x7e]*:/.test(t);
};

const IMAGE = new Set(["image/png", "image/jpeg", "image/jpg", "image/pjpeg", "image/gif"]);
const imageLeaf = (l: Leaf) => IMAGE.has(contentType(l.entity).type) && transferEncoding(l.entity) === "base64";

const SIGNED = /^(DKIM-Signature|DomainKey-Signature|ARC-Seal|X-Google-DKIM-Signature):/im;

async function same(a: Uint8Array, b: Uint8Array, type: string): Promise<true | string> {
  try {
    if (type === "image/png") return samePixels(decodePng(a), decodePng(b));
    if (type === "image/gif") return sameGif(decodeGif(a), decodeGif(b));
    return samePicture(await pixels(a), await pixels(b));
  } catch (e: any) {
    return `an image part does not decode: ${e?.message ?? e}`;
  }
}

/** Runs the image tool for one part; null when it can't make it smaller. */
async function recompress(data: Uint8Array, type: string, ctx: Context, n: number): Promise<Uint8Array | null> {
  const input = `${ctx.dir}/part${n}.in`;
  const output = `${ctx.dir}/part${n}.out`;
  await Bun.write(input, data);
  let ok: boolean;
  if (type === "image/png") ok = (await ctx.run("oxipng", ["-o", "4", "--strip", "safe", "-q", "--out", output, input])).code === 0;
  else if (type === "image/gif") ok = (await ctx.run("gifsicle", ["-O2", "-o", output, input])).code === 0;
  else ok = (await ctx.run("jpegtran", ["-optimize", "-progressive", "-copy", "all", "-outfile", output, input])).code === 0;
  if (!ok || !(await Bun.file(output).exists())) return null;
  const out = new Uint8Array(await Bun.file(output).arrayBuffer());
  return out.length < data.length ? out : null;
}

const parts: Step = {
  id: "mime.parts",
  async run(input, output, ctx) {
    const text = latin1(new Uint8Array(await Bun.file(input).arrayBuffer()));
    const msg = parseMessage(text, ctx.facts.emlx === true);
    const { leaves } = flatten(msg.root);
    let n = 0;
    for (const leaf of leaves.filter(imageLeaf)) {
      const e = leaf.entity;
      const data = decodeBase64(e.body ?? "");
      if (!data) continue;
      const type = contentType(e).type.replace("image/pjpeg", "image/jpeg").replace("image/jpg", "image/jpeg");
      let smaller: Uint8Array | null = null;
      try {
        smaller = await recompress(data, type, ctx, n++);
      } catch (err: any) {
        if (!String(err?.message).startsWith("tool not found")) throw err;
        ctx.note(`mime.parts: ${err.message}`);
      }
      if (smaller) e.body = encodeBase64Like(smaller, e.body ?? "");
    }
    let rebuilt = build(msg.root);
    if (ctx.facts.emlx) rebuilt = `${rebuilt.length}\n${rebuilt}${msg.suffix}`;
    else rebuilt += msg.suffix;
    await Bun.write(output, Buffer.from(rebuilt, "latin1"));
  },
};

export const mime: Format = {
  id: "mime",
  extensions: EXT,
  detect: (h, name) => EXT.includes(basename(name).split(".").pop()!.toLowerCase()) && looksLikeMessage(h),
  async skip(path, _head, ctx) {
    const f = Bun.file(path);
    if (f.size > MAX) return "larger than 128 MiB";
    ctx.facts.emlx = path.toLowerCase().endsWith(".emlx");
    let msg: Msg;
    try {
      msg = parseMessage(latin1(new Uint8Array(await f.arrayBuffer())), ctx.facts.emlx === true);
    } catch {
      return null; // the oracle reports damage
    }
    if (SIGNED.test(msg.root.head)) return "DKIM-signed message (changing a part would break the signature)";
    const all = flatten(msg.root).fixed.join("");
    if (/^content-type:\s*(multipart\/signed|application\/(x-)?pkcs7-(mime|signature)|application\/pgp-)/im.test(all)) return "signed or encrypted message (S/MIME or PGP)";
    if (!flatten(msg.root).leaves.some(imageLeaf)) return "no image parts to recompress";
    return null;
  },
  steps: [parts],
  oracle: {
    async prepare(path, ctx) {
      const f = Bun.file(path);
      if (f.size > MAX) throw new SkipFile("larger than 128 MiB");
      ctx.facts.emlx = ctx.original.toLowerCase().endsWith(".emlx");
      return parseMessage(latin1(new Uint8Array(await f.arrayBuffer())), ctx.facts.emlx === true);
    },
    async same(original, candidatePath, ctx) {
      const a = original as Msg;
      let b: Msg;
      try {
        b = parseMessage(latin1(new Uint8Array(await Bun.file(candidatePath).arrayBuffer())), ctx.facts.emlx === true);
      } catch (e: any) {
        return `the result is not a valid message: ${e?.message ?? e}`;
      }
      if (a.suffix !== b.suffix) return "the trailer changed";
      if (ctx.facts.emlx && Number(/^\d+/.exec(b.prefix)![0]) !== build(b.root).length) return "the length line is wrong";
      const fa = flatten(a.root);
      const fb = flatten(b.root);
      if (fa.fixed.length !== fb.fixed.length || fa.fixed.some((s, i) => s !== fb.fixed[i])) return "headers or structure changed";
      for (let i = 0; i < fa.leaves.length; i++) {
        const x = fa.leaves[i].entity.body ?? "";
        const y = fb.leaves[i].entity.body ?? "";
        if (x === y) continue;
        const l = fa.leaves[i];
        if (!imageLeaf(l)) return `part ${l.path} changed`;
        const da = decodeBase64(x);
        const db = decodeBase64(y);
        if (!da || !db) return `part ${l.path} is not valid base64`;
        const r = await same(da, db, contentType(l.entity).type.replace(/^image\/(pjpeg|jpg)$/, "image/jpeg"));
        if (r !== true) return `part ${l.path}: ${r}`;
      }
      return true;
    },
  },
};

export const formats: Format[] = [mime];
