// SWF cases (docs/FORMATS.md, section 18).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { parseSwf, swf } from "../src/formats/swf.format";
import { env, type Env } from "./fake";
import { lorem } from "./lib/zip";
import { testCtx } from "./lib/ctx";

const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [swf], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

/** A SWF whose body is rect + frame info + filler tags (the reader only needs the container). */
function makeSwf(sig: "FWS" | "CWS", version: number, text = lorem(30000), level = 1) {
  const body = Buffer.concat([Buffer.from([0x78, 0, 0x05, 0x5f, 0x00, 0, 0x0f, 0xa0, 0, 0, 0x18, 1, 0]), Buffer.from(text)]);
  const length = body.length + 8;
  const h = Buffer.from([...Buffer.from(sig), version, length & 255, (length >> 8) & 255, (length >> 16) & 255, length >>> 24]);
  return Buffer.concat([h, sig === "CWS" ? deflateSync(body, { level }) : body]);
}

test("SWF-01: a CWS file gets a better deflate and its tags are equal", async () => {
  const src = makeSwf("CWS", 9);
  const e = make();
  const p = await e.file("a.swf", src);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(parseSwf(new Uint8Array(readFileSync(p))).body).toEqual(parseSwf(new Uint8Array(src)).body);
});

test("SWF-02: an uncompressed FWS is compressed from version 6 on, not before", async () => {
  const e = make();
  const a = await e.file("a.swf", makeSwf("FWS", 8));
  expect((await e.engine.optimizeFile(a)).status).toBe("optimized");
  expect(String.fromCharCode(...readFileSync(a).subarray(0, 3))).toBe("CWS");
  const old = makeSwf("FWS", 5);
  const b = await e.file("b.swf", old);
  expect((await e.engine.optimizeFile(b)).status).toBe("unchanged");
  expect(readFileSync(b).equals(old)).toBe(true);
});

test("a truncated SWF is untouched; LZMA (ZWS) is skipped", async () => {
  const e = make();
  const src = makeSwf("CWS", 9);
  const cut = await e.file("cut.swf", src.subarray(0, src.length - 20));
  const r = await e.engine.optimizeFile(cut);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  const z = Buffer.from(src);
  z.write("ZWS", 0);
  const zp = await e.file("z.swf", z);
  expect((await e.engine.optimizeFile(zp)).status).toBe("skipped");
});

test("COMMON-08 for SWF: the oracle rejects a changed tag stream", async () => {
  const e = make();
  const orig = await e.file("o.swf", makeSwf("CWS", 9));
  const ctx = testCtx({ settings: e.engine.settings, dir: e.dir });
  const prepared = await swf.oracle.prepare!(orig, ctx);
  expect(await swf.oracle.same(prepared, await e.file("c.swf", makeSwf("CWS", 9, lorem(30000, 2))), ctx)).not.toBe(true);
  expect(await swf.oracle.same(prepared, await e.file("v.swf", makeSwf("CWS", 10)), ctx)).not.toBe(true);
  expect(await swf.oracle.same(prepared, await e.file("ok.swf", makeSwf("FWS", 9)), ctx)).toBe(true);
});
