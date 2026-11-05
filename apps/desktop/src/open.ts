import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Store } from "./store";

/** Launch arguments (this copy's or a later launch's): the existing files are added; URLs and flags are not files. */
export function openArgs(store: Store, args: string[], cwd: string) {
  const files = args.map((a) => resolve(cwd, a)).filter((p) => existsSync(p));
  if (files.length) void store.add(files);
}
