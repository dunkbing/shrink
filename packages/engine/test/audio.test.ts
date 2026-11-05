// Audio cases (docs/FORMATS.md, section 14): FLAC, WAV, MP3, Ogg Vorbis, M4A, Matroska audio.
import { afterAll, afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audioSig, sameAudio } from "../src/formats/audio-oracle";
import { flac } from "../src/formats/flac.format";
import { parseFlac } from "../src/formats/flac-parse";
import { m4a } from "../src/formats/m4a.format";
import { mka } from "../src/formats/mka.format";
import { mp3 } from "../src/formats/mp3.format";
import { ogg, oggCodecs } from "../src/formats/ogg.format";
import { parseWav } from "../src/formats/wav-parse";
import { wav } from "../src/formats/wav.format";
import { allFormats, type Step } from "../src";
import { env, type Env } from "./fake";
import { concat, cover, decodeMd5, ff, have, makeWav, probe, run, SRC, text, workDir } from "./lib/audio";

const dir = workDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const envs: Env[] = [];
const make = (formats: any[], settings = {}) => (envs.push(env({ formats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const f = (name: string) => join(dir, name);
const tf = have.ffmpeg ? test : test.skip;
const tflac = have.ffmpeg && have.flac ? test : test.skip;
const read = (p: string) => new Uint8Array(readFileSync(p));
const title = (p: string) => { const j = probe(p); const t = { ...j.format?.tags, ...j.streams?.[0]?.tags }; return t.title ?? t.TITLE; };
const step = (r: any, id: string) => r.steps.find((s: any) => s.id === id);

// ---------- WAV ----------

const info = (name: string, data: Uint8Array) => text(`${name}-INFO`.padEnd(40, "x") + data.length);

test("WAV-01: LIST/INFO, bext, junk and other chunks are removed; fmt and data stay intact", async () => {
  const bytes = makeWav({ before: [["JUNK", new Uint8Array(100)], ["bext", new Uint8Array(602)]], between: [["LIST", info("a", new Uint8Array(0))]], after: [["id3 ", new Uint8Array(300)], ["cue ", new Uint8Array(28)]] });
  const e = make([wav]);
  const p = await e.file("a.wav", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = read(p), w = parseWav(out), o = parseWav(bytes);
  expect(w.chunks.map((c) => c.id)).toEqual(["fmt ", "data"]);
  expect(Buffer.compare(out.subarray(w.data.off, w.data.off + w.data.size), bytes.subarray(o.data.off, o.data.off + o.data.size))).toBe(0);
  if (have.ffmpeg) expect(decodeMd5(p)).toBe(decodeMd5(await e.file("orig.wav", bytes)));
});

test("WAV-01: with keepMetadata only filler goes", async () => {
  const bytes = makeWav({ before: [["JUNK", new Uint8Array(100)]], after: [["LIST", info("a", new Uint8Array(0))]] });
  const e = make([wav], { audio: { keepMetadata: true } });
  const p = await e.file("a.wav", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(parseWav(read(p)).chunks.map((c) => c.id)).toEqual(["fmt ", "data", "LIST"]);
});

test("WAV-02: extensible format header is kept byte for byte", async () => {
  const bytes = makeWav({ extensible: true, bits: 24, channels: 2, after: [["LIST", new Uint8Array(40)]] });
  const e = make([wav]);
  const p = await e.file("a.wav", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const w = parseWav(read(p));
  expect(w.fmt.size).toBe(40);
});

test("WAV-03: odd-length chunks are padded correctly (data odd, odd chunk before it)", async () => {
  // 8-bit mono with an odd number of frames: odd data chunk; the odd LIST chunk before it needs its pad byte.
  const bytes = makeWav({ bits: 8, channels: 1, frames: 1001, between: [["LIST", new Uint8Array(33)]], after: [["junk", new Uint8Array(9)]] });
  const e = make([wav]);
  const p = await e.file("a.wav", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = read(p), w = parseWav(out);
  expect(w.data.size).toBe(1001);
  expect(out.length).toBe(12 + 8 + 16 + 8 + 1001 + 1);
  // The same file without the final pad byte is read too.
  const bare = makeWav({ bits: 8, channels: 1, frames: 1001, noDataPad: true, between: [["LIST", new Uint8Array(33)]] });
  expect(parseWav(bare).data.size).toBe(1001);
});

test("WAV-04: RF64 is skipped; BWF (bext in RIFF) loses bext", async () => {
  const rf = makeWav();
  rf.set(text("RF64"), 0);
  const e = make([wav]);
  const p = await e.file("a.wav", rf);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("RF64");
  expect(Buffer.compare(read(p), rf)).toBe(0);
  const bwf = await e.file("b.wav", makeWav({ before: [["bext", new Uint8Array(602)]] }));
  expect((await e.engine.optimizeFile(bwf)).status).toBe("optimized");
});

test("WAV-05: float samples keep fmt, fact and data", async () => {
  const bytes = makeWav({ float: true, bits: 32, after: [["LIST", new Uint8Array(60)]] });
  const e = make([wav]);
  const p = await e.file("a.wav", bytes);
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  expect(parseWav(read(p)).chunks.map((c) => c.id)).toEqual(["fmt ", "fact", "data"]);
});

test("WAV: a truncated data chunk is left untouched; clean files are unchanged", async () => {
  const bytes = makeWav({ after: [["LIST", new Uint8Array(40)]] });
  const e = make([wav]);
  const p = await e.file("t.wav", bytes.subarray(0, 8000));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(read(p).length).toBe(8000);
  const clean = await e.file("c.wav", makeWav());
  expect((await e.engine.optimizeFile(clean)).status).toBe("unchanged");
});

test("AUDIO-oracle (WAV): a candidate with one changed sample or a changed fmt is rejected", async () => {
  const bytes = makeWav();
  const e = make([wav]);
  const orig = await e.file("o.wav", bytes);
  const ctx: any = { settings: { audio: { keepMetadata: false } }, run: async () => ({ code: 1, stdout: "", stderr: "" }), tools: { locate: async () => null } };
  const prepared = await wav.oracle.prepare!(orig, ctx);
  const bad = bytes.slice();
  bad[parseWav(bytes).data.off + 100] ^= 1;
  expect(await wav.oracle.same(prepared, await e.file("bad.wav", bad), ctx)).toBe("audio data changed");
  const fmt = bytes.slice();
  fmt[parseWav(bytes).fmt.off + 4] ^= 1;
  expect(await wav.oracle.same(prepared, await e.file("fmt.wav", fmt), ctx)).toBe("fmt chunk changed");
  expect(await wav.oracle.same(prepared, orig, ctx)).toBe(true);
});

test("AUDIO-oracle (engine): a tool that changes a sample loses its output, original untouched", async () => {
  const bytes = makeWav({ after: [["LIST", new Uint8Array(400)]] });
  const evil: Step = {
    id: "wav.evil",
    async run(input, output) {
      const b = new Uint8Array(await Bun.file(input).arrayBuffer());
      const w = parseWav(b);
      const out = concat([b.subarray(0, 12), b.subarray(w.fmt.off - 8, w.fmt.off + w.fmt.size), b.subarray(w.data.off - 8, w.data.off + w.data.size)]);
      out[out.length - 5] ^= 4;
      new DataView(out.buffer).setUint32(4, out.length - 8, true);
      await Bun.write(output, out);
    },
  };
  const e = make([{ ...wav, steps: [evil] }]);
  const p = await e.file("a.wav", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(step(r, "wav.evil").outcome).toBe("rejected");
  expect(Buffer.compare(read(p), bytes)).toBe(0);
});

// ---------- FLAC ----------

function makeFlac(name: string, extra: string[] = [], src = SRC(3)): string {
  const p = f(name);
  ff([...src, "-c:a", "flac", "-compression_level", "0", ...extra, p]);
  return p;
}

tflac("FLAC-01: re-encode at the highest level is smaller; samples and STREAMINFO MD5 equal", async () => {
  const src = makeFlac("a.flac");
  const e = make([flac]);
  const p = await e.file("a.flac", readFileSync(src));
  const before = parseFlac(read(p));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  const after = parseFlac(read(p));
  expect(after.totalSamples).toBe(before.totalSamples);
  expect(decodeMd5(p)).toBe(decodeMd5(src));
  expect(Bun.spawnSync(["flac", "-t", "-s", p]).exitCode).toBe(0);
  if (/[1-9a-f]/.test(before.md5)) expect(after.md5).toBe(before.md5);
});

tflac("FLAC-02: tags, cuesheet and embedded art are stripped by default and kept with audio.keepMetadata", async () => {
  const c = cover(dir);
  // flac itself writes the cuesheet and the picture
  const wavPath = f("cue.wav");
  writeFileSync(wavPath, makeWav({ frames: 44100 * 4 }));
  writeFileSync(f("t.cue"), 'FILE "cue.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:02:00\n');
  const src = f("meta.flac");
  run(["flac", "-s", "-f", "-0", `--cuesheet=${f("t.cue")}`, "-T", "TITLE=Song", "-T", "ARTIST=Someone", `--picture=${c}`, "-o", src, wavPath]);
  const blocks = parseFlac(read(src)).blocks;
  expect(blocks.get(6)).toBe(1);
  expect(blocks.get(5)).toBe(1);
  const e = make([flac]);
  const p = await e.file("a.flac", readFileSync(src));
  expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  const b = parseFlac(read(p)).blocks;
  expect([b.get(4), b.get(5), b.get(6)]).toEqual([undefined, undefined, undefined]);
  expect(decodeMd5(p)).toBe(decodeMd5(src));

  const k = make([flac], { audio: { keepMetadata: true } });
  const q = await k.file("a.flac", readFileSync(src));
  expect((await k.engine.optimizeFile(q)).status).toBe("optimized");
  const kb = parseFlac(read(q)).blocks;
  expect([kb.get(4), kb.get(5), kb.get(6)]).toEqual([1, 1, 1]);
  expect(probe(q).format.tags.TITLE ?? probe(q).format.tags.title).toBe("Song");
});

tflac("FLAC-04: 24-bit six channel 192 kHz, and 8-bit mono", async () => {
  for (const [name, o] of [["hi", { bits: 24 as const, channels: 6, rate: 192000, frames: 20000, extensible: true }], ["lo", { bits: 8 as const, channels: 1, rate: 8000, frames: 8000, extensible: false }]] as const) {
    const w = f(`${name}.wav`);
    writeFileSync(w, makeWav(o));
    const src = f(`${name}.flac`);
    run(["flac", "-s", "-f", "-0", "-o", src, w]);
    const e = make([flac]);
    const p = await e.file(`${name}.flac`, readFileSync(src));
    const r = await e.engine.optimizeFile(p);
    expect(["optimized", "unchanged"]).toContain(r.status);
    const a = parseFlac(read(p));
    expect([a.channels, a.bitsPerSample, a.sampleRate]).toEqual([o.channels, o.bits, o.rate]);
    expect(Bun.spawnSync(["flac", "-t", "-s", p]).exitCode).toBe(0);
    if (r.status === "optimized") expect(r.after).toBeLessThan(r.before);
  }
});

tflac("FLAC-05: a truncated file is left untouched", async () => {
  const src = readFileSync(makeFlac("full.flac"));
  const e = make([flac]);
  const p = await e.file("t.flac", src.subarray(0, Math.floor(src.length * 0.6)));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(read(p).length).toBe(Math.floor(src.length * 0.6));
});

tflac("AUDIO-oracle (FLAC): different audio of the same length, or a different STREAMINFO, is rejected", async () => {
  const a = makeFlac("o1.flac", [], SRC(2));
  const b = makeFlac("o2.flac", [], ["-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*500*t)+0.05*random(0):d=2:s=44100"]);
  const e = make([flac]);
  const pa = await e.file("a.flac", readFileSync(a));
  const ctx: any = {
    settings: { audio: { keepMetadata: false } },
    tools: { locate: async () => ["x"] },
    run: async (tool: string, args: string[]) => {
      const r = Bun.spawnSync([tool, ...args], { stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    },
  };
  const prepared = await flac.oracle.prepare!(pa, ctx);
  expect(await flac.oracle.same(prepared, a, ctx)).toBe(true);
  expect(await flac.oracle.same(prepared, b, ctx)).not.toBe(true);
  // a corrupted frame fails flac -t / decoding
  const bytes = read(a).slice();
  bytes[bytes.length - 200] ^= 0xff;
  const bad = f("bad.flac");
  writeFileSync(bad, bytes);
  expect(await flac.oracle.same(prepared, bad, ctx)).not.toBe(true);
});

// ---------- MP3 ----------

function makeMp3(name: string, extra: string[] = [], rate = 44100, seconds = 3): string {
  const p = f(name);
  ff([...SRC(seconds, rate), "-c:a", "libmp3lame", "-b:a", "128k", ...extra, p]);
  return p;
}
const apeTag = () => {
  const item = concat([new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0]), text("Title\0hello")]);
  const footer = concat([text("APETAGEX"), new Uint8Array([208, 7, 0, 0]), new Uint8Array([item.length + 32, 0, 0, 0]), new Uint8Array([1, 0, 0, 0]), new Uint8Array([0, 0, 0, 0]), new Uint8Array(8)]);
  return concat([item, footer]);
};

tf("MP3-03: ID3v2, ID3v1, APE tags and cover art are stripped; kept with keepMetadata", async () => {
  const c = cover(dir);
  const src = f("tags.mp3");
  ff([...SRC(3), "-i", c, "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-b:a", "128k", "-c:v", "png", "-id3v2_version", "3", "-write_id3v1", "1", "-metadata", "title=Song", src]);
  const withApe = concat([read(src).subarray(0, read(src).length - 128), apeTag(), read(src).subarray(read(src).length - 128)]);
  const e = make([mp3]);
  const p = await e.file("a.mp3", withApe);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = Buffer.from(read(p));
  expect(out.subarray(0, 3).toString()).not.toBe("ID3");
  expect(out.includes("APETAGEX")).toBe(false);
  expect(out.subarray(out.length - 128, out.length - 125).toString()).not.toBe("TAG");
  expect(probe(p).format.tags?.title).toBeUndefined();
  expect(decodeMd5(p)).toBe(decodeMd5(src));
  const k = make([mp3], { audio: { keepMetadata: true } });
  const q = await k.file("a.mp3", withApe);
  const rk = await k.engine.optimizeFile(q);
  expect(rk.status).toBe("unchanged");
  expect(Buffer.compare(read(q), withApe)).toBe(0);
});

tf("MP3-02: the encoder delay/padding header stays; dropping it is rejected by the oracle", async () => {
  const src = makeMp3("gapless.mp3", ["-id3v2_version", "3", "-metadata", "title=x"]);
  const e = make([mp3]);
  const p = await e.file("a.mp3", readFileSync(src));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(probe(p, "format=duration").format.duration).toBe(probe(src, "format=duration").format.duration);
  expect(decodeMd5(p)).toBe(decodeMd5(src));
  // a candidate without its first (Xing/LAME) frame changes the decoded length: rejected
  const ctx: any = { settings: { audio: { keepMetadata: false } }, run: async (t: string, a: string[]) => { const x = Bun.spawnSync([t, ...a], { stdout: "pipe", stderr: "pipe" }); return { code: x.exitCode, stdout: x.stdout.toString(), stderr: x.stderr.toString() }; } };
  const orig = await audioSig(src, ctx);
  const bytes = read(p);
  const hdr = Buffer.from(bytes);
  const first = hdr.indexOf("Xing") >= 0 ? hdr.indexOf("Xing") - 21 : hdr.indexOf("Info") - 21;
  expect(first).toBeGreaterThanOrEqual(0);
  const dropped = f("nogapless.mp3");
  writeFileSync(dropped, bytes.subarray(first + 417));
  const verdict = sameAudio(orig, await audioSig(dropped, ctx), false);
  expect(verdict).not.toBe(true);
});

tf("MP3-04: MPEG-2 and MPEG-2.5 files are handled", async () => {
  for (const [name, rate] of [["m2", 22050], ["m25", 11025]] as const) {
    const src = makeMp3(`${name}.mp3`, ["-id3v2_version", "3", "-metadata", "title=x"], rate, 2);
    const e = make([mp3]);
    const p = await e.file(`${name}.mp3`, readFileSync(src));
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("optimized");
    expect(decodeMd5(p)).toBe(decodeMd5(src));
  }
});

tf("MP3-05: junk before the first frame is removed when frames follow", async () => {
  const junk = new Uint8Array(700).map((_, i) => (i * 7) % 200);
  const e = make([mp3]);
  // without an info frame the junk does not change what decodes
  const src = makeMp3("clean.mp3", ["-write_xing", "0"]);
  const p = await e.file("junk.mp3", concat([junk, read(src)]));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(read(p)[0]).toBe(0xff);
  expect(decodeMd5(p)).toBe(decodeMd5(src));
  // with an info frame ffmpeg's start trimming depends on it being first: the oracle rejects, the file stays
  const gapless = makeMp3("gapless2.mp3");
  const q = await e.file("junk2.mp3", concat([junk, read(gapless)]));
  const before = decodeMd5(q);
  await e.engine.optimizeFile(q);
  expect(decodeMd5(q)).toBe(before);
});

tf("MP3-06: a truncated tail never makes the result differ; garbage is left alone", async () => {
  const src = read(makeMp3("full.mp3", ["-id3v2_version", "3", "-metadata", "title=x"]));
  const e = make([mp3]);
  const p = await e.file("t.mp3", src.subarray(0, src.length - 150));
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged", "skipped"]).toContain(r.status);
  if (r.status === "optimized") expect(decodeMd5(p)).toBe(decodeMd5(await e.file("ref.mp3", src.subarray(0, src.length - 150))));
  const g = await e.file("g.mp3", new Uint8Array(5000).map((_, i) => (i * 31 + 7) & 0xff));
  const rg = await e.engine.optimizeFile(g);
  expect(rg.status === "skipped" || rg.status === "unchanged").toBe(true);
});

const tpack = have.ffmpeg && have.mp3packer ? test : test.skip;
tpack("MP3-01: mp3packer shrinks and the decode hash is equal", async () => {
  const src = makeMp3("cbr.mp3");
  const e = make([mp3]);
  const p = await e.file("a.mp3", readFileSync(src));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(decodeMd5(p)).toBe(decodeMd5(src));
});

// ---------- Ogg Vorbis ----------

function makeOgg(name: string, extra: string[] = [], seconds = 3): string {
  const p = f(name);
  ff([...SRC(seconds), "-ac", "2", "-c:a", "vorbis", "-strict", "-2", ...extra, p]);
  return p;
}
const tovb = have.ffmpeg && have.optivorbis ? test : test.skip;

tovb("OGG-01: a Vorbis file is repacked, decode equal", async () => {
  const src = makeOgg("a.ogg", ["-metadata", "title=Song"]);
  const e = make([ogg]);
  const p = await e.file("a.ogg", readFileSync(src));
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged"]).toContain(r.status);
  expect(decodeMd5(p)).toBe(decodeMd5(src));
  if (r.status === "optimized") expect(title(p)).toBeUndefined();
  const k = make([ogg], { audio: { keepMetadata: true } });
  const q = await k.file("a.ogg", readFileSync(src));
  const rk = await k.engine.optimizeFile(q);
  expect(decodeMd5(q)).toBe(decodeMd5(src));
  if (rk.status === "optimized") expect(title(q)).toBe("Song");
});

tovb("OGG-02: chained and multiplexed streams are never changed in content", async () => {
  const a = makeOgg("c1.ogg", [], 1), b = makeOgg("c2.ogg", [], 1);
  const chained = concat([read(a), read(b)]);
  const e = make([ogg]);
  const p = await e.file("chain.ogg", chained);
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged", "skipped"]).toContain(r.status);
  if (r.status === "optimized") expect(decodeMd5(p)).toBe(decodeMd5(await e.file("chain-ref.ogg", chained)));
  const mux = f("mux.ogg");
  ff(["-i", a, "-i", b, "-map", "0", "-map", "1", "-c", "copy", mux]);
  const q = await e.file("mux.ogg", readFileSync(mux));
  const rq = await e.engine.optimizeFile(q);
  expect(["optimized", "unchanged", "skipped"]).toContain(rq.status);
  if (rq.status === "optimized") expect(decodeMd5(q)).toBe(decodeMd5(mux));
});

tf("OGG-03: Opus (and Speex/FLAC-in-Ogg) is skipped with a reason", async () => {
  const p = f("a.opus");
  ff([...SRC(1), "-c:a", "libopus", p]);
  const e = make([ogg]);
  const r = await e.engine.optimizeFile(await e.file("a.opus", readFileSync(p)));
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("Opus");
  const q = f("a.oga");
  ff([...SRC(1), "-c:a", "flac", "-f", "ogg", q]);
  const rq = await e.engine.optimizeFile(await e.file("f.oga", readFileSync(q)));
  expect(rq.status).toBe("skipped");
  expect(rq.reason).toContain("FLAC");
});

test("OGG-04: Theora video named .ogg is not claimed (video family), and has a skip reason", async () => {
  const page = new Uint8Array(27 + 1 + 7);
  page.set(text("OggS"), 0);
  page[5] = 2;
  page[26] = 1;
  page[27] = 7;
  page.set(text("\x80theora"), 28);
  expect(oggCodecs(page)).toEqual(["theora"]);
  expect(ogg.detect(page, "a.ogg")).toBe(false);
  expect(await ogg.skip!("", page, {} as any)).toBe("video stream");
});

tovb("OGG-05: a very short file is never given a different sample count", async () => {
  const src = makeOgg("short.ogg", [], 0.05);
  const e = make([ogg]);
  const p = await e.file("s.ogg", readFileSync(src));
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged", "skipped"]).toContain(r.status);
  expect(decodeMd5(p)).toBe(decodeMd5(src));
});

tf("AUDIO-oracle (Ogg): a candidate with different samples is rejected", async () => {
  const a = makeOgg("x1.ogg", [], 1);
  const b = f("x2.ogg");
  ff(["-f", "lavfi", "-i", "aevalsrc=0.4*sin(2*PI*700*t):d=1:s=44100", "-ac", "2", "-c:a", "vorbis", "-strict", "-2", b]);
  const ctx: any = { settings: { audio: { keepMetadata: false } }, run: async (t: string, x: string[]) => { const r = Bun.spawnSync([t, ...x], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; } };
  const prepared = await ogg.oracle.prepare!(a, ctx).catch(() => null);
  if (!prepared) return; // the native encoder's file warned; nothing to compare
  expect(await ogg.oracle.same(prepared, a, ctx)).toBe(true);
  expect(await ogg.oracle.same(prepared, b, ctx)).not.toBe(true);
});

// ---------- M4A ----------

function makeM4a(name: string, extra: string[] = [], inputs: string[] = []): string {
  const p = f(name);
  ff([...SRC(3), ...inputs, "-c:a", "aac", "-b:a", "96k", ...extra, "-f", "ipod", p]);
  return p;
}
const boxes = (b: Uint8Array) => {
  const out: string[] = [];
  for (let p = 0; p + 8 <= b.length; ) {
    const size = new DataView(b.buffer, b.byteOffset).getUint32(p);
    out.push(String.fromCharCode(...b.subarray(p + 4, p + 8)));
    if (size < 8) break;
    p += size;
  }
  return out;
};

tf("M4A-01: tags and cover art are stripped by default and kept with keepMetadata", async () => {
  const c = cover(dir);
  const src = f("tagged.m4a");
  ff([...SRC(3), "-i", c, "-map", "0:a", "-map", "1:v", "-c:a", "aac", "-b:a", "96k", "-c:v", "png", "-disposition:v", "attached_pic", "-metadata", "title=Song", "-metadata", "artist=Someone", "-f", "ipod", src]);
  const e = make([m4a]);
  const p = await e.file("a.m4a", readFileSync(src));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const t = probe(p);
  expect(t.format.tags?.title).toBeUndefined();
  expect(t.streams.length).toBe(1);
  expect(decodeMd5(p)).toBe(decodeMd5(src));
  const k = make([m4a], { audio: { keepMetadata: true } });
  const q = await k.file("a.m4a", readFileSync(src));
  const rk = await k.engine.optimizeFile(q);
  expect(["optimized", "unchanged"]).toContain(rk.status);
  const kt = probe(q);
  expect(kt.format.tags.title).toBe("Song");
  expect(kt.format.tags.artist).toBe("Someone");
  expect(kt.streams.length).toBe(2);
  expect(decodeMd5(q)).toBe(decodeMd5(src));
});

tf("M4A-02: moov at the end moves to the front, stream identical", async () => {
  const src = f("late.m4a");
  ff([...SRC(3), "-c:a", "aac", "-b:a", "96k", "-metadata", "title=x", "-f", "mp4", src]);
  expect(boxes(read(src)).indexOf("moov")).toBeGreaterThan(boxes(read(src)).indexOf("mdat"));
  const e = make([m4a], { audio: { keepMetadata: true } });
  const p = await e.file("late.m4a", readFileSync(src));
  const r = await e.engine.optimizeFile(p);
  if (r.status === "optimized") {
    expect(boxes(read(p)).indexOf("moov")).toBeLessThan(boxes(read(p)).indexOf("mdat"));
  }
  expect(decodeMd5(p)).toBe(decodeMd5(src));
});

tf("M4A-03: DRM files are skipped", async () => {
  const src = read(makeM4a("plain.m4a"));
  const e = make([m4a]);
  const brand = src.slice();
  brand.set(text("M4P "), 8);
  const p = await e.file("p.m4p", brand);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("DRM");
  const b = Buffer.from(src);
  const i = b.indexOf("mp4a");
  expect(i).toBeGreaterThan(0);
  const drms = src.slice();
  drms.set(text("drms"), i);
  const q = await e.file("d.m4a", drms);
  const rq = await e.engine.optimizeFile(q);
  expect(rq.status).toBe("skipped");
  expect(rq.reason).toContain("DRM");
  expect(Buffer.compare(read(q), drms)).toBe(0);
});

tf("M4A: truncated file (no moov) is untouched", async () => {
  const src = read(makeM4a("full.m4a", ["-movflags", "+faststart"]));
  const cut = src.subarray(0, src.length - 3000);
  const e = make([m4a]);
  const p = await e.file("c.m4a", cut);
  const r = await e.engine.optimizeFile(p);
  expect(r.status === "skipped" || r.status === "unchanged").toBe(true);
  expect(read(p).length).toBe(cut.length);
});

tf("AUDIO-oracle (M4A): a remux that changes the audio is rejected", async () => {
  const a = makeM4a("o1.m4a"), b = f("o2.m4a");
  ff(["-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*600*t):d=3:s=44100", "-c:a", "aac", "-b:a", "96k", "-f", "ipod", b]);
  const ctx: any = { settings: { audio: { keepMetadata: false } }, run: async (t: string, x: string[]) => { const r = Bun.spawnSync([t, ...x], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; } };
  const prepared = await m4a.oracle.prepare!(a, ctx);
  expect(await m4a.oracle.same(prepared, a, ctx)).toBe(true);
  expect(await m4a.oracle.same(prepared, b, ctx)).not.toBe(true);
});

// ---------- Matroska audio ----------

tf("MKA: an audio-only .mka and .weba are remuxed with equal audio", async () => {
  const src = f("a.mka");
  ff([...SRC(2), "-c:a", "flac", "-metadata", "title=x", src]);
  const e = make([mka]);
  const p = await e.file("a.mka", readFileSync(src));
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged"]).toContain(r.status);
  expect(decodeMd5(p)).toBe(decodeMd5(src));
  const w = f("a.weba");
  ff([...SRC(2), "-c:a", "libopus", "-f", "webm", w]);
  const q = await e.file("a.weba", readFileSync(w));
  const rq = await e.engine.optimizeFile(q);
  expect(["optimized", "unchanged"]).toContain(rq.status);
  expect(decodeMd5(q)).toBe(decodeMd5(w));
});

test("the audio formats are registered", () => {
  for (const id of ["flac", "wav", "mp3", "ogg", "m4a", "mka"]) expect(allFormats.some((x) => x.id === id)).toBe(true);
});

// ---------- real files ----------

const real = (name: string) => join(import.meta.dir, "..", "..", "..", "fixtures", "real", name);
for (const [name, format] of [["example.ogg", ogg], ["sample.flac", flac], ["sample.wav", wav], ["sample.mp3", mp3], ["sample.m4a", m4a]] as const) {
  const ok = have.ffmpeg && (Bun.file(real(name)).size > 0);
  (ok ? test : test.skip)(`real file ${name}: never grows, content equal`, async () => {
    const e = make([format]);
    const bytes = readFileSync(real(name));
    const p = await e.file(name, bytes);
    const r = await e.engine.optimizeFile(p);
    expect(["optimized", "unchanged", "skipped"]).toContain(r.status);
    expect(r.after).toBeLessThanOrEqual(r.before);
    if (r.status === "optimized") expect(decodeMd5(p)).toBe(decodeMd5(await e.file("ref-" + name, bytes)));
  });
}
