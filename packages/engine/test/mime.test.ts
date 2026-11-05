// MIME messages and the "known but not optimisable" table (docs/FORMATS.md, sections 19 and "Not in scope").
import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, decodePng, samePixels } from "../src";
import { formats as known } from "../src/formats/known-unsupported.format";
import { mime } from "../src/formats/mime.format";
import { build, decodeBase64, encodeBase64Like, flatten, parseEntity } from "../src/formats/mime-parse";
import { env, type Env } from "./fake";
import { makeJpeg } from "./lib/jpeg";
import { makePng } from "./lib/png";
import { scriptTool } from "./lib/platform";

const have = Bun.which("oxipng") !== null && Bun.which("jpegtran") !== null;
const t = have ? test : test.skip;
const envs: Env[] = [];
const make = (formats = [mime], settings = {}) => (envs.push(env({ formats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const png = () => makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8, compression: 0 });
const b64 = (d: Uint8Array, eol = "\n") => encodeBase64Like(d, "x".repeat(76) + eol);
const text = (b: Uint8Array | Buffer) => Buffer.from(b).toString("latin1");

function message(o: { image: Uint8Array; type?: string; eol?: string; headers?: string; encoding?: string }) {
  const eol = o.eol ?? "\n";
  const lines = [
    "From: a@example.com", "To: b@example.com", "Subject: hello", "MIME-Version: 1.0", ...(o.headers ? [o.headers] : []),
    'Content-Type: multipart/mixed; boundary="BOUND"', "",
    "This is a multi-part message.", "--BOUND", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "Caf=C3=A9   ", "",
    "--BOUND", `Content-Type: ${o.type ?? "image/png"}; name="p"`, `Content-Transfer-Encoding: ${o.encoding ?? "base64"}`, "", b64(o.image, eol).replace(/\r?\n$/, ""), "--BOUND--", "epilogue text  ", "",
  ];
  return lines.join(eol);
}

test("MIME parser: rebuilds every message byte for byte, LF and CRLF", () => {
  for (const eol of ["\n", "\r\n"]) {
    const m = message({ image: png(), eol });
    expect(build(parseEntity(m))).toBe(m);
  }
  expect(() => parseEntity(message({ image: png() }).replace("--BOUND--", ""))).toThrow(/not closed/);
});

t("MIME-01: a base64 PNG part shrinks, the pixels and every other byte stay", async () => {
  const e = make();
  const p = await e.file("a.eml", message({ image: png() }));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = text(readFileSync(p));
  const a = flatten(parseEntity(message({ image: png() })));
  const b = flatten(parseEntity(out));
  expect(b.fixed).toEqual(a.fixed);
  expect(samePixels(decodePng(decodeBase64(a.leaves[1].entity.body!)!), decodePng(decodeBase64(b.leaves[1].entity.body!)!))).toBe(true);
  expect(b.leaves[0].entity.body).toBe(a.leaves[0].entity.body); // the text part is byte-identical
});

t("MIME-02: a JPEG part is recompressed, in a CRLF message with its line layout kept", async () => {
  const jpg = await makeJpeg({ width: 128, height: 96, quality: 90 });
  const m = message({ image: jpg, type: "image/jpeg", eol: "\r\n" });
  const e = make();
  const p = await e.file("a.mhtml", m);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = text(readFileSync(p));
  expect(out).not.toMatch(/[^\r]\n/);
  expect(Math.max(...out.split("\r\n").map((l) => l.length))).toBeLessThanOrEqual(76);
});

t("MIME-03: an .emlx keeps its length line and trailing property list", async () => {
  const m = message({ image: png() });
  const plist = "<?xml version=\"1.0\"?><plist><dict/></plist>";
  const emlx = `${m.length}\n${m}${plist}`;
  const e = make();
  const p = await e.file("1.emlx", emlx);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = text(readFileSync(p));
  const len = Number(/^(\d+)\n/.exec(out)![1]);
  expect(out.endsWith(plist)).toBe(true);
  expect(out.length).toBe(String(len).length + 1 + len + plist.length);
});

test("MIME-04: signed messages (DKIM, S/MIME, PGP) are skipped", async () => {
  const e = make();
  for (const [name, extra] of [["dkim.eml", "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; bh=abc; b=def"], ["smime.eml", ""]] as const) {
    let m = message({ image: png(), headers: extra || undefined });
    if (name === "smime.eml") m = m.replace("multipart/mixed", "multipart/signed");
    const p = await e.file(name, m);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/signed/);
    expect(text(readFileSync(p))).toBe(m);
  }
});

test("MIME-05: a message with nothing to recompress is skipped with a reason", async () => {
  const e = make();
  const m = "From: a@b.c\nSubject: hi\n\nJust text.   \n";
  const r = await e.engine.optimizeFile(await e.file("plain.eml", m));
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("no image parts");
});

t("MIME-06 / COMMON-05: a truncated multipart message is damaged and untouched", async () => {
  const e = make();
  const m = message({ image: png() }).replace(/--BOUND--[\s\S]*$/, "");
  const p = await e.file("cut.eml", m);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(text(readFileSync(p))).toBe(m);
});

t("MIME-07 / COMMON-08: a tool that changes the image is rejected and the message is untouched", async () => {
  const e = make();
  const data = png();
  const m = message({ image: data });
  const other = makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8, compression: 9, data: Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => i & 255) });
  const bad = join(e.dir, "other.png");
  writeFileSync(bad, other);
  const liar = scriptTool(`fs.copyFileSync(${JSON.stringify(bad)}, args[args.indexOf("--out") + 1]);`);
  const engine = new Engine({ formats: [mime], cacheDir: e.dir + "/c2", tempDir: e.dir + "/tmp", settings: { toolPaths: { oxipng: liar } } });
  const p = await e.file("a.eml", m);
  const r = await engine.optimizeFile(p);
  expect(r.steps[0].outcome).toBe("rejected");
  expect(r.steps[0].detail).toContain("part 0.1");
  expect(text(readFileSync(p))).toBe(m);
});

