// PNG cases (docs/FORMATS.md, section 2) against the real oxipng.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { Engine, decodePng, png, samePixels, type Format } from "../src";
import { decodePngStream } from "../src/formats/png-decode";
import { env, type Env } from "./fake";
import { ico } from "../src/formats/ico.format";
import { zip } from "../src/formats/zip.format";
import { parseZip, readMember } from "../src/formats/zip-parse";
import { testCtx } from "./lib/ctx";
import { makeIco } from "./lib/raster";
import { makeZip } from "./lib/zip";
import { makePng, rowBytes } from "./lib/png";
import { copyTool } from "./lib/platform";

const have = Bun.which("oxipng") !== null;
const envs: Env[] = [];
const make = (settings = {}) => makeWith([png], settings);
const makeWith = (formats: Format[], settings = {}) => (envs.push(env({ formats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const noise = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => ((i * 2654435761 + seed * 40503) >>> 8) & 255);
const same = (a: Uint8Array, b: Uint8Array) => samePixels(decodePng(a), decodePng(b));
const test$ = have ? test : test.skip;

test$("PNG-01: an RGBA image shrinks and decodes to the same pixels", async () => {
  const bytes = makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8 });
  const e = make();
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  expect(same(bytes, new Uint8Array(readFileSync(p)))).toBe(true);
});

test$("PNG-02: an already optimal file is left alone", async () => {
  const e = make({ skipOptimized: false });
  const p = await e.file("a.png", makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8 }));
  await e.engine.optimizeFile(p);
  const once = readFileSync(p);
  expect((await e.engine.optimizeFile(p)).status).toBe("unchanged");
  expect(readFileSync(p)).toEqual(once);
});

test$("PNG-03: every colour type and bit depth keeps its pixels", async () => {
  const e = make();
  const specs: [number, number][] = [[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]];
  for (const [colorType, bitDepth] of specs) {
    const w = 37, h = 23; // odd sizes: rows don't end on a byte boundary
    const spec = { width: w, height: h, colorType: colorType as 0, bitDepth: bitDepth as 8 };
    const palette = colorType === 3 ? Array.from({ length: 1 << Math.min(bitDepth, 8) }, (_, i) => [i * 37 & 255, i * 91 & 255, i * 13 & 255]) : undefined;
    const bytes = makePng({ ...spec, palette, data: noise(rowBytes(spec) * h) .map((v) => (colorType === 3 ? v % (palette!.length) : v)) as Uint8Array });
    // a palette index must fit the depth: mask the bits for sub-byte palettes
    const p = await e.file(`t${colorType}-${bitDepth}.png`, colorType === 3 && bitDepth < 8 ? makePng({ ...spec, palette, data: new Uint8Array(rowBytes(spec) * h).fill(0) }) : bytes);
    const before = new Uint8Array(readFileSync(p));
    const r = await e.engine.optimizeFile(p);
    expect(["optimized", "unchanged"]).toContain(r.status);
    expect(same(before, new Uint8Array(readFileSync(p)))).toBe(true);
  }
});

test("PNG-03b: the pixel check sees a 16-bit low-byte change (which Bun.Image cannot)", () => {
  const data = noise(8 * 8 * 6);
  const other = data.slice();
  other[1] ^= 1;
  const a = makePng({ width: 8, height: 8, colorType: 2, bitDepth: 16, data });
  const b = makePng({ width: 8, height: 8, colorType: 2, bitDepth: 16, data: other });
  expect(same(a, b)).toContain("changed");
});

test("PNG-03c: the decoder handles Adam7 interlacing", () => {
  const spec = { width: 13, height: 9, colorType: 6 as const, bitDepth: 8 as const };
  const px = noise(rowBytes(spec) * 9);
  const flat = decodePng(makePng({ ...spec, data: px }));
  expect(flat.pixels[0]).toBe(px[0] * 257);
  expect(flat.pixels[1]).toBe(px[1] * 257);
});

test$("PNG-05: text chunks go by default and stay with keepMetadata; pixels equal either way", async () => {
  const text = new TextEncoder().encode("Comment\0hello hello hello");
  const bytes = makePng({ width: 32, height: 32, colorType: 2, bitDepth: 8, chunks: [["tEXt", text]] });
  const strip = make();
  const a = await strip.file("a.png", bytes);
  await strip.engine.optimizeFile(a);
  expect(decodePng(new Uint8Array(readFileSync(a))).chunks).not.toContain("tEXt");
  const keep = make({ png: { keepMetadata: true } });
  const b = await keep.file("b.png", bytes);
  await keep.engine.optimizeFile(b);
  expect(decodePng(new Uint8Array(readFileSync(b))).chunks).toContain("tEXt");
});

