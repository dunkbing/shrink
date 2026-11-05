// Compound file cases (docs/FORMATS.md, section 17).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cfb } from "../src/formats/cfb.format";
import { describe, readCfb } from "../src/formats/cfb-parse";
import { env, type Env } from "./fake";
import { makeCfb } from "./lib/cfb";
import { lorem, noise } from "./lib/zip";

const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [cfb], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const enc = (s: string) => new TextEncoder().encode(s);
const doc = (extra: Partial<Parameters<typeof makeCfb>[0]> = {}) =>
  makeCfb({
    streams: [
      { path: "WordDocument", data: enc(lorem(20000, 1)) },
      { path: "1Table", data: noise(9000) },
      { path: "\u0005SummaryInformation", data: enc(lorem(300, 2)) },
      { path: "Macros/VBA/Module1", data: enc(lorem(5000, 3)) },
      { path: "Macros/VBA/dir", data: enc(lorem(100, 4)) },
      { path: "Data", data: enc("") },
    ],
    clsid: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
    ...extra,
  });
const same = (a: Uint8Array, b: Uint8Array) => {
  const x = describe(readCfb(a)), y = describe(readCfb(b));
  expect([...y]).toEqual([...x]);
};

test("the test writer and the reader agree", () => {
  const m = describe(readCfb(doc()));
  expect([...m.keys()].sort()).toEqual(["/", "/1Table", "/Data", "/Macros", "/Macros/VBA", "/Macros/VBA/Module1", "/Macros/VBA/dir", "/WordDocument", "/\u0005SummaryInformation"].sort());
});

test("CFB-01: a .doc with free sectors shrinks, streams and CLSID equal", async () => {
  const src = doc({ gap: 6, trailingFree: 10 });
  const e = make();
  const p = await e.file("a.doc", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  same(src, new Uint8Array(readFileSync(p)));
});

test("CFB-02: a macro storage (VBA streams) stays intact", async () => {
  const src = doc({ gap: 3 });
  const e = make();
  const p = await e.file("a.xls", src);
  await e.engine.optimizeFile(p);
  const out = readCfb(new Uint8Array(readFileSync(p)));
  const i = out.paths.get("/Macros/VBA/Module1")!;
  expect(Buffer.from(out.dirents[i].data!).toString()).toBe(lorem(5000, 3));
});

test("CFB-03: a signed .msi is skipped", async () => {
  const src = makeCfb({ gap: 5, streams: [{ path: "Table", data: noise(8000) }, { path: "\u0005DigitalSignature", data: noise(1500) }] });
  const e = make();
  const p = await e.file("a.msi", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(readFileSync(p).equals(Buffer.from(src))).toBe(true);
});

test("CFB-04: attachment-like nested storages are intact (.msg)", async () => {
  const src = makeCfb({ gap: 2, streams: [{ path: "__substg1.0_1000001F", data: enc(lorem(3000)) }, { path: "__attach_version1.0_#00000000/__substg1.0_37010102", data: noise(12000) }, { path: "__attach_version1.0_#00000000/__substg1.0_3001001F", data: enc("a.bin") }] });
  const e = make();
  const p = await e.file("a.msg", src);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  same(src, new Uint8Array(readFileSync(p)));
});

test("CFB-05: mini streams and version 4 (4 KB sectors)", async () => {
  for (const version of [3, 4] as const) {
    const src = doc({ version, gap: 2 });
    const e = make();
    const p = await e.file("a.doc", src);
    expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
    const out = new Uint8Array(readFileSync(p));
    expect(readCfb(out).major).toBe(version);
    same(src, out);
  }
});

test("a file that needs a DIFAT (more than 109 FAT sectors) round-trips", async () => {
  const big = makeCfb({ gap: 1, streams: [{ path: "Big", data: noise(7_500_000) }, { path: "Small", data: enc(lorem(100)) }] });
  expect(Buffer.from(big).readUInt32LE(0x48)).toBeGreaterThan(0);
  const e = make();
  const p = await e.file("a.ole", big);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  same(big, new Uint8Array(readFileSync(p)));
});

test("CFB-06: a damaged FAT or a truncated file is untouched", async () => {
  const e = make();
  const src = Buffer.from(doc({ gap: 4 }));
  const cut = await e.file("cut.doc", src.subarray(0, src.length - 3000));
  const bad = Buffer.from(src);
  bad.writeUInt32LE(0x7fffff, 0x30); // directory start points outside the file
  const dir = await e.file("dir.doc", bad);
  const loop = Buffer.from(src);
  loop.writeUInt32LE(0, 0x4c); // FAT sector list now points at sector 0, which is data
  const l = await e.file("loop.doc", loop);
  for (const p of [cut, dir, l]) {
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

test("COMMON-08 for compound files: the oracle rejects changed bytes, a dropped stream and a changed CLSID", async () => {
  const e = make();
  const orig = await e.file("o.doc", doc());
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {} };
  const prepared = await cfb.oracle.prepare!(orig, ctx);
  const alt: Record<string, Uint8Array> = {
    bytes: makeCfb({ clsid: Uint8Array.from({ length: 16 }, (_, i) => i + 1), streams: [{ path: "WordDocument", data: enc(lorem(20000, 9)) }, { path: "1Table", data: noise(9000) }, { path: "\u0005SummaryInformation", data: enc(lorem(300, 2)) }, { path: "Macros/VBA/Module1", data: enc(lorem(5000, 3)) }, { path: "Macros/VBA/dir", data: enc(lorem(100, 4)) }, { path: "Data", data: enc("") }] }),
    dropped: makeCfb({ clsid: Uint8Array.from({ length: 16 }, (_, i) => i + 1), streams: [{ path: "WordDocument", data: enc(lorem(20000, 1)) }] }),
    clsid: doc({ clsid: new Uint8Array(16).fill(7) }),
  };
  for (const [k, v] of Object.entries(alt)) expect(await cfb.oracle.same(prepared, await e.file(`${k}.doc`, v), ctx)).not.toBe(true);
  expect(await cfb.oracle.same(prepared, await e.file("same.doc", doc({ gap: 3 })), ctx)).toBe(true);
});

test("an already-compact file is unchanged and the result opens with 7zz when available", async () => {
  const e = make({ skipOptimized: false });
  const p = await e.file("a.doc", doc({ gap: 4 }));
  await e.engine.optimizeFile(p);
  const once = readFileSync(p);
  expect((await e.engine.optimizeFile(p)).status).toBe("unchanged");
  expect(readFileSync(p).equals(once)).toBe(true);
  if (Bun.which("7zz")) expect(Bun.spawnSync(["7zz", "t", p]).exitCode).toBe(0);
});
