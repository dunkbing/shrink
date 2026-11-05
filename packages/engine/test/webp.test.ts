// WebP cases (docs/FORMATS.md, section 4) against the real cwebp.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseWebp, webp } from "../src";
import { env, type Env } from "./fake";
import { makeWebp, withChunks } from "./lib/webp";

const have = Bun.which("cwebp") !== null && Bun.which("webpmux") !== null;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: [webp], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const t = have ? test : test.skip;
const info = (p: string) => parseWebp(new Uint8Array(readFileSync(p)));
const pixelsOf = async (b: Uint8Array) => Bun.hash(await new Bun.Image(b).png({ compressionLevel: 1 }).bytes());

// An EXIF block (TIFF header, one Orientation entry) and a stand-in ICC profile.
const exif = (orientation: number) => Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode("padding ".repeat(20))]);
const icc = () => new TextEncoder().encode("fake-icc-profile-".repeat(30));

t("WEBP-01: a lossless WebP shrinks and decodes to the same pixels", async () => {
  const bytes = makeWebp({ width: 128, height: 96 });
  const e = make();
  const p = await e.file("a.webp", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  expect(await pixelsOf(new Uint8Array(readFileSync(p)))).toBe(await pixelsOf(bytes));
});

t("WEBP-02: a lossy WebP is left alone without the lossy setting", async () => {
  const bytes = makeWebp({ lossy: true, width: 128, height: 96 });
  const e = make();
  const p = await e.file("a.webp", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(r.steps[0].detail).toBe("lossy WebP is left alone");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

t("WEBP-03: transparency is kept", async () => {
  const bytes = makeWebp({ alpha: true, width: 96, height: 64 });
  const e = make();
  const p = await e.file("a.webp", bytes);
  await e.engine.optimizeFile(p);
  expect(info(p).alpha || info(p).lossless).toBe(true);
  expect(await pixelsOf(new Uint8Array(readFileSync(p)))).toBe(await pixelsOf(bytes));
});

t("WEBP-04: EXIF goes by default, stays with keepMetadata, and an orientation is always kept; ICC stays", async () => {
  const base = makeWebp({ width: 128, height: 96 });
  const plain = withChunks(base, { exif: exif(1), icc: icc() });
  const strip = make();
  const a = await strip.file("a.webp", plain);
  await strip.engine.optimizeFile(a);
  expect(info(a).exif).toBeNull();
  expect(info(a).icc).not.toBeNull();
  const keep = make({ webp: { keepMetadata: true } });
  const b = await keep.file("b.webp", plain);
  await keep.engine.optimizeFile(b);
  expect(info(b).exif).not.toBeNull();
  const rotated = make();
  const c = await rotated.file("c.webp", withChunks(base, { exif: exif(6) }));
  await rotated.engine.optimizeFile(c);
  expect(info(c).orientation).toBe(6);
});

t("WEBP-05: an animated WebP is skipped", async () => {
  const f = require("node:path").join(import.meta.dir, "../../../fixtures/real/webp-animated.webp");
  if (!(await Bun.file(f).exists())) return;
  const e = make();
  const p = await e.file("anim.webp", new Uint8Array(await Bun.file(f).arrayBuffer()));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("animated");
});

t("WEBP-06: a truncated WebP is left alone", async () => {
  const bytes = makeWebp({ width: 128, height: 96 });
  const e = make();
  const p = await e.file("cut.webp", bytes.subarray(0, bytes.length - 40));
  expect((await e.engine.optimizeFile(p)).reason).toContain("damaged");
});
