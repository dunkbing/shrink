// The COMMON cases (docs/SPEC.md) against the engine's own made-up format.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, readFileSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "../src";
import { env, fakeFormat, sample, trim, type Env } from "./fake";

const envs: Env[] = [];
const make = (o?: Parameters<typeof env>[0]) => (envs.push(env(o)), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const bloat: Step = { id: "fake.bloat", run: async (i, o) => void (await Bun.write(o, (await Bun.file(i).text()) + "\n".repeat(1000))) };
const liar: Step = { id: "fake.liar", run: async (i, o) => void (await Bun.write(o, "FAKE\nsomething else\nEND")) };
const crash: Step = { id: "fake.crash", run: async () => { throw new Error("boom"); } };
const silent: Step = { id: "fake.silent", run: async () => {} };
const hang: Step = { id: "fake.hang", run: (_i, _o, ctx) => new Promise((_, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")))) };
const missing: Step = { id: "fake.missing", tool: "no-such-tool-shrink", run: async () => {} };

test("COMMON-01: an optimisable file gets smaller and keeps its content", async () => {
  const e = make();
  const p = await e.file("a.fake", sample());
  const before = statSync(p).size;
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(before);
  expect(statSync(p).size).toBe(r.after);
  expect(readFileSync(p, "utf8")).toContain("line 7\n");
  expect(e.leftovers()).toEqual([]);
});

test("COMMON-02: a second run leaves the file alone (cache), and unchanged without the cache", async () => {
  const e = make();
  const p = await e.file("a.fake", sample());
  await e.engine.optimizeFile(p);
  const bytes = readFileSync(p);
  const again = await e.engine.optimizeFile(p);
  expect(again.status).toBe("skipped");
  expect(again.reason).toBe("already optimized");
  const e2 = make({ settings: { skipOptimized: false } });
  const q = await e2.file("b.fake", bytes);
  expect((await e2.engine.optimizeFile(q)).status).toBe("unchanged");
  expect(readFileSync(q)).toEqual(bytes);
});

test("COMMON-03/04: nothing grows; a step that makes the file bigger is not kept", async () => {
  const e = make({ steps: [bloat, trim, bloat] });
  const p = await e.file("a.fake", sample());
  const before = statSync(p).size;
  const r = await e.engine.optimizeFile(p);
  expect(statSync(p).size).toBeLessThan(before);
  expect(r.steps.map((s) => s.outcome)).toEqual(["not smaller", "kept", "not smaller"]);
});

test("COMMON-05: a damaged file is left alone", async () => {
  const e = make();
  const p = await e.file("a.fake", sample().slice(0, -10));
  const bytes = readFileSync(p);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("damaged");
  expect(readFileSync(p)).toEqual(bytes);
});

test("COMMON-06: empty and tiny files are skipped", async () => {
  const e = make();
  expect((await e.engine.optimizeFile(await e.file("e.fake", ""))).reason).toBe("empty file");
  expect((await e.engine.optimizeFile(await e.file("t.fake", "FAKE\nEND"))).reason).toBe("too small");
});

test("COMMON-07: found by content, and a content/extension mismatch is skipped", async () => {
  const other = { ...fakeFormat(), id: "other", extensions: ["oth"], detect: () => false };
  const e = make({ formats: [fakeFormat(), other] });
  const renamed = await e.file("a.dat", sample()); // nothing claims .dat: content decides
  expect((await e.engine.optimizeFile(renamed)).status).toBe("optimized");
  const wrong = await e.file("b.oth", sample()); // FAKE content named .oth
  const r = await e.engine.optimizeFile(wrong);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("extension");
  const unknown = await e.file("c.bin", "nothing to see here at all, honestly");
  expect((await e.engine.optimizeFile(unknown)).reason).toBe("unsupported format");
});

test("COMMON-08: a step that changes the content is rejected", async () => {
  const e = make({ steps: [liar, trim] });
  const p = await e.file("a.fake", sample());
  const r = await e.engine.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ id: "fake.liar", outcome: "rejected", detail: "content differs" });
  expect(r.steps[1].outcome).toBe("kept");
  const only = make({ steps: [liar] });
  const q = await only.file("a.fake", sample());
  const bytes = readFileSync(q);
  expect((await only.engine.optimizeFile(q)).status).toBe("unchanged");
  expect(readFileSync(q)).toEqual(bytes);
});

test("COMMON-09: a crashing, silent or hanging step is skipped; later steps still run", async () => {
  const e = make({ steps: [crash, silent, hang, trim], settings: { stepTimeout: 0.2 } });
  const p = await e.file("a.fake", sample());
  const r = await e.engine.optimizeFile(p);
  expect(r.steps.map((s) => s.outcome)).toEqual(["failed", "failed", "failed", "kept"]);
  expect(r.steps[1].detail).toBe("wrote no output");
  expect(r.steps[2].detail).toContain("timed out");
  expect(r.status).toBe("optimized");
});

test("COMMON-10: a missing tool skips its step with a note", async () => {
  const e = make({ steps: [missing, trim] });
  const r = await e.engine.optimizeFile(await e.file("a.fake", sample()));
  expect(r.steps[0]).toMatchObject({ outcome: "skipped", detail: "no-such-tool-shrink not available" });
  expect(r.notes).toContain("fake.missing: no-such-tool-shrink not available");
  expect(r.status).toBe("optimized");
});

test("COMMON-11: a read-only file is skipped", async () => {
  const e = make();
  const p = await e.file("a.fake", sample());
  chmodSync(p, 0o444);
  const r = await e.engine.optimizeFile(p);
  if (process.getuid?.() === 0) return; // root can write anything
  expect(r.reason).toBe("read-only");
});

test("COMMON-12: a file that changes while it is optimised is left as it is", async () => {
  let path = "";
  const touchy: Step = { id: "fake.touchy", run: async (i, o) => { await Bun.write(path, sample(5) + "  "); await trim.run(i, o, undefined as never); } };
  const e = make({ steps: [touchy] });
  path = await e.file("a.fake", sample());
  const r = await e.engine.optimizeFile(path);
  expect(r.status).toBe("unchanged");
  expect(r.reason).toContain("changed while");
  expect(readFileSync(path, "utf8")).toBe(sample(5) + "  ");
});

test("COMMON-13: timestamps, permissions, hard links and symlinks", async () => {
  const e = make();
  const p = await e.file("a.fake", sample());
  const old = new Date("2020-01-02T03:04:05Z");
  utimesSync(p, old, old);
  chmodSync(p, 0o640);
  const link = join(e.dir, "hard.fake");
  linkSync(p, link);
  const sym = join(e.dir, "sym.fake");
  symlinkSync(p, sym);
  await e.engine.optimizeFile(sym); // through the symlink
  expect(lstatSync(sym).isSymbolicLink()).toBe(true);
  expect(statSync(p).mtime.getTime()).toBe(old.getTime());
  expect(statSync(p).mode & 0o777).toBe(0o640);
  expect(readFileSync(link, "utf8")).toBe(readFileSync(p, "utf8")); // the same inode
  expect(statSync(link).size).toBeLessThan(sample().length);
});

test("COMMON-14: unusual names work", async () => {
  const e = make();
  for (const name of ["with space.fake", "ünïcödé-日本語.fake", "-leading-dash.fake", "a'quote\".fake", "x".repeat(150) + ".fake"]) {
    const p = await e.file(name, sample());
    expect((await e.engine.optimizeFile(p)).status).toBe("optimized");
  }
});

test("COMMON-15: cancelling stops the job and leaves the original alone", async () => {
  const e = make({ steps: [hang, trim] });
  const p = await e.file("a.fake", sample());
  const bytes = readFileSync(p);
  const ac = new AbortController();
  const run = e.engine.optimizeFile(p, { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  const r = await run;
  expect(r.status).toBe("failed");
  expect(r.reason).toBe("cancelled");
  expect(readFileSync(p)).toEqual(bytes);
  expect(e.leftovers()).toEqual([]);
});

test("COMMON-16: many files at once give the results one at a time would", async () => {
  const e = make({ settings: { workers: 8 } });
  const paths = await Promise.all(Array.from({ length: 40 }, (_, i) => e.file(`f${i}.fake`, sample(10 + i))));
  const reports = await e.engine.optimizeMany(paths);
  expect(reports.every((r) => r.status === "optimized")).toBe(true);
  for (const [i, p] of paths.entries()) expect(readFileSync(p, "utf8")).toBe("FAKE\n" + Array.from({ length: 10 + i }, (_, j) => `line ${j}`).join("\n") + "\nEND");
  expect(e.leftovers()).toEqual([]);
});

test("COMMON-19: lossy and metadata-dropping steps follow the settings", async () => {
  const lossy: Step = { ...trim, id: "fake.lossy", lossy: true };
  const strip: Step = { ...trim, id: "fake.strip", strip: true };
  const off = make({ steps: [lossy, strip] });
  const r = await off.engine.optimizeFile(await off.file("a.fake", sample()));
  expect(r.steps.map((s) => s.detail)).toEqual(["lossy steps are off", undefined]);
  const kept = make({ steps: [strip], settings: { png: { keepMetadata: true } } });
  const k = await kept.engine.optimizeFile(await kept.file("a.fake", sample()));
  expect(k.steps[0].detail).toBe("metadata is kept");
  expect(k.status).toBe("unchanged");
});

test("COMMON-20: a dry run reports the saving and writes nothing", async () => {
  const e = make();
  const p = await e.file("a.fake", sample());
  const bytes = readFileSync(p);
  const r = await e.engine.optimizeFile(p, { dryRun: true });
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  expect(readFileSync(p)).toEqual(bytes);
});

test("COMMON-22: a higher level never gives a bigger result", async () => {
  const slow: Step = { ...trim, id: "fake.slow", minLevel: 7 };
  const sizes: number[] = [];
  for (const level of [1, 5, 9]) {
    const e = make({ steps: [slow], settings: { level } });
    const p = await e.file("a.fake", sample());
    await e.engine.optimizeFile(p);
    sizes.push(statSync(p).size);
  }
  expect(sizes[2]).toBeLessThanOrEqual(sizes[1]);
  expect(sizes[1]).toBeLessThanOrEqual(sizes[0]);
});
