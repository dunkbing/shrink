// A small Lua 5.1-5.4 / LuaJIT tokenizer working on latin1 text (bytes). Comments are dropped; every token keeps the
// line it starts on, so a rewrite that keeps the tokens and their lines behaves identically (error messages and
// debug.getinfo included).

export interface Tok {
  kind: "name" | "number" | "string" | "long" | "op" | "shebang";
  text: string;
  line: number;
}

const WORD = /[A-Za-z0-9_\x80-\xff]/;
const DIGIT = /[0-9]/;
const THREE = new Set(["..."]);
const TWO = new Set(["==", "~=", "<=", ">=", "//", "::", "<<", ">>", ".."]);

export class LuaSyntaxError extends Error {}

/** `[`, `=`*, `[` at i: the level, or -1. */
function longOpen(s: string, i: number): number {
  if (s[i] !== "[") return -1;
  let j = i + 1;
  while (s[j] === "=") j++;
  return s[j] === "[" ? j - i - 1 : -1;
}

export function tokenizeLua(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1;
  /** Advances over one newline sequence (\r\n, \n\r, \r or \n) at i. */
  const newline = () => {
    const c = s[i];
    i++;
    if ((s[i] === "\n" || s[i] === "\r") && s[i] !== c) i++;
    line++;
  };
  const longString = (level: number, what: string) => {
    const start = i;
    i += level + 2;
    const close = "]" + "=".repeat(level) + "]";
    for (;;) {
      if (i >= s.length) throw new LuaSyntaxError(`unfinished long ${what}`);
      if (s[i] === "]" && s.startsWith(close, i)) {
        i += close.length;
        return s.slice(start, i);
      }
      if (s[i] === "\n" || s[i] === "\r") newline();
      else i++;
    }
  };
  if (s[0] === "#") {
    let e = s.search(/[\r\n]/);
    if (e < 0) e = s.length;
    out.push({ kind: "shebang", text: s.slice(0, e), line: 1 });
    i = e;
  }
  while (i < s.length) {
    const c = s[i];
    if (c === "\n" || c === "\r") newline();
    else if (c === " " || c === "\t" || c === "\f" || c === "\v") i++;
    else if (c === "-" && s[i + 1] === "-") {
      i += 2;
      const lv = longOpen(s, i);
      if (lv >= 0) longString(lv, "comment");
      else while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
    } else if (WORD.test(c) && !DIGIT.test(c)) {
      const st = i;
      while (i < s.length && WORD.test(s[i])) i++;
      out.push({ kind: "name", text: s.slice(st, i), line });
    } else if (DIGIT.test(c) || (c === "." && DIGIT.test(s[i + 1] ?? ""))) {
      const st = i;
      const hex = c === "0" && (s[i + 1] === "x" || s[i + 1] === "X");
      i += hex ? 2 : 0;
      while (i < s.length) {
        const d = s[i];
        if ((hex ? /[pP]/ : /[eE]/).test(d) && (s[i + 1] === "+" || s[i + 1] === "-")) i += 2;
        else if (WORD.test(d) || d === ".") i++;
        else break;
      }
      out.push({ kind: "number", text: s.slice(st, i), line });
    } else if (c === '"' || c === "'") {
      const st = i, at = line;
      i++;
      for (;;) {
        if (i >= s.length) throw new LuaSyntaxError("unfinished string");
        const d = s[i];
        if (d === c) {
          i++;
          break;
        }
        if (d === "\n" || d === "\r") throw new LuaSyntaxError("unfinished string");
        if (d === "\\") {
          i++;
          if (s[i] === "\n" || s[i] === "\r") newline();
          else i++;
        } else i++;
      }
      out.push({ kind: "string", text: s.slice(st, i), line: at });
    } else if (c === "[" && longOpen(s, i) >= 0) {
      const at = line;
      out.push({ kind: "long", text: longString(longOpen(s, i), "string"), line: at });
    } else {
      const op = THREE.has(s.substr(i, 3)) ? s.substr(i, 3) : TWO.has(s.substr(i, 2)) ? s.substr(i, 2) : c;
      out.push({ kind: "op", text: op, line });
      i += op.length;
    }
  }
  return out;
}

/** The same tokens on the same lines with the least whitespace: comments, indentation and blank lines of no consequence go. */
export function compactLua(s: string): string {
  const toks = tokenizeLua(s);
  let out = "";
  let line = 1, prev: Tok | null = null;
  for (const t of toks) {
    if (t.line > line) {
      out += "\n".repeat(t.line - line);
      line = t.line;
      prev = null;
    } else if (prev) {
      // a space only where gluing the two tokens would read differently
      const glued = tokenizeLua(prev.text + t.text);
      if (!(glued.length === 2 && glued[0].text === prev.text && glued[1].text === t.text && glued[0].kind === prev.kind)) out += " ";
    }
    out += t.text;
    // lines a long string covers
    const nl = t.kind === "long" || t.kind === "string" ? (t.text.match(/\r\n|\n\r|\r|\n/g)?.length ?? 0) : 0;
    line += nl;
    prev = t;
  }
  const tail = s.match(/(\r\n|\n\r|\r|\n)$/);
  return out + (tail ? "\n" : "");
}
