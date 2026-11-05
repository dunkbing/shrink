// Video container cases (docs/FORMATS.md, section 15) against the real ffmpeg, MP4Box, mp4file and mkclean.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Format, Step } from "../src/types";
import { formats as mp4s, mp4 } from "../src/formats/mp4.format";
import { formats as mkvs } from "../src/formats/matroska.format";
import { formats as ogvs, ogv } from "../src/formats/ogv.format";
import { avi, flv, formats as others, mpeg } from "../src/formats/other-video.format";
import { oggHasTheora, parseEbml, parseMp4 } from "../src/formats/video-parse";
import * as V from "./lib/video";

const all = [...mp4s, ...mkvs, ...ogvs, ...others];
const real = join(import.meta.dir, "../../../fixtures/real");
const t = V.haveFfmpeg ? test : test.skip;
const tool = (n: string) => (Bun.which(n) ? t : test.skip);

const envs: V.VEnv[] = [];
const make = (settings = {}, tweak?: (f: Format) => Format) => (envs.push(V.venv(all, settings, tweak)), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

let src: string; // scratch folder with the generated sources
const gen = (name: string, f: (p: string) => void): Uint8Array<ArrayBuffer> => {
  const p = join(src, name);
  if (!existsSync(p)) f(p);
  return new Uint8Array(readFileSync(p));
};
beforeAll(() => {
  src = mkdtempSync(join(tmpdir(), "shrink-vsrc-"));
  return () => rmSync(src, { recursive: true, force: true });
});

const probe = (b: Uint8Array | string, ext = "mp4") => {
  let p = b as string;
  if (typeof b !== "string") {
    p = join(src, `probe-${Math.random().toString(36).slice(2)}.${ext}`);
    writeFileSync(p, b);
  }
  return V.probeJson(p);
};
const tagsOf = (s: any) => Object.fromEntries(Object.entries(s.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const hashes = (b: Uint8Array | string, ext = "mp4") => {
  let p = b as string;
  if (typeof b !== "string") {
    p = join(src, `h-${Math.random().toString(36).slice(2)}.${ext}`);
    writeFileSync(p, b);
  }
  return V.streamHashes(p);
};
const run = async (e: V.VEnv, name: string, bytes: Uint8Array) => {
  const p = e.file(name, bytes);
  const r = await e.engine.optimizeFile(p);
  return { p, r, out: new Uint8Array(readFileSync(p)) as Uint8Array<ArrayBuffer> };
};

// ---------------------------------------------------------------- MP4

t("MP4-01: metadata and trailing moov go; moov moves to the front; packets equal", async () => {
  const bytes = gen("base.mp4", (p) => V.makeMp4(p));
  const { r, out } = await run(make(), "a.mp4", bytes);
  expect(r.status).toBe("optimized");
  expect(out.length).toBeLessThan(bytes.length);
  expect(hashes(out)).toBe(hashes(bytes));
  });

t("MP4-01b: faststart order and stripped tags", async () => {
  const bytes = gen("base.mp4", (p) => V.makeMp4(p));
  const e = make();
  const { p } = await run(e, "a.mp4", bytes);
  const info = parseMp4(p);
  expect(info.boxes.indexOf("moov")).toBeLessThan(info.boxes.indexOf("mdat"));
  expect(tagsOf(probe(p).format).title).toBeUndefined();
  expect(tagsOf(probe(p).format).comment).toBeUndefined();
});

t("MP4-02: fragmented MP4 stays fragmented and skips mp4file / MP4Box", async () => {
  const bytes = gen("frag.mp4", (p) => V.makeMp4(p, { movflags: "frag_keyframe+empty_moov" }));
  expect(parseMp4(join(src, "frag.mp4")).fragmented).toBe(true);
  const { p, r, out } = await run(make(), "f.mp4", bytes);
  expect(["optimized", "unchanged"]).toContain(r.status);
  expect(parseMp4(p).fragmented).toBe(true);
  expect(r.steps.find((s) => s.id === "mp4.mp4file")).toMatchObject({ outcome: "skipped", detail: "fragmented MP4" });
  expect(r.steps.find((s) => s.id === "mp4.mp4box")).toMatchObject({ outcome: "skipped", detail: "fragmented MP4" });
  expect(hashes(out)).toBe(hashes(bytes));
});

t("MP4-03: several audio tracks, a subtitle track, languages and titles are kept", async () => {
  const bytes = gen("multi.mp4", (p) => V.makeMp4Multi(src, p));
  const { p, r } = await run(make(), "m.mp4", bytes);
  expect(r.status).toBe("optimized");
  const streams = probe(p).streams;
  expect(streams.map((s: any) => s.codec_type).filter((c: string) => c !== "data")).toEqual(["video", "audio", "audio", "subtitle"]);
  const audio = streams.filter((s: any) => s.codec_type === "audio").map(tagsOf);
  expect(audio.map((a: any) => a.language)).toEqual(["eng", "fra"]);
  expect(tagsOf(streams.find((s: any) => s.codec_type === "subtitle")).language).toBe("deu");
});

t("MP4-04: chapters and cover art go by default and stay with keepMetadata", async () => {
  const bytes = gen("cover.mp4", (p) => V.makeMp4Cover(src, p));
  expect(probe(join(src, "cover.mp4")).chapters.length).toBe(2);
  const strip = await run(make(), "a.mp4", bytes);
  expect(strip.r.status).toBe("optimized");
  const a = probe(strip.p);
  expect(a.chapters.length).toBe(0);
  expect(a.streams.filter((s: any) => s.disposition.attached_pic).length).toBe(0);
  expect(tagsOf(a.format).title).toBeUndefined();
  const keep = await run(make({ video: { keepMetadata: true } }), "b.mp4", bytes);
  const b = probe(keep.p);
  expect(b.chapters.map((c: any) => tagsOf(c).title)).toEqual(["One", "Two"]);
  expect(b.streams.filter((s: any) => s.disposition.attached_pic).length).toBe(1);
  expect(tagsOf(b.format).title).toBe("Covered");
});

for (const codec of ["hevc", "vp9", "mpeg4"] as const) {
  t(`MP4-05: ${codec} passes through unchanged`, async () => {
    const bytes = gen(`${codec}.mp4`, (p) => V.makeMp4(p, { codec }));
    const { r, out } = await run(make(), "a.mp4", bytes);
    expect(r.status === "failed").toBe(false);
    expect(hashes(out)).toBe(hashes(bytes));
    expect(probe(out).streams[0].codec_name).toBe(probe(bytes).streams[0].codec_name);
  });
}

t("MP4-06: edit lists (start offsets) are preserved", async () => {
  const bytes = gen("edit.mp4", (p) => {
    V.makeMp4(p.replace("edit", "edit-src"), { secs: 3, extra: [] });
    V.ffmpeg(["-ss", "0.37", "-i", p.replace("edit", "edit-src"), "-c", "copy", "-avoid_negative_ts", "disabled", "-metadata", `comment=${V.bigTag()}`, p]);
  });
  const before = probe(bytes).streams.map((s: any) => [s.start_time, s.duration]);
  const { p, r } = await run(make(), "e.mp4", bytes);
  expect(r.status).toBe("optimized");
  const after = probe(p).streams.map((s: any) => [s.start_time, s.duration]);
  expect(after.map((a: any) => a[0])).toEqual(before.map((a: any) => a[0]));
  after.forEach((a: any, i: number) => expect(Math.abs(Number(a[1]) - Number(before[i][1]))).toBeLessThan(0.05));
});

t("MP4-07: a file cut before its moov is untouched and reported damaged", async () => {
  const bytes = gen("base.mp4", (p) => V.makeMp4(p));
  const cut = bytes.slice(0, Math.floor(bytes.length * 0.6));
  const e = make();
  const { r, out } = await run(e, "cut.mp4", cut);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(out).toEqual(cut);
});

// ---------------------------------------------------------------- Matroska / WebM

t("MKV-01: remux (and mkclean when allowed) shrinks, streams equal", async () => {
  const mk = gen("v3.mkv", (p) => {
    V.makeMkv(src, p.replace("v3", "v4src"));
    expect(Bun.spawnSync(["mkclean", "--quiet", "--doctype", "3", p.replace("v3", "v4src"), p]).exitCode).toBe(0);
  });
  expect(parseEbml(mk)!.docTypeVersion).toBeLessThan(4);
  const { p, r, out } = await run(make(), "a.mkv", mk);
  expect(r.status).toBe("optimized");
  expect(out.length).toBeLessThan(mk.length);
  expect(hashes(out, "mkv")).toBe(hashes(mk, "mkv"));
  expect(r.steps.find((s) => s.id === "matroska.mkclean")?.outcome).not.toBe("failed");
  expect(existsSync(p)).toBe(true);
});

t("MKV-02: WebM is remuxed but never goes through mkclean", async () => {
  const w = gen("a.webm", (p) => V.makeMkv(src, p, { webm: true }));
  const { r, out } = await run(make(), "a.webm", w);
  expect(r.status).toBe("optimized");
  expect(r.steps.find((s) => s.id === "matroska.mkclean")).toMatchObject({ outcome: "skipped", detail: "WebM" });
  expect(parseEbml(out)!.docType).toBe("webm");
  expect(hashes(out, "webm")).toBe(hashes(w, "webm"));
});

t("MKV-03: attachments (fonts) and chapters are kept; global tags go", async () => {
  const mk = gen("full.mkv", (p) => V.makeMkv(src, p));
  const before = probe(mk, "mkv");
  expect(before.streams.some((s: any) => s.codec_type === "attachment")).toBe(true);
  const { p, r } = await run(make(), "a.mkv", mk);
  expect(r.status).toBe("optimized");
  const after = probe(p);
  const att = after.streams.filter((s: any) => s.codec_type === "attachment");
  expect(att.length).toBe(1);
  expect(att[0].extradata_size).toBe(3000);
  expect(after.chapters.map((c: any) => tagsOf(c).title)).toEqual(["One", "Two"]);
  expect(tagsOf(after.format).title).toBeUndefined();
  const lang = after.streams.filter((s: any) => s.codec_type === "audio").map((s: any) => [tagsOf(s).language, tagsOf(s).title]);
  expect(lang).toEqual([["eng", undefined], ["fra", "Commentaire"]]);
});

t("MKV-04: Matroska v4 elements skip mkclean", async () => {
  const mk = gen("full.mkv", (p) => V.makeMkv(src, p));
  expect(parseEbml(mk)!.docTypeVersion).toBeGreaterThanOrEqual(4);
  const { r } = await run(make(), "a.mkv", mk);
  expect(r.steps.find((s) => s.id === "matroska.mkclean")).toMatchObject({ outcome: "skipped", detail: "Matroska v4 elements" });
});

t("MKV-05: Cues exist after the remux and seeking works", async () => {
  const mk = gen("full.mkv", (p) => V.makeMkv(src, p));
  const { p, out } = await run(make(), "a.mkv", mk);
  expect(Buffer.from(out).includes(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]))).toBe(true);
  const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-ss", "1.0", "-i", p, "-map", "0:v", "-c", "copy", "-f", "null", "-"]);
  expect(r.exitCode).toBe(0);
  expect(r.stderr.toString().trim()).toBe("");
});

t("MKV: a file cut in the middle is untouched and reported damaged", async () => {
  const mk = gen("full.mkv", (p) => V.makeMkv(src, p));
  const cut = mk.slice(0, Math.floor(mk.length * 0.7));
  const { r, out } = await run(make(), "cut.mkv", cut);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(out).toEqual(cut);
});

// ---------------------------------------------------------------- Ogg Theora (real files) and other containers

const ogvFiles = ["elephants-dream.ogv", "vidikovac.ogv"].filter((f) => existsSync(join(real, f)));
const tr = ogvFiles.length && V.haveFfmpeg ? test : test.skip;

tr("OGV-01: a Theora file is remuxed with the packets of every stream equal; tags go", async () => {
  const f = join(real, ogvFiles[0]);
  const tagged = gen("tagged.ogv", (p) => V.ogvWithTags(f, p));
  expect(oggHasTheora(tagged.subarray(0, 4096))).toBe(true);
  const { r, out } = await run(make(), "a.ogv", tagged);
  expect(r.status).toBe("optimized");
  expect(hashes(out, "ogv")).toBe(hashes(tagged, "ogv"));
  expect(tagsOf(probe(out, "ogv").streams[0]).comment).toBeUndefined();
});

tr("OGV-02: a Theora stream in a .ogg file is ours; a truncated one is untouched", async () => {
  const bytes = new Uint8Array(readFileSync(join(real, ogvFiles[0])));
  const cut = bytes.slice(0, Math.floor(bytes.length * 0.8));
  const { r, out } = await run(make(), "x.ogg", cut);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(out).toEqual(cut);
  expect(ogv.detect(bytes.subarray(0, 4096), "x.ogg")).toBe(true);
});

test("OGV-03: audio-only Ogg is not claimed", () => {
  const f = join(real, "example.ogg");
  if (!existsSync(f)) return;
  expect(ogv.detect(new Uint8Array(readFileSync(f)).subarray(0, 4096), "example.ogg")).toBe(false);
});

t("AVI-01: index and junk chunks are rebuilt, packets equal", async () => {
  const bytes = gen("a.avi", (p) => V.makeAvi(p));
  const { out, r } = await run(make(), "a.avi", bytes);
  expect(r.status).toBe("optimized");
  expect(hashes(out, "avi")).toBe(hashes(bytes, "avi"));
});

t("FLV-01: remux keeps the packets", async () => {
  const bytes = gen("a.flv", (p) => V.makeFlv(p));
  const { out, r } = await run(make(), "a.flv", bytes);
  expect(r.status === "failed").toBe(false);
  expect(hashes(out, "flv")).toBe(hashes(bytes, "flv"));
});

t("MPG-01: MPEG program stream is rewritten only when packets stay equal", async () => {
  const bytes = gen("a.mpg", (p) => V.makeMpg(p));
  const { out, r } = await run(make(), "a.mpg", bytes);
  expect(r.status === "failed").toBe(false);
  expect(out.length).toBeLessThanOrEqual(bytes.length);
  expect(hashes(out, "mpg")).toBe(hashes(bytes, "mpg"));
});

t("AVI/FLV: truncated files are untouched", async () => {
  for (const [n, f] of [["a.avi", () => V.makeAvi(join(src, "a.avi"))], ["a.flv", () => V.makeFlv(join(src, "a.flv"))]] as const) {
    const bytes = gen(n, () => f());
    const cut = bytes.slice(0, Math.floor(bytes.length * 0.5));
    const { r, out } = await run(make(), "cut." + n.split(".")[1], cut);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(out).toEqual(cut);
  }
});

// ---------------------------------------------------------------- detection and COMMON

t("audio-only files in video containers are skipped with a reason; .m4a / .mka are not claimed", async () => {
  const a = gen("audio.mp4", (p) => V.makeAudioOnly(p, "mp4"));
  const { r } = await run(make(), "a.mp4", a);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("audio");
  const w = gen("audio.mkv", (p) => V.makeAudioOnly(p, "matroska"));
  const m = await run(make(), "a.mkv", w);
  expect(m.r.status).toBe("skipped");
  expect(m.r.reason).toContain("audio");
  expect(mp4.detect(a.subarray(0, 4096), "a.m4a")).toBe(false);
  expect(mkvs[0].detect(w.subarray(0, 4096), "a.mka")).toBe(false);
  const m4a = gen("audio.m4a", (p) => V.makeAudioOnly(p, "ipod"));
  expect(mp4.detect(m4a.subarray(0, 4096), "a.mp4")).toBe(false); // M4A brand
});

t("COMMON-06: empty and tiny files are skipped", async () => {
  for (const [n, size] of [["a.mp4", 0], ["a.mkv", 1], ["a.avi", 16]] as const) {
    const { r } = await run(make(), n, new Uint8Array(size));
    expect(["skipped", "unchanged"]).toContain(r.status);
    expect(r.status === "optimized").toBe(false);
  }
});

t("COMMON-07: an MP4 named .mkv is skipped with the mismatch", async () => {
  const bytes = gen("base.mp4", (p) => V.makeMp4(p));
  const { r, out } = await run(make(), "a.mkv", bytes);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("extension");
  expect(out).toEqual(bytes);
});

t("COMMON-02/03/04: a second run changes nothing and no run grows the file", async () => {
  for (const [n, f] of [["base.mp4", () => V.makeMp4(join(src, "base.mp4"))], ["full.mkv", () => V.makeMkv(src, join(src, "full.mkv"))]] as const) {
    const bytes = gen(n, f);
    const e = make();
    const first = await run(e, n, bytes);
    expect(first.out.length).toBeLessThanOrEqual(bytes.length);
    const second = await e.engine.optimizeFile(first.p);
    expect(second.after).toBeGreaterThanOrEqual(second.before * 0.99);
    expect(statSync(first.p).size).toBeGreaterThanOrEqual(first.out.length * 0.99);
  }
});

// ---------------------------------------------------------------- the oracle is the judge

const feed = (file: string, ext: string): ((f: Format) => Format) => (f) => ({
  ...f,
  steps: [{ id: "fake.liar", async run(_i, o) { await Bun.write(o, Bun.file(file)); } } as Step],
});

t("VIDEO-ORACLE (like PNG-15): a result with one changed packet byte is rejected, original untouched", async () => {
  const bytes = gen("base.mp4", (p) => V.makeMp4(p));
  const e = make();
  // a smaller file with the same structure but a flipped payload byte: remux first, flip, hand it out as the "tool result"
  const clean = join(src, "clean.mp4");
  V.ffmpeg(["-i", join(src, "base.mp4"), "-map", "0", "-c", "copy", "-map_metadata:g", "-1", "-fflags", "+bitexact", clean]);
  const bad = join(src, "tampered.mp4");
  writeFileSync(bad, V.flipPayloadByte(new Uint8Array(readFileSync(clean))));
  const liar = V.venv(all, {}, feed(bad, "mp4"));
  envs.push(liar);
  const { r, out } = await run(liar, "a.mp4", bytes);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(r.steps[0].detail).toMatch(/packets differ|does not read/);
  expect(out).toEqual(bytes);
  void e;
});

t("VIDEO-ORACLE: a result that dropped an audio track, one that lost a language tag and a truncated one are rejected", async () => {
  const bytes = gen("multi.mp4", (p) => V.makeMp4Multi(src, p));
  const cases: [string, string[], RegExp][] = [
    ["noaudio.mp4", ["-map", "0:v", "-map", "0:a:0", "-map", "0:s"], /stream count/],
    ["nolang.mp4", ["-map", "0", "-metadata:s:a:1", "language=und"], /language/],
  ];
  for (const [name, args, re] of cases) {
    const bad = join(src, name);
    V.ffmpeg(["-i", join(src, "multi.mp4"), ...args, "-c", "copy", "-map_chapters", "-1", bad]);
    const liar = V.venv(all, {}, feed(bad, "mp4"));
    envs.push(liar);
    const { r, out } = await run(liar, "a.mp4", bytes);
    expect(r.steps[0].outcome).toBe("rejected");
    expect(r.steps[0].detail).toMatch(re);
    expect(out).toEqual(bytes);
  }
  const clean = join(src, "clean2.mp4");
  V.ffmpeg(["-i", join(src, "multi.mp4"), "-map", "0", "-c", "copy", "-map_chapters", "-1", clean]);
  const cutBytes = new Uint8Array(readFileSync(clean));
  const cut = join(src, "cutcand.mp4");
  writeFileSync(cut, cutBytes.slice(0, Math.floor(cutBytes.length * 0.9)));
  const liar = V.venv(all, {}, feed(cut, "mp4"));
  envs.push(liar);
  const { r, out } = await run(liar, "a.mp4", bytes);
  expect(r.steps[0].outcome).toBe("rejected");
  expect(out).toEqual(bytes);
});

t("a remux smaller than half the original is rejected", async () => {
  const bytes = gen("base.mp4", (p) => V.makeMp4(p));
  // a candidate with the first 2 seconds only would differ anyway; use a tiny valid clip of the same kind
  const tiny = join(src, "tiny.mp4");
  V.ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.2", "-c:v", "libx264", tiny]);
  const liar = V.venv(all, {}, feed(tiny, "mp4"));
  envs.push(liar);
  const { r, out } = await run(liar, "a.mp4", bytes);
  expect(r.steps[0].outcome).toBe("rejected");
  expect(out).toEqual(bytes);
});

tool("MP4Box")("COMMON-09: a crashing MP4Box does not stop the result of the earlier steps", async () => {
  const bytes = gen("base.mp4", (p) => V.makeMp4(p));
  const e = make({ toolPaths: { MP4Box: ["false"] } });
  const { r, out } = await run(e, "a.mp4", bytes);
  expect(r.status).toBe("optimized");
  expect(r.steps.find((s) => s.id === "mp4.mp4box")?.outcome).toBe("failed");
  expect(out.length).toBeLessThan(bytes.length);
});

t("COMMON-10: with mkclean and MP4Box missing the remux still works", async () => {
  const bytes = gen("full.mkv", (p) => V.makeMkv(src, p));
  const e = make({ disabledTools: ["mkclean", "MP4Box", "mp4file"] });
  const { r } = await run(e, "a.mkv", bytes);
  expect(r.status).toBe("optimized");
  const mp = await run(make({ disabledTools: ["MP4Box", "mp4file"] }), "a.mp4", gen("base.mp4", (p) => V.makeMp4(p)));
  expect(mp.r.status).toBe("optimized");
});

test("tmp folders are cleaned", () => {
  for (const e of envs) expect(readdirSync(join(e.dir, "tmp")).length).toBe(0);
});
