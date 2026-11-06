// A stand-in for the app's startup: takes the single-instance lock, adds launch files to a store, prints each one. Exits on stdin data.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { singleInstance } from "mantou-ui";
import { listenOpen } from "../../src/open";
import { createStore } from "../../src/store";

if (!(await singleInstance())) process.exit(0);
const store = createStore({ dir: mkdtempSync(join(tmpdir(), "shrink-launch-")), makeRunner: () => ({ optimizeMany: async () => [] }), expand: async (p) => p });
listenOpen(store);
const seen = new Set<string>();
setInterval(() => {
  for (const i of store.items()) if (!seen.has(i.path)) (seen.add(i.path), console.log("added " + i.path));
}, 20);
console.log("ready");
process.stdin.on("data", () => process.exit(0));
