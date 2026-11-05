import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, ToolProvisioner, createTools, resolve, type PackState } from "../src";
import { fakeFormat } from "./fake";
import { fakePacks, platform, sha } from "./lib/packs";

const skip = platform === null;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shrink-prov-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fast = { backoffMs: 1, attempts: 2, cooldownMs: 100000 };
const installedPacks = (dir: string) => (existsSync(join(dir, "packs")) ? readdirSync(join(dir, "packs")) : []);

test.skipIf(skip)("a pack is downloaded, verified, unpacked and its tool is runnable", async () => {
  const packs = fakePacks({ core: ["ftool"] });
  const events: PackState[] = [];
  const dir = tmp();
  const p = new ToolProvisioner({ manifest: packs.manifest, dir, onProgress: (s) => events.push({ ...s }), ...fast });
  expect(p.installed("ftool")).toBeNull();
  const cmd = await p.ensure("ftool");
  expect(cmd).toHaveLength(1);
  expect(existsSync(cmd![0])).toBe(true);
  expect(events.map((e) => e.phase)).toContain("downloading");
  expect(events.at(-1)?.phase).toBe("ready");
  expect(p.installed("ftool")).toBe(cmd![0]);
  if (process.platform !== "win32") {
    const r = Bun.spawnSync([cmd![0]]);
    expect(r.stdout.toString()).toContain("ftool version 2.0.0");
  }
  expect(readdirSync(join(dir, "tmp"))).toEqual([]); // nothing left behind
});

test.skipIf(skip)("a pack with a wrong checksum is rejected and nothing is installed", async () => {
  const packs = fakePacks({ core: ["ftool"] });
  packs.write("core-" + platform + ".tar.gz", new TextEncoder().encode("not the pack you were promised"));
  const dir = tmp();
  const p = new ToolProvisioner({ manifest: packs.manifest, dir, ...fast });
  expect(await p.ensure("ftool")).toBeNull();
  expect(installedPacks(dir)).toEqual([]);
  expect(p.installed("ftool")).toBeNull();
  expect(p.why("ftool")).toContain("checksum");
  expect(readdirSync(join(dir, "tmp"))).toEqual([]); // the bad file is deleted
});

test.skipIf(skip)("a partial download is continued and verified", async () => {
  const packs = fakePacks({ core: ["ftool"] });
  const file = `core-${platform}.tar.gz`;
  const data = packs.files[file];
  const dir = tmp();
  mkdirSync(join(dir, "tmp"), { recursive: true });
  const half = Math.floor(data.length / 2);
  writeFileSync(join(dir, "tmp", `${file}.${sha(data).slice(0, 8)}.part`), data.subarray(0, half));
  const first: number[] = [];
  const p = new ToolProvisioner({ manifest: packs.manifest, dir, onProgress: (s) => s.phase === "downloading" && first.push(s.received), ...fast });
  expect(await p.ensure("ftool")).not.toBeNull();
  expect(first[0]).toBe(half); // it started where the partial file ended
});

test.skipIf(skip)("a corrupt partial file is dropped and the pack is fetched again", async () => {
  const packs = fakePacks({ core: ["ftool"] });
  const file = `core-${platform}.tar.gz`;
  const dir = tmp();
  mkdirSync(join(dir, "tmp"), { recursive: true });
  writeFileSync(join(dir, "tmp", `${file}.${sha(packs.files[file]).slice(0, 8)}.part`), "garbage garbage");
  const p = new ToolProvisioner({ manifest: packs.manifest, dir, ...fast });
  expect(await p.ensure("ftool")).not.toBeNull();
});

test.skipIf(skip)("parallel requests, in one process and in two, download once", async () => {
  const packs = fakePacks({ core: ["ftool", "gtool"] });
  const data = packs.files[`core-${platform}.tar.gz`];
  let hits = 0;
  const server = Bun.serve({ port: 0, async fetch() { hits++; await Bun.sleep(150); return new Response(data); } });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const dir = tmp();
    const a = new ToolProvisioner({ manifest: packs.manifest, dir, baseUrl: url, ...fast });
    const b = new ToolProvisioner({ manifest: packs.manifest, dir, baseUrl: url, ...fast }); // another app instance
    const got = await Promise.all([a.ensure("ftool"), a.ensure("gtool"), a.ensure("ftool"), b.ensure("ftool"), b.ensure("gtool")]);
    expect(got.every((g) => g !== null)).toBe(true);
    expect(hits).toBe(1);
    expect(installedPacks(dir)).toHaveLength(1);
  } finally {
    void server.stop(true);
  }
});

test.skipIf(skip)("a lock left by a dead process is taken over", async () => {
  const packs = fakePacks({ core: ["ftool"] });
  const dir = tmp();
  mkdirSync(join(dir, "locks", "core.lock"), { recursive: true });
  writeFileSync(join(dir, "locks", "core.lock", "pid"), "999999");
  const p = new ToolProvisioner({ manifest: packs.manifest, dir, staleLockMs: 200, ...fast });
  expect(await p.ensure("ftool")).not.toBeNull();
});

test.skipIf(skip)("offline: nothing is downloaded and the step is skipped with a note", async () => {
  const packs = fakePacks({ core: ["ftool"] });
  const dir = tmp();
  const p = new ToolProvisioner({ manifest: packs.manifest, dir, offline: true });
  expect(await p.ensure("ftool")).toBeNull();
  expect(existsSync(join(dir, "packs"))).toBe(false);
  const work = tmp();
  const file = join(work, "a.fake");
  writeFileSync(file, "FAKE\nsome content here  \nEND");
  const engine = new Engine({ formats: [fakeFormat([{ id: "fake.tool", tool: "ftool", async run(i, o) { await Bun.write(o, "FAKE\nsome content here\nEND"); } }])], provisioner: p, cacheDir: tmp(), tempDir: work });
  const r = await engine.optimizeFile(file);
  expect(r.status).toBe("unchanged");
  expect(r.steps[0].outcome).toBe("skipped");
  expect(r.notes.join()).toContain("ftool not available (offline)");
});

