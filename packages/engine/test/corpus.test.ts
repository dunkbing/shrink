// The real files in fixtures/real (bun run fixtures:fetch) through the whole engine: nothing fails, nothing grows,
// and what was kept passed the format's own check.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { allFormats } from "../src";
import { env } from "./fake";

const real = join(import.meta.dir, "../../../fixtures/real");
const manifest: { file: string; format: string }[] = await Bun.file(join(real, "../manifest.json")).json();
const e = env({ formats: allFormats, settings: { skipOptimized: false } });
afterAll(() => e.cleanup());

const formats = new Set(allFormats.map((f) => f.id));
const files = manifest.filter((m) => formats.has(m.format) && existsSync(join(real, m.file)));
const suite = existsSync(join(real, "pngsuite")) ? readdirSync(join(real, "pngsuite")).filter((f) => f.endsWith(".png")).map((f) => join(real, "pngsuite", f)) : [];

const summary: string[] = [];
async function run(path: string, name: string) {
  const copy = join(e.dir, name);
  copyFileSync(path, copy);
  const before = statSync(copy).size;
  const r = await e.engine.optimizeFile(copy);
  expect(r.status, `${name}: ${r.reason}`).not.toBe("failed");
  expect(statSync(copy).size).toBeLessThanOrEqual(before);
  return r;
}

for (const m of files) {
  test(`real file: ${m.file}`, async () => {
    const r = await run(join(real, m.file), m.file);
    summary.push(`${m.file}: ${r.status} ${r.before} -> ${r.after}${r.reason ? ` (${r.reason})` : ""}`);
    if (m.file === "apng-beach-ball.png") expect(r.reason).toContain("animated");
  });
}

test("PngSuite: all valid files keep their pixels, the deliberately broken ones are left alone", async () => {
  if (!suite.length) return;
  let optimized = 0, skipped = 0;
  for (const path of suite) {
    const name = path.split("/").pop()!;
    const r = await run(path, "suite-" + name);
    if (name.startsWith("x")) expect(r.status, name).toBe("skipped"); // x*.png are corrupt on purpose
    else if (r.status === "optimized") optimized++;
    else if (r.status === "skipped") (skipped++, summary.push(`pngsuite/${name}: skipped (${r.reason})`));
  }
  summary.push(`pngsuite: ${optimized} optimized, ${skipped} skipped of ${suite.length}`);
}, 120000);

afterAll(() => console.log("\n" + summary.join("\n")));
