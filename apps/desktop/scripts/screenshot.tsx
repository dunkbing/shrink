// bun --preload mantou-ui/preload scripts/screenshot.tsx out.png : renders the window with sample results.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mount } from "mantou-ui";
import { HeadlessCore } from "mantou-ui/headless";
import { encodePng } from "mantou-ui/images";
import { App } from "../src/App";
import { createStore } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "shrink-shot-"));
const sample = [
  ["photo-001.jpg", "jpeg", 4_200_000, 3_100_000, "optimized"],
  ["screenshot.png", "png", 880_000, 410_000, "optimized"],
  ["logo.svg", "svg", 12_400, 7_900, "optimized"],
  ["report.pdf", "pdf", 2_300_000, 2_300_000, "unchanged"],
  ["notes.txt", "", 3_000, 3_000, "skipped", "unsupported format"],
  ["broken.gif", "gif", 90_000, 90_000, "failed", "damaged: bad header"],
  ["holiday.mov", "mp4", 48_000_000, 0, "working"],
  ["next.webp", "webp", 0, 0, "queued"],
] as const;
writeFileSync(join(dir, "results.json"), JSON.stringify(sample.map(([n, format, before, after, status, reason]) => ({ path: `/Users/me/Pictures/${n}`, format, before, after, status, reason }))));
const store = createStore({ dir, makeRunner: () => ({ optimizeMany: async () => [] }) });
const empty = process.argv[3] === "empty";
if (empty) store.clear();
const h = new HeadlessCore({ width: 1000, height: 640, scale: 2 });
mount(h.ui, () => <App store={store} />);
h.step();
if (process.argv[3] === "tools") h.press([...h.ui.nodes.values()].find((n) => n.isText && n.textContent === "Tools")!);
await new Promise((r) => setTimeout(r, 300));
writeFileSync(process.argv[2], encodePng(h.step().capture()));
h.free();
process.exit(0);
