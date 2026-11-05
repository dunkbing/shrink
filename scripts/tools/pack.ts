// Builds the per-platform tool packs (bun run tools:pack). Sources are in packages/engine/tools/manifest.json:
//   release  an upstream archive, downloaded and checked against its sha256 (--pin fills in missing ones)
//   system   a Homebrew / apt / Chocolatey package; its libraries are copied next to it and made relocatable
//   build    a script that builds the tool (ffmpeg: scripts/tools/ffmpeg-min.sh)
// usage: bun scripts/tools/pack.ts [--platform p] [--packs core,docs] [--tools a,b] [--out dir] [--work dir] [--pin] [--merge fragment.json...]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentPlatform, exePath, manifest, PLATFORMS, type Manifest, type Platform, type ToolSource } from "../../packages/engine/src/manifest";
import { extractTarGz } from "../../packages/engine/src/tar";
import { thirdParty } from "./third-party";

const MANIFEST = resolve(import.meta.dir, "../../packages/engine/tools/manifest.json");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { platform: { type: "string" }, packs: { type: "string" }, tools: { type: "string" }, out: { type: "string" }, work: { type: "string" }, pin: { type: "boolean" }, merge: { type: "boolean" } },
});

const sh = async (cmd: string[], o: { cwd?: string; quiet?: boolean } = {}): Promise<string> => {
  const p = Bun.spawn(cmd, { cwd: o.cwd, stdout: "pipe", stderr: o.quiet ? "pipe" : "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
  return out;
};
const have = (c: string) => !!Bun.which(c);
const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

function writeManifest(m: Manifest) {
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
}

/** Puts the fragments the platform builds wrote (one per pack and platform) into the manifest. */
function merge(files: string[]) {
  const m: Manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  for (const f of files) {
    const frag = JSON.parse(readFileSync(f, "utf8")) as { pack: string; platform: Platform; file: string; sha256: string; size: number };
    m.packs[frag.pack].platforms[frag.platform] = { file: frag.file, sha256: frag.sha256, size: frag.size };
  }
  writeManifest(m);
  console.log(`merged ${files.length} pack(s) into the manifest`);
}

async function download(url: string, dest: string) {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await Bun.write(dest, res);
}

/** Unpacks an upstream archive (.tar.gz natively; .zip, .tar.xz, .7z with the system tools). */
async function unpack(archive: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  if (archive.endsWith(".tar.gz") || archive.endsWith(".tgz")) return extractTarGz(archive, dest);
  if (archive.endsWith(".7z")) return void (await sh(["7z", "x", "-y", `-o${dest}`, archive], { quiet: true }));
  if (archive.endsWith(".zip") && have("unzip")) return void (await sh(["unzip", "-q", "-o", archive, "-d", dest]));
  // bsdtar (macOS, Windows) reads zip; paths are relative to the cwd so a drive letter is never in them
  const gnu = (await sh(["tar", "--version"], { quiet: true })).includes("GNU");
  await sh(["tar", ...(gnu ? ["--force-local"] : []), "-xf", archive], { cwd: dest });
}

function find(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const r = find(p, name);
      if (r) return r;
    } else if (e.name === name || e.name === name + ".exe") return p;
  }
  return null;
}

// ---- system packages -----------------------------------------------------------------------------------------

async function locateSystem(src: ToolSource, platform: Platform): Promise<string> {
  const bin = src.bin!;
  if (platform.startsWith("darwin")) {
    const pkg = src.brew!;
    const prefix = async () => (await sh(["brew", "--prefix", pkg], { quiet: true }).catch(() => "")).trim();
    let pre = await prefix();
    if (!pre || !existsSync(join(pre, "bin", bin))) {
      await sh(["brew", "install", pkg]);
      pre = await prefix();
    }
    return join(pre, "bin", bin);
  }
  if (platform.startsWith("linux")) {
    if (!Bun.which(bin)) await sh(["sudo", "apt-get", "install", "-y", "--no-install-recommends", src.apt!]);
    return Bun.which(bin)!;
  }
  // Windows: Chocolatey shims are stubs, the real program lives under its lib folder
  const lib = join(process.env.ChocolateyInstall ?? "C:\\ProgramData\\chocolatey", "lib", src.choco!);
  if (!existsSync(lib)) await sh(["choco", "install", "-y", "--no-progress", src.choco!]);
  const real = find(lib, bin) ?? Bun.which(bin);
  if (!real) throw new Error(`${bin} not found after installing ${src.choco}`);
  return real;
}

