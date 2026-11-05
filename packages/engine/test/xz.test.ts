// .xz / .lzma cases (docs/FORMATS.md section 12).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lzma, xz } from "../src/formats/xz.format";
import { env, type Env } from "./fake";
import { lorem } from "./lib/zip";

const tool = !!Bun.which("xz");
const envs: Env[] = [];
const make = (f = [xz, lzma]) => (envs.push(env({ formats: f })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const text = lorem(300000);
const pack = (data: string, args: string[]) => Bun.spawnSync(["xz", "-c", ...args], { stdin: Buffer.from(data) }).stdout as Buffer;
const unpack = (b: Uint8Array) => Buffer.from(Bun.spawnSync(["xz", "-dc"], { stdin: b }).stdout);

test.skipIf(!tool)("XZ-01: an .xz written at preset 0 shrinks and decompresses to the same bytes", async () => {
  const e = make();
  const p = await e.file("a.txt.xz", pack(text, ["-0", "--check=crc32"]));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(unpack(readFileSync(p)).toString()).toBe(text);
  expect(Bun.spawnSync(["xz", "-t", p]).exitCode).toBe(0);
  expect(readFileSync(p)[7] & 15).toBe(1); // the integrity check type is kept
});

test.skipIf(!tool)("XZ-02: a raw .lzma shrinks and still decodes", async () => {
  const e = make();
  const p = await e.file("a.lzma", pack(text, ["--format=lzma", "-0"]));
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(unpack(readFileSync(p)).toString()).toBe(text);
});

test.skipIf(!tool)("COMMON-05 for xz/lzma: a truncated file is untouched and reported damaged", async () => {
  const e = make();
  for (const [name, b] of [["cut.xz", pack(text, ["-0"])], ["cut.lzma", pack(text, ["--format=lzma", "-0"])]] as const) {
    const p = await e.file(name, b.subarray(0, b.length - 40));
    const before = readFileSync(p);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(readFileSync(p).equals(before)).toBe(true);
  }
});

test.skipIf(!tool)("COMMON-08 for xz/lzma: the oracle rejects different data and a broken stream", async () => {
  const e = make();
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {}, tools: { locate: async () => [Bun.which("xz")!] } };
  const orig = await e.file("o.xz", pack(text, ["-0"]));
  const prepared = await xz.oracle.prepare!(orig, ctx);
  expect(await xz.oracle.same(prepared, await e.file("d.xz", pack(text.replace("a", "b"), ["-0"])), ctx)).toContain("differ");
  const good = pack(text, ["-1"]);
  expect(await xz.oracle.same(prepared, await e.file("c.xz", good.subarray(0, good.length - 30)), ctx)).toContain("cannot decode");
  expect(await xz.oracle.same(prepared, await e.file("ok.xz", good), ctx)).toBe(true);
});

test("detection: xz by magic, lzma by header; random bytes are neither", () => {
  expect(xz.detect(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0, 0, 4, 0, 0, 0, 0]), "a.xz")).toBe(true);
  const h = new Uint8Array(16);
  h.set([0x5d, 0, 0, 0, 1], 0);
  h.fill(0xff, 5, 13);
  expect(lzma.detect(h, "a.bin")).toBe(true);
  expect(lzma.detect(new Uint8Array(16).fill(0x41), "a.bin")).toBe(false);
});
