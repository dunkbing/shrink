#!/usr/bin/env bun
// Downloads real-world test files into fixtures/real (git-ignored: licences differ) and checks them against the
// checksums in fixtures/locks/<group>.json. One manifest per format group in fixtures/manifest.d/<group>.json.
// bun scripts/fetch-fixtures.ts [group...] [--update]   (--update records new checksums)
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "fixtures");
const dir = join(root, "real");
const update = process.argv.includes("--update");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
mkdirSync(dir, { recursive: true });
mkdirSync(join(root, "locks"), { recursive: true });

let bad = 0, total = 0;
for (const f of [...new Bun.Glob("*.json").scanSync(join(root, "manifest.d"))].sort()) {
  const group = f.replace(/\.json$/, "");
  if (only.length && !only.includes(group)) continue;
  const manifest: { file: string; url: string }[] = await Bun.file(join(root, "manifest.d", f)).json();
  const lockFile = join(root, "locks", f);
  const lock: Record<string, string> = existsSync(lockFile) ? await Bun.file(lockFile).json() : {};
  for (const m of manifest) {
    total++;
    const path = join(dir, m.file);
    if (!existsSync(path)) {
      const res = await fetch(m.url, { redirect: "follow", headers: { "user-agent": "shrink-fixtures/0.1 (test corpus fetcher; https://github.com/dunkbing)" } }).catch(() => null);
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
  await Bun.write(lockFile, JSON.stringify(lock, null, 2) + "\n");
}
const suite = join(dir, "pngsuite");
if (!existsSync(suite) && existsSync(join(dir, "pngsuite.tgz"))) {
  mkdirSync(suite, { recursive: true });
  Bun.spawnSync(["tar", "-xzf", join(dir, "pngsuite.tgz"), "-C", suite]);
}
console.log(bad ? `${bad} problems` : `${total} files ready in fixtures/real`);
process.exit(bad ? 1 : 0);
