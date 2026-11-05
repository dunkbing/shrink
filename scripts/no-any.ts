// Fails (with file:line) when the `any` type, or any other use of the word `any` as code, is left in a TypeScript file.
// Comments, string literals and regex literals are ignored; nothing else is allowed.
import { readFileSync } from "node:fs";

/** The source with comments, strings and regexes blanked out (newlines kept so line numbers stay true). */
function blank(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const braces: number[] = []; // template-literal nesting: the brace depth at each `${`
  let depth = 0;
  let prev = ""; // last significant character, to tell a regex from a division
  const keep = (c: string) => (c === "\n" ? "\n" : " ");
  const template = () => {
    // inside a template literal's text, up to its end or the next `${`
    while (i < n) {
      const c = src[i];
      if (c === "\\") { out += " " + keep(src[i + 1] ?? ""); i += 2; continue; }
      if (c === "`") { out += " "; i++; prev = "`"; return; }
      if (c === "$" && src[i + 1] === "{") { out += "  "; i += 2; braces.push(depth++); prev = "{"; return; }
      out += keep(c); i++;
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += keep(src[i]); i++; }
      out += "  "; i += 2; continue;
    }
    if (c === '"' || c === "'") {
      out += " "; i++;
      while (i < n && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") { out += " "; i++; } out += keep(src[i] ?? ""); i++; }
      out += " "; i++; prev = c; continue;
    }
    if (c === "`") { out += " "; i++; template(); continue; }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (braces.length && braces[braces.length - 1] === depth) { braces.pop(); out += " "; i++; template(); continue; }
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|of|in)$/.test(out.trimEnd()))) {
      // regex literal
      out += " "; i++;
      let cls = false;
      while (i < n && src[i] !== "\n" && (cls || src[i] !== "/")) {
        if (src[i] === "\\") { out += " "; i++; } else if (src[i] === "[") cls = true; else if (src[i] === "]") cls = false;
        out += keep(src[i] ?? ""); i++;
      }
      out += " "; i++;
      while (i < n && /[a-z]/.test(src[i])) { out += " "; i++; }
      prev = "/"; continue;
    }
    out += c; i++;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

const files = (await Bun.$`git ls-files --cached --others --exclude-standard '*.ts' '*.tsx'`.text()).split("\n").filter(Boolean);
const found: string[] = [];
for (const f of files) {
  blank(readFileSync(f, "utf8")).split("\n").forEach((line, k) => {
    if (/\bany\b/.test(line)) found.push(`${f}:${k + 1}: ${readFileSync(f, "utf8").split("\n")[k].trim()}`);
  });
}
if (found.length) {
  console.error(`no-any: ${found.length} use(s) of \`any\`:\n${found.join("\n")}`);
  process.exit(1);
}
console.log(`no-any: ok (${files.length} files)`);