test$("PNG-06: an ICC profile or gamma without sRGB is kept", async () => {
  const bytes = makePng({ width: 32, height: 32, colorType: 2, bitDepth: 8, chunks: [["gAMA", new Uint8Array([0, 1, 0x86, 0xa0])]] });
  const e = make();
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.steps[0].outcome).not.toBe("rejected");
  expect(decodePng(new Uint8Array(readFileSync(p))).colour.has("gAMA")).toBe(true);
});

test$("PNG-07: colour under fully transparent pixels may change", async () => {
  const w = 16, h = 16;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(i % 2 ? [200, 10, 30, 255] : [i & 255, 99, 77, 0], i * 4);
  const bytes = makePng({ width: w, height: h, colorType: 6, bitDepth: 8, data });
  const e = make();
  const p = await e.file("a.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(same(bytes, new Uint8Array(readFileSync(p)))).toBe(true);
});

test("PNG-08: an animation control chunk without frames is damaged (animations are in raster-apng.test.ts)", async () => {
  const e = make();
  const p = await e.file("a.png", makePng({ width: 8, height: 8, colorType: 6, bitDepth: 8, chunks: [["acTL", new Uint8Array(8)]] }));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
});

test("PNG-11: truncated and corrupt files are left alone", async () => {
  const bytes = makePng({ width: 32, height: 32, colorType: 6, bitDepth: 8 });
  const e = make();
  const cut = await e.file("cut.png", bytes.subarray(0, bytes.length - 30));
  expect((await e.engine.optimizeFile(cut)).reason).toContain("damaged");
  const bad = bytes.slice();
  bad[40] ^= 0xff; // inside the image data: the CRC no longer matches
  const flipped = await e.file("bad.png", bad);
  expect((await e.engine.optimizeFile(flipped)).reason).toContain("damaged");
  expect(readFileSync(flipped)).toEqual(Buffer.from(bad));
});

test$("PNG-14: split IDAT chunks and a non-PNG name still work", async () => {
  const e = make();
  const bytes = makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8, idatSize: 100 });
  const p = await e.file("picture.dat", bytes); // detected by content
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(same(bytes, new Uint8Array(readFileSync(p)))).toBe(true);
});

test("PNG-15: a tool that changes a pixel is rejected and the file is untouched", async () => {
  const e = make();
  const data = noise(32 * 32 * 4);
  const original = makePng({ width: 32, height: 32, colorType: 6, bitDepth: 8, data, compression: 0 });
  const other = data.slice();
  other[100] ^= 1;
  const tampered = await e.file("tampered.png", makePng({ width: 32, height: 32, colorType: 6, bitDepth: 8, data: other, compression: 9 }));
  const p = await e.file("a.png", original);
  const liar = new (await import("../src")).Engine({
    formats: [png],
    cacheDir: e.dir + "/cache2",
    tempDir: e.dir + "/tmp",
    settings: { toolPaths: { oxipng: copyTool(tampered, 7) } },
  });
  const r = await liar.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(r.steps[0].detail).toContain("changed");
  expect(readFileSync(p)).toEqual(Buffer.from(original));
});

test$("PNG-04: interlaced (Adam7) and plain files both keep their pixels; the interlace is kept or removed", async () => {
  const spec = { width: 37, height: 29, colorType: 6 as const, bitDepth: 8 as const };
  const data = noise(rowBytes(spec) * spec.height, 3);
  const plain = makePng({ ...spec, data, compression: 0 });
  const adam7 = makePng({ ...spec, data, compression: 0, interlace: true });
  expect(decodePng(adam7).interlaced).toBe(true);
  expect(same(plain, adam7)).toBe(true); // the fixture and the reader agree on what Adam7 is
  for (const [name, bytes] of [["plain.png", plain], ["adam7.png", adam7]] as const) {
    const e = make();
    const p = await e.file(name, bytes);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("optimized");
    const after = new Uint8Array(readFileSync(p));
    expect(same(bytes, after)).toBe(true);
    expect(typeof decodePng(after).interlaced).toBe("boolean");
  }
});