test.skipIf(skip)("an unreachable server is not an error: the tool is just missing", async () => {
  const packs = fakePacks({ core: ["ftool"] });
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = dead.port;
  void dead.stop(true);
  const events: PackState[] = [];
  const p = new ToolProvisioner({ manifest: packs.manifest, dir: tmp(), baseUrl: `http://127.0.0.1:${port}`, onProgress: (s) => events.push({ ...s }), ...fast });
  expect(await p.ensure("ftool")).toBeNull();
  expect(events.at(-1)?.phase).toBe("offline");
  expect(p.canProvide("ftool")).toBe(false); // left alone until the cooldown ends
  p.retry();
  expect(p.canProvide("ftool")).toBe(true);
});

test.skipIf(skip)("a pack that is not published (no sha256) is never downloaded", async () => {
  const packs = fakePacks({ core: ["ftool"] });
  packs.manifest.packs.core.platforms[platform!]!.sha256 = null;
  const p = new ToolProvisioner({ manifest: packs.manifest, dir: tmp(), ...fast });
  expect(p.canProvide("ftool")).toBe(false);
  expect(await p.ensure("ftool")).toBeNull();
});

test.skipIf(skip || process.platform === "win32")("a tool on PATH is used only when new enough", async () => {
  const packs = fakePacks({ core: ["ftool"] }, { minVersion: { ftool: "2.0.0" } });
  const bin = tmp();
  const put = (v: string) => {
    writeFileSync(join(bin, "ftool"), `#!/bin/sh\necho "ftool version ${v}"\n`);
    chmodSync(join(bin, "ftool"), 0o755);
  };
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    put("3.1.0");
    const dir = tmp();
    const p = new ToolProvisioner({ manifest: packs.manifest, dir, ...fast });
    const t = createTools(resolve(), undefined, p);
    expect(await t.ensure!("ftool")).toEqual([join(bin, "ftool")]); // new enough: no download
    expect(installedPacks(dir)).toEqual([]);

    // an old one (a fresh path: versions are asked once per executable and arguments)
    const old = tmp();
    writeFileSync(join(old, "ftool"), `#!/bin/sh\necho "ftool version 1.0.0"\n`);
    chmodSync(join(old, "ftool"), 0o755);
    process.env.PATH = `${old}:${path}`;
    const dir2 = tmp();
    const p2 = new ToolProvisioner({ manifest: packs.manifest, dir: dir2, ...fast });
    const t2 = createTools(resolve(), undefined, p2);
    const got = await t2.ensure!("ftool");
    expect(got![0]).toBe(p2.installed("ftool")!);

    // and when the download can't happen, the old one still beats nothing
    const p3 = new ToolProvisioner({ manifest: packs.manifest, dir: tmp(), offline: true });
    expect(await createTools(resolve(), undefined, p3).ensure!("ftool")).toEqual([join(old, "ftool")]);
  } finally {
    process.env.PATH = path;
  }
});

test.skipIf(skip)("a pack is fetched on demand when a file needs a tool in it", async () => {
  const packs = fakePacks({ core: ["ftool"], extra: ["gtool"] });
  const dir = tmp();
  const p = new ToolProvisioner({ manifest: packs.manifest, dir, ...fast });
  await p.prefetch(["core"]);
  expect(installedPacks(dir).map((n) => n.split("-")[0])).toEqual(["core"]);
  const work = tmp();
  const a = join(work, "a.fake");
  writeFileSync(a, "FAKE\nsome content here  \nEND");
  const step = { id: "fake.g", tool: "gtool", async run(_i: string, o: string) { await Bun.write(o, "FAKE\nsome content here\nEND"); } };
  const engine = new Engine({ formats: [fakeFormat([step])], provisioner: p, cacheDir: tmp(), tempDir: work });
  const r = await engine.optimizeMany([a]);
  expect(r[0].status).toBe("optimized");
  expect(installedPacks(dir).map((n) => n.split("-")[0]).sort()).toEqual(["core", "extra"]);
});

test.skipIf(skip)("files whose tools are ready are not held up by a download", async () => {
  const packs = fakePacks({ core: ["ftool"], extra: ["gtool"] });
  const data = packs.files[`extra-${platform}.tar.gz`];
  const server = Bun.serve({ port: 0, async fetch() { await Bun.sleep(400); return new Response(data); } });
  try {
    const dir = tmp();
    const p = new ToolProvisioner({ manifest: packs.manifest, dir, baseUrl: `http://127.0.0.1:${server.port}`, ...fast });
    const fileOf = (n: string, tool?: string) => ({ ...fakeFormat([{ id: `fake.${n}`, tool, async run(_i, o) { await Bun.write(o, "FAKE\nsome content here\nEND"); } }]), id: n, extensions: [n], detect: (h: Uint8Array, name: string) => name.endsWith("." + n) });
    const engine = new Engine({ formats: [fileOf("slow", "gtool"), fileOf("quick")], provisioner: p, settings: { workers: 1 }, cacheDir: tmp() });
    const work = tmp();
    const slow = join(work, "a.slow"), quick = join(work, "b.quick");
    for (const f of [slow, quick]) writeFileSync(f, "FAKE\nsome content here  \nEND");
    const order: string[] = [];
    await engine.optimizeMany([slow, quick], { onResult: (r) => order.push(r.path) });
    expect(order).toEqual([quick, slow]);
  } finally {
    void server.stop(true);
  }
});
