// Shared platform switches for tests.
/** POSIX shell scripts, file modes and `"` in file names work (not on Windows). */
export const posix = process.platform !== "win32";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scripts = "";
let n = 0;
/** A fake tool as a bun script, so it runs the same on every OS (no sh, no shebang). `code` is JavaScript that sees `args` (the tool's arguments). */
export function scriptTool(code: string): string[] {
  if (!scripts) {
    scripts = mkdtempSync(join(tmpdir(), "shrink-fake-"));
    process.on("exit", () => rmSync(scripts, { recursive: true, force: true }));
  }
  const p = join(scripts, `tool${++n}.js`);
  writeFileSync(p, `const fs = require("node:fs");\nconst args = process.argv.slice(2);\n${code}\n`);
  return [process.execPath, p];
}

/** A tool that copies `src` over its argument number `at` (0-based). */
export const copyTool = (src: string, at: number) => scriptTool(`fs.copyFileSync(${JSON.stringify(src)}, args[${at}]);`);