test$("PNG-09: a 9-patch keeps every border pixel (the stretch and padding markers)", async () => {
  const w = 40, h = 30;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (border) {
        // black opaque markers on the stretch (top, left) and padding (bottom, right) ranges, transparent elsewhere
        const mark = (y === 0 && x >= 8 && x <= 30) || (x === 0 && y >= 6 && y <= 20) || (y === h - 1 && x >= 4 && x <= 34) || (x === w - 1 && y >= 3 && y <= 25);
        data.set(mark ? [0, 0, 0, 255] : [0, 0, 0, 0], o);
      } else data.set([(x * 6) & 255, (y * 8) & 255, 120, 255], o);
    }
  const bytes = makePng({ width: w, height: h, colorType: 6, bitDepth: 8, data, compression: 0 });
  const e = make();
  const p = await e.file("button.9.png", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const after = decodePng(new Uint8Array(readFileSync(p)));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!(x === 0 || y === 0 || x === w - 1 || y === h - 1)) continue;
      const o = (y * w + x) * 4;
      const a = data[o + 3] * 257;
      expect(after.pixels[o + 3]).toBe(a);
      if (a) expect([after.pixels[o], after.pixels[o + 1], after.pixels[o + 2]]).toEqual([0, 0, 0]);
    }
  // a result that moves a marker is rejected
  const moved = data.slice();
  moved.set([0, 0, 0, 0], (0 * w + 10) * 4);
  const evil = await e.file("evil.png", makePng({ width: w, height: h, colorType: 6, bitDepth: 8, data: moved, compression: 9 }));
  const q = await e.file("again.9.png", bytes);
  const liar = new Engine({ formats: [png], cacheDir: e.dir + "/c2", tempDir: e.dir + "/tmp", settings: { toolPaths: { oxipng: copyTool(evil, 7) } } });
  const lr = await liar.optimizeFile(q);
  expect(lr.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(readFileSync(q)).toEqual(Buffer.from(bytes));
});

// ---------------------------------------------------------------- PNG-12

const big = totalmem() >= 8 * 2 ** 30 ? test : test.skip;
const MB = 1 << 20;

/** 8000x8000 gray, mostly flat (a stripe every 500 rows): about 64 MP, a few hundred KB on disk. */
function bigPng(): Uint8Array {
  const n = 8000;
  const data = new Uint8Array(n * n);
  for (let y = 0; y < n; y += 500) data.fill(200, y * n, y * n + n);
  const bytes = makePng({ width: n, height: n, colorType: 0, bitDepth: 8, data, compression: 1 });
  return bytes;
}

/** Resident memory of this process and of its children (posix: ps), sampled while `work` runs; returns the peaks in bytes. */
async function peakMemory<T>(work: () => Promise<T>): Promise<{ result: T; self: number; children: number }> {
  let self = 0, children = 0;
  const sample = () => {
    self = Math.max(self, process.memoryUsage().rss);
    if (process.platform === "win32") return;
    const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,rss="]).stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Set([process.pid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [pid, ppid] of ps) if (kids.has(ppid) && !kids.has(pid)) (kids.add(pid), (grew = true));
    }
    children = Math.max(children, ps.filter(([pid]) => kids.has(pid) && pid !== process.pid).reduce((n, [, , rss]) => n + rss * 1024, 0));
  };
  const timer = setInterval(sample, 100);
  try {
    return { result: await work(), self, children };
  } finally {
    clearInterval(timer);
    sample();
  }
}

big("PNG-12: an 8000x8000 PNG finishes with the same pixels, within a memory bound", async () => {
  const e = make({ level: 1 });
  const bytes = bigPng();
  const p = await e.file("big.png", bytes);
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  const { result: r, self, children } = await peakMemory(() => e.engine.optimizeFile(p));
  expect(["optimized", "unchanged"]).toContain(r.status);
  if (have) expect(r.status).toBe("optimized");
  // decoding the whole picture would take 64M x 8 bytes = 512 MB for the pixels alone; streaming stays far below
  expect(self - base).toBeLessThan(300 * MB);
  expect(children).toBeLessThan(2500 * MB);
  const after = new Uint8Array(readFileSync(p));
  expect((await decodePngStream(after)).hash).toBe((await decodePngStream(bytes)).hash);
}, 240000);

big("PNG-12: cancelling stops the work quickly and leaves the file untouched", async () => {
  const e = make({ level: 1 });
  const bytes = bigPng();
  const p = await e.file("big.png", bytes);
  const ac = new AbortController();
  const run = e.engine.optimizeFile(p, { signal: ac.signal });
  await Bun.sleep(300);
  const t0 = performance.now();
  ac.abort();
  const r = await run;
  expect(performance.now() - t0).toBeLessThan(5000);
  expect(r.status).toBe("failed");
  expect(r.reason).toBe("cancelled");
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
}, 120000);

