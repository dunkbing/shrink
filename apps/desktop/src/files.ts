import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { allFormats } from "@shrink/engine";

const SKIP_DIRS = new Set([".git", ".svn", ".hg", "node_modules", "__pycache__"]);
const KNOWN = new Set(allFormats.flatMap((f) => f.extensions ?? []));

/** Files dropped or picked: folders are walked for files of known extensions; named files are always kept. */
export async function expand(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, top: boolean) => {
    const st = await stat(p).catch(() => null);
    if (!st) return void out.push(p); // reported as "not found"
    if (!st.isDirectory()) return void (top || KNOWN.has(extname(p).slice(1).toLowerCase()) ? out.push(p) : 0);
    for (const e of (await readdir(p)).sort()) if (!SKIP_DIRS.has(e)) await walk(join(p, e), false);
  };
  for (const p of paths) await walk(p, true);
  return out;
}

export const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

export const percent = (before: number, after: number) => (before > 0 ? `${((1 - after / before) * 100).toFixed(1)}%` : "0.0%");
