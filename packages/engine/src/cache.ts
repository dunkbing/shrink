import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Settings } from "./types";

/** Hash of a file's bytes. */
export async function hashFile(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

/** Files already optimised with the same settings: one line per (content, settings) pair, appended as they're found. */
export class Cache {
  private seen = new Set<string>();
  private file: string;

  constructor(dir = join(homedir(), ".shrink")) {
    this.file = join(dir, "optimized.txt");
    try {
      mkdirSync(dir, { recursive: true });
      for (const l of readFileSync(this.file, "utf8").split("\n")) if (l) this.seen.add(l);
    } catch {} // none yet, or unreadable: start empty
  }

  static key(contentHash: string, settings: Settings): string {
    const { workers, include, exclude, toolPaths, stepTimeout, lowPriority, preserveTimestamps, skipOptimized, ...rest } = settings;
    return contentHash + ":" + new Bun.CryptoHasher("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  add(key: string) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    try {
      appendFileSync(this.file, key + "\n");
    } catch {} // a read-only home: the cache just won't persist
  }
}
