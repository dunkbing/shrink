#!/usr/bin/env bun
// Downloads real-world test files into fixtures/real (git-ignored: licences differ) and checks them against fixtures/manifest.lock.json.
// bun scripts/fetch-fixtures.ts [--update]   (--update records new checksums)
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "fixtures");
const dir = join(root, "real");
const lockFile = join(root, "manifest.lock.json");
const manifest: { file: string; url: string; format: string }[] = await Bun.file(join(root, "manifest.json")).json();
const lock: Record<string, string> = existsSync(lockFile) ? await Bun.file(lockFile).json() : {};
const update = process.argv.includes("--update");
mkdirSync(dir, { recursive: true });

let bad = 0;
for (const m of manifest) {
  const path = join(dir, m.file);
  if (!existsSync(path)) {
    const res = await fetch(m.url, { redirect: "follow" }).catch(() => null);
    if (!res?.ok) {
      console.error(`FAILED ${m.file}: ${res ? res.status : "no response"} ${m.url}`);
      bad++;
      continue;
    }
    await Bun.write(path, res);
    console.log(`fetched ${m.file}`);
  }
  const sum = new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
  if (!lock[m.file] || update) lock[m.file] = sum;
  else if (lock[m.file] !== sum) {
    console.error(`CHANGED ${m.file}: checksum differs from the lock file`);
    bad++;
  }
}
if (update || !existsSync(lockFile)) await Bun.write(lockFile, JSON.stringify(lock, null, 2) + "\n");
// the PNG test suite comes as an archive
const suite = join(dir, "pngsuite");
if (!existsSync(suite) && existsSync(join(dir, "pngsuite.tgz"))) {
  mkdirSync(suite, { recursive: true });
  Bun.spawnSync(["tar", "-xzf", join(dir, "pngsuite.tgz"), "-C", suite]);
}
console.log(bad ? `${bad} problems` : `${manifest.length} files ready in fixtures/real`);
process.exit(bad ? 1 : 0);