test("PNG-12: the streaming reader gives the same hash whatever the chunking, ignores colour under transparent pixels, and refuses interlacing", async () => {
  const spec = { width: 64, height: 40, colorType: 6 as const, bitDepth: 8 as const };
  const data = noise(rowBytes(spec) * spec.height, 5);
  const a = await decodePngStream(makePng({ ...spec, data, idatSize: 50 }));
  const b = await decodePngStream(makePng({ ...spec, data, compression: 9 }));
  expect(a.hash).toBe(b.hash);
  const other = data.slice();
  other[40 * 4 + 2] ^= 1;
  expect((await decodePngStream(makePng({ ...spec, data: other }))).hash).not.toBe(a.hash);
  const clear = data.slice(), clear2 = data.slice();
  clear[3] = clear2[3] = 0;
  clear2[0] ^= 255;
  expect((await decodePngStream(makePng({ ...spec, data: clear }))).hash).toBe((await decodePngStream(makePng({ ...spec, data: clear2 }))).hash);
  await expect(decodePngStream(makePng({ ...spec, data, interlace: true }))).rejects.toThrow("interlaced");
  const ac = new AbortController();
  ac.abort();
  await expect(decodePngStream(makePng({ ...spec, data }), ac.signal)).rejects.toThrow();
});

// ---------------------------------------------------------------- PNG-13

test$("PNG-13: a PNG inside an ICO or CUR is recompressed under the icon rules (every entry equal, colour profiles skip the file, never quantised)", async () => {
  const flat = (w: number, chunks: [string, Uint8Array][] = []) => makePng({ width: w, height: w, colorType: 6, bitDepth: 8, compression: 0, chunks });
  const e = makeWith([ico, png], { png: { lossy: true } });
  for (const [name, type] of [["a.ico", 1], ["a.cur", 2]] as const) {
    const bytes = makeIco([{ data: flat(32), w: 32, h: 32 }, { data: flat(48), w: 48, h: 48 }], type);
    const p = await e.file(name, bytes);
    const r = await e.engine.optimizeFile(p);
    expect(r.format).toBe("ico");
    expect(r.status).toBe("optimized");
    expect(r.lossy).toBeUndefined();
    expect(await ico.oracle.same(await ico.oracle.prepare!(p, testCtx()), p, testCtx())).toBe(true);
    const before = (await ico.oracle.prepare!(p, testCtx())) as { entries: { data: Uint8Array }[] };
    expect(before.entries.length).toBe(2);
  }
  const managed = await e.file("m.ico", makeIco([{ data: flat(32, [["gAMA", new Uint8Array([0, 1, 0x86, 0xa0])]]), w: 32, h: 32 }]));
  const r = await e.engine.optimizeFile(managed);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("colour profile");
});

test$("PNG-13: a PNG inside a ZIP is optimised only with archive.recurse, by the PNG rules (pixels and colour chunks kept), and never lossily", async () => {
  const plain = makePng({ width: 64, height: 64, colorType: 2, bitDepth: 8, compression: 0 });
  const gamma = makePng({ width: 64, height: 64, colorType: 2, bitDepth: 8, compression: 0, chunks: [["gAMA", new Uint8Array([0, 1, 0x86, 0xa0])], ["tEXt", new TextEncoder().encode("Comment\0made by hand")]] });
  const texty = makePng({ width: 64, height: 64, colorType: 2, bitDepth: 8, compression: 0, chunks: [["tEXt", new TextEncoder().encode("Comment\0made by hand")]] });
  const members = [{ name: "plain.png", data: plain, method: 0 as const }, { name: "gamma.png", data: gamma, method: 0 as const }, { name: "text.png", data: texty, method: 0 as const }];
  const member = (path: string, i: number) => {
    const z = parseZip(new Uint8Array(readFileSync(path)));
    return readMember(z, z.entries[i]);
  };
  const off = makeWith([zip, png], { archive: { recurse: false }, png: { lossy: true } });
  const p0 = await off.file("a.zip", makeZip(members));
  await off.engine.optimizeFile(p0);
  expect(Buffer.from(member(p0, 0))).toEqual(Buffer.from(plain));
  const on = makeWith([zip, png], { archive: { recurse: true }, png: { lossy: true } });
  const p = await on.file("a.zip", makeZip(members));
  const r = await on.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  for (const [i, orig] of [[0, plain], [1, gamma], [2, texty]] as const) {
    const now = member(p, i);
    expect(now.length).toBeLessThan(orig.length);
    expect(same(orig, now)).toBe(true); // equal pixels, even though png.lossy is on
    expect(decodePng(now).colorType).toBe(2); // not quantised
  }
  expect(decodePng(member(p, 1)).colour.has("gAMA")).toBe(true);
  expect(decodePng(member(p, 1)).chunks).toContain("tEXt"); // the PNG rule: a file with colour data that matters keeps everything
  expect(decodePng(member(p, 2)).chunks).not.toContain("tEXt"); // and otherwise text is stripped
});
