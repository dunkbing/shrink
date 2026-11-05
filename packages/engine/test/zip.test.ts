// ZIP-family cases (docs/FORMATS.md, section 11): the native step always, advzip when installed.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { zip } from "../src/formats/zip.format";
import { parseZip, readMember } from "../src/formats/zip-parse";
import { env, type Env } from "./fake";
import { lorem, makeZip, noise } from "./lib/zip";

const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [zip], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const have = Bun.which("advzip") !== null;

const contents = (path: string) => {
  const z = parseZip(new Uint8Array(readFileSync(path)));
  return z.entries.map((e) => [e.name, e.isDir ? "" : Buffer.from(readMember(z, e)).toString("latin1"), e.method] as const);
};
const texts = (n = 6) => Array.from({ length: n }, (_, i) => ({ name: `doc/file${i}.txt`, data: lorem(20000, i + 1) }));

test("ZIP-01: a plain ZIP of text files shrinks and the extracted bytes are equal", async () => {
  const bytes = makeZip(texts());
  const e = make();
  const p = await e.file("a.zip", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(contents(p).map((c) => [c[0], c[1]])).toEqual(texts().map((t) => [t.name, t.data]));
});

test.skipIf(!have)("ZIP-01: advzip shrinks further than the native step", async () => {
  const bytes = makeZip(texts());
  const e = make({ level: 6 });
  const p = await e.file("a.zip", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps.find((s) => s.id === "zip.advzip")?.outcome).toBe("kept");
});

test("ZIP-02: an already-compressed ZIP is unchanged on the second run", async () => {
  const e = make({ skipOptimized: false });
  const p = await e.file("a.zip", makeZip(texts()));
  await e.engine.optimizeFile(p);
  const once = readFileSync(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(readFileSync(p).equals(once)).toBe(true);
});

test("ZIP-03: stored members are compressed when smaller and stay stored when not", async () => {
  const bytes = makeZip([{ name: "text.txt", data: lorem(30000), method: 0 }, { name: "random.bin", data: noise(5000), method: 0 }]);
  const e = make();
  const p = await e.file("a.zip", bytes);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const c = contents(p);
  expect(c[0][2]).toBe(8);
  expect(c[1][2]).toBe(0);
});

test("ZIP-04: data descriptors and a large entry count", async () => {
  const members = Array.from({ length: 1500 }, (_, i) => ({ name: `n/${i}.txt`, data: lorem(300 + (i % 40) * 10, i + 1), descriptor: i % 2 === 0 }));
  const e = make();
  const p = await e.file("a.zip", makeZip(members));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(contents(p).length).toBe(1500);
}, 60_000); // advzip -4 with iterations over 1500 members takes seconds

test("ZIP-05: order, names (UTF-8 and CP437), directories, comments and timestamps with keepMetadata", async () => {
  const members = [
    { name: "z-last-name.txt", data: lorem(5000, 1) },
    { name: "dir/", extAttr: 0x41ed0010 },
    { name: "dir/été 日本.txt", data: lorem(5000, 2), dosTime: 0x1234, dosDate: 0x4abc, comment: "member comment" },
    { name: "café.txt", data: lorem(5000, 3), utf8: false },
    { name: "a-first-name.txt", data: lorem(5000, 4) },
  ];
  const bytes = makeZip(members as any, { comment: "archive comment" });
  const e = make({ archive: { keepMetadata: true } });
  const p = await e.file("a.zip", bytes);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const a = parseZip(new Uint8Array(bytes)), b = parseZip(new Uint8Array(readFileSync(p)));
  expect(b.entries.map((x) => x.name)).toEqual(a.entries.map((x) => x.name));
  expect(b.entries.map((x) => [x.dosTime, x.dosDate, x.extAttr, x.flags & 0x800, Buffer.from(x.comment).toString()])).toEqual(a.entries.map((x) => [x.dosTime, x.dosDate, x.extAttr, x.flags & 0x800, Buffer.from(x.comment).toString()]));
  expect(Buffer.from(b.comment).toString()).toBe("archive comment");
});

test("ZIP-06: encrypted entries: the file is skipped", async () => {
  const e = make();
  const p = await e.file("a.zip", makeZip([{ name: "s.txt", data: lorem(9000), encrypted: true }, { name: "t.txt", data: lorem(9000) }]));
  const before = readFileSync(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("encrypted");
  expect(readFileSync(p).equals(before)).toBe(true);
});

test("ZIP-07: a prepended stub or trailing data is not touched", async () => {
  const e = make();
  const stub = await e.file("stub.zip", makeZip(texts(2), { prefix: Buffer.from("MZ stub\0".repeat(20)) }));
  const tail = await e.file("tail.zip", makeZip(texts(2), { suffix: Buffer.from("trailing junk") }));
  for (const p of [stub, tail]) {
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(["skipped"]).toContain(r.status);
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

const ooxml = (extra: any[] = []) => [
  { name: "[Content_Types].xml", data: lorem(3000, 5) },
  { name: "_rels/.rels", data: lorem(2000, 6) },
  { name: "word/document.xml", data: lorem(40000, 7) },
  ...extra,
];

test("ZIP-08: EPUB and ODF keep mimetype first and stored; OOXML keeps [Content_Types].xml first", async () => {
  const e = make();
  for (const [name, members] of [
    ["a.epub", [{ name: "mimetype", data: "application/epub+zip", method: 0 }, { name: "OEBPS/c.xhtml", data: lorem(30000) }]],
    ["a.odt", [{ name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 }, { name: "content.xml", data: lorem(30000) }]],
    ["a.docx", ooxml()],
  ] as const) {
    const p = await e.file(name, makeZip(members as any));
    expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
    const z = parseZip(new Uint8Array(readFileSync(p)));
    expect(z.entries[0].name).toBe(members[0].name);
    if (name !== "a.docx") {
      expect(z.entries[0].method).toBe(0);
      expect(z.entries[0].extra.length).toBe(0);
      // the name sits at byte 30, so the magic type text can be found at a fixed offset
      expect(Buffer.from(z.bytes.subarray(30, 38)).toString()).toBe("mimetype");
    }
  }
});

test("ZIP-09: an Office file keeps every part byte-equal", async () => {
  const e = make();
  const m = ooxml([{ name: "word/media/x.bin", data: noise(3000), method: 0 }]);
  const p = await e.file("a.docx", makeZip(m as any));
  await e.engine.optimizeFile(p);
  expect(contents(p).map((c) => c[0])).toEqual(m.map((x) => x.name));
  expect(contents(p).map((c) => c[1])).toEqual(m.map((x) => Buffer.from(x.data as any).toString("latin1")));
});

test("ZIP-10: signed JARs and signed package formats are skipped", async () => {
  const e = make();
  const jar = await e.file("a.jar", makeZip([{ name: "META-INF/MANIFEST.MF", data: lorem(9000) }, { name: "META-INF/CERT.SF", data: lorem(9000) }, { name: "META-INF/CERT.RSA", data: noise(500) }]));
  const apk = await e.file("a.apk", makeZip(texts(2)));
  for (const p of [jar, apk]) {
    const before = readFileSync(p);
    expect((await e.engine.optimizeFile(p)).status).toBe("skipped");
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

test("ZIP-11: with archive.recurse an inner file is optimised by its own format; off, it is left", async () => {
  const { makePng } = await import("./lib/png");
  const { png } = await import("../src/formats/png.format");
  const img = makePng({ width: 64, height: 64, colorType: 2, bitDepth: 8, compression: 0 });
  const members = [{ name: "readme.txt", data: lorem(4000) }, { name: "pic.png", data: img, method: 0 as const }];
  const mk = (recurse: boolean) => {
    const ee = env({ formats: [zip, png], settings: { archive: { recurse } } });
    envs.push(ee);
    return ee;
  };
  const off = mk(false);
  const p1 = await off.file("a.zip", makeZip(members as any));
  await off.engine.optimizeFile(p1);
  expect(Buffer.from(readMember(parseZip(new Uint8Array(readFileSync(p1))), parseZip(new Uint8Array(readFileSync(p1))).entries[1]))).toEqual(Buffer.from(img));
  const on = mk(true);
  const p2 = await on.file("a.zip", makeZip(members as any));
  const r = await on.engine.optimizeFile(p2);
  expect(r.status).toBe("optimized");
  const z = parseZip(new Uint8Array(readFileSync(p2)));
  expect(readMember(z, z.entries[1]).length).toBeLessThan(img.length);
});

test("ZIP-12: path traversal names and zip bombs are skipped", async () => {
  const e = make();
  const trav = await e.file("t.zip", makeZip([{ name: "../evil.txt", data: lorem(9000) }, { name: "ok.txt", data: lorem(9000) }]));
  const bomb = await e.file("b.zip", makeZip([{ name: "zeros.bin", data: new Uint8Array(40 * 1024 * 1024), level: 9 }]));
  for (const p of [trav, bomb]) {
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

test("ZIP-13: a truncated archive or a corrupt member is untouched", async () => {
  const e = make();
  const bytes = makeZip(texts());
  const cut = await e.file("cut.zip", bytes.subarray(0, bytes.length - 40));
  const bad = Buffer.from(bytes);
  bad[200] ^= 0xff;
  bad[300] ^= 0xff;
  const flip = await e.file("flip.zip", bad);
  for (const p of [cut, flip]) {
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

test("ZIP-14: a split archive is skipped", async () => {
  const e = make();
  const b = makeZip(texts(2));
  b.writeUInt16LE(1, b.length - 22 + 4); // this disk is 1
  const p = await e.file("a.zip", b);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
});

test("COMMON-08 for archives: the oracle rejects a result with one changed byte, a dropped member, or reordered members", async () => {
  const bytes = makeZip(texts(3));
  const cases: Record<string, (z: Buffer) => Buffer> = {
    changed: () => makeZip(texts(3).map((t, i) => (i === 1 ? { ...t, data: t.data.replace("a", "b") } : t))),
    dropped: () => makeZip(texts(3).slice(0, 2)),
    reordered: () => makeZip([...texts(3)].reverse()),
    renamed: () => makeZip(texts(3).map((t, i) => (i === 0 ? { ...t, name: "x.txt" } : t))),
  };
  const e = make();
  const orig = await e.file("o.zip", bytes);
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {} };
  const prepared = await zip.oracle.prepare!(orig, ctx);
  for (const [k, f] of Object.entries(cases)) {
    const c = await e.file(`${k}.zip`, f(bytes));
    expect(await zip.oracle.same(prepared, c, ctx)).not.toBe(true);
  }
  expect(await zip.oracle.same(prepared, await e.file("same.zip", makeZip(texts(3), { comment: "x" })), ctx)).toBe(true);
});

test("a mimetype that was stored must stay stored", async () => {
  const e = make();
  const orig = await e.file("o.epub", makeZip([{ name: "mimetype", data: "application/epub+zip", method: 0 }, { name: "a.txt", data: lorem(9000) }]));
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {} };
  const prepared = await zip.oracle.prepare!(orig, ctx);
  const c = await e.file("c.epub", makeZip([{ name: "mimetype", data: "application/epub+zip", method: 8 }, { name: "a.txt", data: lorem(9000) }]));
  expect(await zip.oracle.same(prepared, c, ctx)).toContain("mimetype");
  void inflateRawSync;
});

test("ZIP-04: a zip64 archive (zip64 end record and extra fields) is read and rewritten with equal content", async () => {
  const members = texts(4);
  const e = make();
  const p = await e.file("z64.zip", makeZip(members, { zip64: true }));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(contents(p).map((c) => [c[0], c[1]])).toEqual(members.map((t) => [t.name, t.data]));
});

test("ZIP-05: Unicode path extra fields: the file is skipped", async () => {
  const e = make();
  const p = await e.file("u.zip", makeZip(texts(3), { unicodeExtra: true }));
  const before = readFileSync(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(readFileSync(p).equals(before)).toBe(true);
});