test("MIME oracle: a changed text part or header is rejected", async () => {
  const { mime: f } = await import("../src/formats/mime.format");
  const e = make();
  const m = message({ image: png() });
  const p = await e.file("o.eml", m);
  const cand = await e.file("c.eml", m.replace("Subject: hello", "Subject: hullo"));
  const cand2 = await e.file("c2.eml", m.replace("Caf=C3=A9", "Caf=C3=A8"));
  const ctx = { facts: {}, original: p } as any;
  const prepared = await f.oracle.prepare!(p, ctx);
  expect(await f.oracle.same(prepared, cand, ctx)).toBe("headers or structure changed");
  expect(await f.oracle.same(prepared, cand2, ctx)).toContain("changed");
});

// ---- known but not optimisable

const run = async (name: string, data: Uint8Array | string) => {
  const e = make(known);
  const p = await e.file(name, data);
  const r = await e.engine.optimizeFile(p);
  expect(Buffer.from(readFileSync(p))).toEqual(Buffer.from(data as any));
  return r;
};
const ftyp = (brand: string, compat: string[] = []) => {
  const size = 16 + compat.length * 4;
  return new Uint8Array([0, 0, 0, size, ...Buffer.from("ftyp" + brand), 0, 0, 0, 0, ...Buffer.from(compat.join("")), ...new Uint8Array(100)]);
};

test("KNOWN: AVIF, HEIC and JPEG XL are skipped with a reason, by content", async () => {
  for (const [name, data, word] of [
    ["a.avif", ftyp("avif", ["mif1"]), "AVIF"], ["a.heic", ftyp("heic", ["mif1"]), "HEIC"], ["a.heif", ftyp("mif1", ["heic"]), "HEIC"], ["a.jxl", new Uint8Array([0xff, 0x0a, ...new Array(40).fill(3)]), "JPEG XL"],
    ["renamed.bin", ftyp("avif"), "AVIF"],
  ] as [string, Uint8Array, string][]) {
    const r = await run(name, data);
    expect(r.status).toBe("skipped");
    expect(r.reason).toStartWith("unsupported: ");
    expect(r.reason).toContain(word);
  }
});

test("KNOWN: lit, lnk, onenote, Access, chm and vcard files get a clear skip reason", async () => {
  const lnk = new Uint8Array([0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46, ...new Array(60).fill(0)]);
  const jet = new Uint8Array([0, 1, 0, 0, ...Buffer.from("Standard Jet DB\0"), ...new Array(60).fill(0)]);
  const one = new Uint8Array([0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8, 0xa7, 0x4d, 0xae, 0xb1, 0x53, 0x78, 0xd0, 0x29, 0x96, 0xd3, ...new Array(60).fill(0)]);
  const cases: [string, Uint8Array | string, string][] = [
    ["a.lit", "ITOLITLS" + "x".repeat(60), "e-book"], ["a.lnk", lnk, "shortcut"], ["a.one", one, "OneNote"], ["a.mdb", jet, "Access"],
    ["a.chm", "ITSF" + "x".repeat(60), "HTML Help"], ["c.vcf", "BEGIN:VCARD\nVERSION:3.0\nFN:A B\nEND:VCARD\n", "contact"], ["a.ipsw", new Uint8Array([0x50, 0x4b, 3, 4, ...new Array(60).fill(0)]), "firmware"],
    ["a.crx", "Cr24" + "x".repeat(60), "extension"],
  ];
  for (const [name, data, word] of cases) {
    const r = await run(name, data);
    expect(r.status).toBe("skipped");
    expect(r.reason).toStartWith("unsupported: ");
    expect(r.reason).toContain(word);
  }
});

test("KNOWN: a file that merely has the extension (no magic) is not claimed", async () => {
  const e = make(known);
  const r = await e.engine.optimizeFile(await e.file("fake.chm", "this is not a chm at all, just text"));
  expect(r.reason).not.toStartWith("unsupported: Compiled");
});