/** Copies a macOS program and the non-system dylibs it needs; every path inside is relative, then re-signs. */
async function bundleMac(exe: string, stage: string) {
  const bin = join(stage, "bin", basename(exe));
  const lib = join(stage, "lib");
  mkdirSync(lib, { recursive: true });
  copyFileSync(exe, bin);
  chmodSync(bin, 0o755);
  const system = (p: string) => p.startsWith("/usr/lib/") || p.startsWith("/System/");
  const seen = new Map<string, string>(); // original path -> copy
  const resolveDep = (dep: string, from: string): string | null => {
    if (dep.startsWith("@loader_path/") || dep.startsWith("@executable_path/")) return resolve(dirname(from), dep.replace(/^@[a-z_]+\//, ""));
    if (dep.startsWith("@rpath/")) {
      for (const d of [dirname(from), join(dirname(from), "..", "lib"), "/opt/homebrew/lib", "/usr/local/lib"]) if (existsSync(join(d, dep.slice(7)))) return join(d, dep.slice(7));
      return null;
    }
    return dep;
  };
  const deps = async (file: string) => (await sh(["otool", "-L", file], { quiet: true })).split("\n").slice(1).map((l) => l.trim().split(" (")[0]).filter(Boolean);
  const queue: { file: string; orig: string }[] = [{ file: bin, orig: exe }];
  while (queue.length) {
    const { file, orig } = queue.shift()!;
    const isBin = file === bin;
    for (const dep of await deps(file)) {
      if (system(dep) || dep === file) continue;
      const real = resolveDep(dep, orig);
      if (!real || !existsSync(real)) throw new Error(`cannot find ${dep} needed by ${orig}`);
      const target = join(lib, basename(real));
      if (!seen.has(real)) {
        seen.set(real, target);
        copyFileSync(real, target);
        chmodSync(target, 0o755);
        await sh(["install_name_tool", "-id", `@loader_path/${basename(real)}`, target], { quiet: true });
        queue.push({ file: target, orig: real });
      }
      await sh(["install_name_tool", "-change", dep, `${isBin ? "@executable_path/../lib" : "@loader_path"}/${basename(real)}`, file], { quiet: true });
    }
  }
  // changed binaries lose their signature; Apple silicon refuses to run unsigned code
  for (const f of [bin, ...seen.values()]) await sh(["codesign", "--force", "-s", "-", f], { quiet: true });
}

/** Copies a Linux program and the libraries it needs besides glibc; rpath points at ../lib. */
async function bundleLinux(exe: string, stage: string) {
  const bin = join(stage, "bin", basename(exe));
  const lib = join(stage, "lib");
  mkdirSync(lib, { recursive: true });
  copyFileSync(exe, bin);
  chmodSync(bin, 0o755);
  // glibc and the loader come from the machine; everything else travels with the pack
  const keep = /^(linux-vdso|ld-linux|libc\.|libm\.|libdl\.|libpthread|librt\.|libresolv|libutil|libgcc_s|libstdc\+\+)/;
  const needed = (await sh(["ldd", exe], { quiet: true })).split("\n").map((l) => /=> (\/\S+)/.exec(l)?.[1]).filter((p): p is string => !!p && !keep.test(basename(p)));
  for (const p of needed) copyFileSync(p, join(lib, basename(p)));
  if (needed.length) {
    if (!have("patchelf")) await sh(["sudo", "apt-get", "install", "-y", "--no-install-recommends", "patchelf"]);
    await sh(["patchelf", "--set-rpath", "$ORIGIN/../lib", bin], { quiet: true });
    for (const p of needed) await sh(["patchelf", "--set-rpath", "$ORIGIN", join(lib, basename(p))], { quiet: true });
  }
}

/** Windows: the program and the DLLs beside it. */
function bundleWindows(exe: string, stage: string) {
  const bin = join(stage, "bin");
  for (const e of readdirSync(dirname(exe))) if (e.toLowerCase().endsWith(".dll") || e === basename(exe)) copyFileSync(join(dirname(exe), e), join(bin, e));
}

// ---- the build ------------------------------------------------------------------------------------------------

async function addTool(m: Manifest, name: string, platform: Platform, stage: string, work: string, pin: boolean, built: Set<string>) {
  const t = m.tools[name];
  const src = t.platforms[platform];
  const dest = join(stage, exePath(m, name, platform));
  mkdirSync(join(stage, "bin"), { recursive: true });
  if (!src) return console.log(`  ${name}: no source for ${platform}, skipped`);
  if (t.exeOf || t.builtWith) return; // shares the executable of another entry
  if (src.build) {
    if (built.has(src.build)) return;
    built.add(src.build);
    const prebuilt = process.env.FFMPEG_PREBUILT; // built beforehand (Windows: inside MSYS2)
    if (prebuilt) for (const e of ["ffmpeg", "ffprobe"]) copyFileSync(join(prebuilt, e + (platform.startsWith("win32") ? ".exe" : "")), join(stage, "bin", e + (platform.startsWith("win32") ? ".exe" : "")));
    else await sh(["bash", resolve(import.meta.dir, "../..", src.build), join(stage, "bin"), join(work, "build")]);
  } else if (src.system) {
    mkdirSync(join(stage, "bin"), { recursive: true });
    const exe = await locateSystem(src, platform);
    if (platform.startsWith("darwin")) await bundleMac(exe, stage);
    else if (platform.startsWith("linux")) await bundleLinux(exe, stage);
    else bundleWindows(exe, stage);
    const copied = join(stage, "bin", basename(exe));
    if (copied !== dest) copyFileSync(copied, dest);
  } else {
    const file = join(work, "dl", basename(src.url!));
    if (!existsSync(file)) await download(src.url!, file);
    const sum = sha256(file);
    if (!src.sha256) {
      if (!pin) throw new Error(`${name} (${platform}) has no sha256 in the manifest: run with --pin once`);
      src.sha256 = sum;
    } else if (src.sha256.toLowerCase() !== sum) {
      rmSync(file);
      throw new Error(`${name} (${platform}): sha256 of ${src.url} is ${sum}, the manifest says ${src.sha256}`);
    }
    const x = join(work, "x", `${name}-${platform}`);
    rmSync(x, { recursive: true, force: true });
    await unpack(file, x);
    const member = join(x, src.member!);
    if (!existsSync(member)) throw new Error(`${name}: ${src.member} not in ${basename(file)}`);
    copyFileSync(member, dest);
    chmodSync(dest, 0o755);
    // licence texts that ship with the program
    const lic = join(stage, "licenses", name);
    for (const e of readdirSync(dirname(member))) if (/^(licen[sc]e|copying|notice)/i.test(e) && statSync(join(dirname(member), e)).isFile()) (mkdirSync(lic, { recursive: true }), copyFileSync(join(dirname(member), e), join(lic, e)));
  }
}

/** Runs every tool of the pack once from its final place: it starts, and says a version. */
async function check(m: Manifest, pack: string, platform: Platform, dir: string) {
  for (const name of m.packs[pack].tools) {
    if (!m.tools[name].platforms[platform]) continue;
    const exe = join(dir, exePath(m, name, platform));
    if (!existsSync(exe)) throw new Error(`${name} is missing from the pack`);
    if (platform !== currentPlatform()) continue; // cannot run other platforms' programs
    const args = m.tools[name].versionArgs ?? ["--version"];
    const p = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" } });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    if (!/\d/.test(out)) throw new Error(`${name} does not run from the pack:\n${out}`);
    console.log(`  ok ${name}: ${out.split("\n").find((l) => /\d/.test(l))?.slice(0, 70)}`);
  }
}

async function main() {
  if (values.merge) return merge(positionals);
  const platform = (values.platform as Platform | undefined) ?? currentPlatform();
  if (!platform || !PLATFORMS.includes(platform)) throw new Error("unknown platform");
  const m: Manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const packs = values.packs ? values.packs.split(",") : Object.entries(m.packs).filter(([, p]) => !p.tools.every((t) => m.tools[t].experimental)).map(([k]) => k);
  const only = values.tools?.split(",");
  const work = resolve(values.work ?? join(process.env.TMPDIR ?? "/tmp", "shrink-tools-work"));
  const out = resolve(values.out ?? "dist/tools");
  mkdirSync(out, { recursive: true });
  const built = new Set<string>();
  for (const pack of packs) {
    console.log(`pack ${pack} (${platform})`);
    const stage = join(work, "stage", `${pack}-${platform}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(join(stage, "bin"), { recursive: true });
    const names = m.packs[pack].tools.filter((n) => !only || only.includes(n));
    for (const name of names) {
      console.log(`- ${name}`);
      await addTool(m, name, platform, stage, work, !!values.pin, built);
    }
    if (values.pin) writeManifest(m);
    writeFileSync(join(stage, "THIRD_PARTY.md"), thirdParty(m, { pack }));
    await check({ ...m, packs: { ...m.packs, [pack]: { ...m.packs[pack], tools: names } } }, pack, platform, stage);
    const file = `${pack}-${platform}.tar.gz`;
    rmSync(join(out, file), { force: true });
    await Bun.spawn(["tar", "-czf", file, "-C", stage, "."], { cwd: out, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "inherit", stderr: "inherit" }).exited;
    // the pack must unpack with the engine's own extractor
    const probe = join(work, "probe", pack);
    rmSync(probe, { recursive: true, force: true });
    await extractTarGz(join(out, file), probe);
    await check({ ...m, packs: { ...m.packs, [pack]: { ...m.packs[pack], tools: names } } }, pack, platform, probe);
    const frag = { pack, platform, file, sha256: sha256(join(out, file)), size: statSync(join(out, file)).size };
    writeFileSync(join(out, `${pack}-${platform}.json`), JSON.stringify(frag, null, 2));
    console.log(`  ${file}: ${(frag.size / 1048576).toFixed(1)} MB sha256 ${frag.sha256}`);
  }
  if (!values.tools && !process.env.CI) console.log("\nupload dist/tools/* to the release, then: bun scripts/tools/pack.ts --merge dist/tools/*.json");
}

await main();
