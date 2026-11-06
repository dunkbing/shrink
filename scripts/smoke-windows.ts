// Windows CI: install the packaged app silently, start it the way a double click does (no console, no redirected
// output) and check it is still running after a while. A core that fails to load kills it within a second.
// Usage: bun scripts/smoke-windows.ts <installer.exe>
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = process.argv[2];
if (process.platform !== "win32" || !installer) throw new Error("usage (Windows): bun scripts/smoke-windows.ts <installer.exe>");
const work = mkdtempSync(join(tmpdir(), "shrink-smoke-"));
const dir = join(work, "app"); // no spaces: /D= can't be quoted
let failed = "";
try {
  const install = Bun.spawnSync([installer, "/S", `/D=${dir}`]);
  if (install.exitCode !== 0) throw new Error(`installer exited ${install.exitCode}`);
  const exe = join(dir, "Shrink.exe");
  for (const f of ["Shrink.exe", "mantou_ffi.dll"]) if (!existsSync(join(dir, f))) throw new Error(`${f} was not installed`);
  // CI runners have the Visual C++ runtime; a fresh Windows may not, and the core would then fail to load
  const dll = new TextDecoder("latin1").decode(await Bun.file(join(dir, "mantou_ffi.dll")).bytes());
  if (/VCRUNTIME140|MSVCP140/i.test(dll)) throw new Error("mantou_ffi.dll needs the Visual C++ redistributable (mantou-ui before the static CRT build)");
  const consoles = () => new Set(Bun.spawnSync(["tasklist", "/fi", "imagename eq conhost.exe", "/fo", "csv", "/nh"]).stdout.toString().match(/"conhost.exe","(\d+)"/g) ?? []);
  const before = consoles();
  const app = Bun.spawn([exe], { stdio: ["ignore", "ignore", "ignore"] });
  // a console program started by the app (without windowsHide) opens a console window: it shows as a new conhost.exe
  const flashed = new Set<string>();
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(125);
    for (const c of consoles()) if (!before.has(c)) flashed.add(c);
  }
  if (flashed.size) throw new Error(`the app opened a console window (${[...flashed].join(", ")}): a child process lacks windowsHide`);
  await Bun.sleep(10_000);
  if (app.exitCode !== null) throw new Error(`Shrink.exe exited with ${app.exitCode} within 15 s`);
  console.log("ok: the installed app is still running after 15 s");
  app.kill();
  await app.exited;
  Bun.spawnSync([join(dir, "uninstall.exe"), "/S", `_?=${dir}`]);
} catch (e) {
  failed = e instanceof Error ? e.message : String(e);
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failed) {
  console.error(`smoke: ${failed}`);
  process.exit(1);
}
