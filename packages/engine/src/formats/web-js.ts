import { errorMessage } from "../errors";
// JavaScript tokenizer: the oracle for JS minification (token streams, comments and whitespace ignored,
// line breaks kept where automatic semicolon insertion could depend on them) and a whitespace-only compactor.

export interface Tok {
  /** id (names and keywords), num, str, tpl (a template literal piece), re, p (punctuator), c (kept licence comment) */
  t: "id" | "num" | "str" | "tpl" | "re" | "p" | "c";
  v: string;
  /** A line break came before this token. */
  nl: boolean;
}

const PUNCT = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**"];
const REGEX_AFTER_KW = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const isIdStart = (c: string) => /[A-Za-z_$\\#]/.test(c) || c.charCodeAt(0) > 127;
const isIdPart = (c: string) => /[A-Za-z0-9_$\\]/.test(c) || c.charCodeAt(0) > 127;

/** Splits source into tokens. Throws on an unterminated string, comment, template or regex. */
export function tokenizeJs(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let nl = false;
  const n = src.length;
  const braces: boolean[] = []; // true = a `${` of a template
  const push = (t: Tok["t"], v: string) => {
    out.push({ t, v, nl });
    nl = false;
  };
  const regexAllowed = () => {
    const p = out.filter((x) => x.t !== "c").at(-1);
    if (!p) return true;
    if (p.t === "p") return ![")", "]", "}"].includes(p.v) || false;
    if (p.t === "id") return REGEX_AFTER_KW.has(p.v);
    return false;
  };
  /** Reads template text from i (just after ` or }) up to ${ or the closing `. */
  const template = (start: string) => {
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === "\\") j += 2;
      else if (c === "`") {
        push("tpl", start + src.slice(i, j + 1));
        i = j + 1;
        return;
      } else if (c === "$" && src[j + 1] === "{") {
        push("tpl", start + src.slice(i, j + 2));
        braces.push(true);
        i = j + 2;
        return;
      } else j++;
    }
    throw new Error("unterminated template literal");
  };
  if (src.startsWith("#!")) {
    const e = src.indexOf("\n");
    i = e < 0 ? n : e;
  }
  while (i < n) {
    const c = src[i];
    if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") {
      nl = true;
      i++;
    } else if (/\s/.test(c) || c === "﻿") i++;
    else if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r" && src[i] !== "\u2028" && src[i] !== "\u2029") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new Error("unterminated comment");
      const text = src.slice(i, e + 2);
      if (/^\/\*[!]|@license|@preserve|@cc_on/.test(text)) push("c", text);
      if (/[\n\r\u2028\u2029]/.test(text)) nl = true;
      i = e + 2;
    } else if (c === "<" && src.startsWith("<!--", i)) {
      throw new Error("HTML-style comment");
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") throw new Error("unterminated string");
        j++;
      }
      if (j >= n) throw new Error("unterminated string");
      push("str", src.slice(i, j + 1));
      i = j + 1;
    } else if (c === "`") {
      i++;
      template("`");
    } else if (c === "}" && braces.at(-1) === true) {
      braces.pop();
      i++;
      template("}");
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:0[xXoObB][0-9a-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/.exec(src.slice(i, i + 80))!;
      push("num", m[0]);
      i += m[0].length;
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      push("id", src.slice(i, j));
      i = j;
    } else if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < n) {
        const d = src[j];
        if (d === "\n") throw new Error("unterminated regex");
        if (d === "\\") j++;
        else if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
        j++;
      }
      if (j >= n) throw new Error("unterminated regex");
      j++;
      while (j < n && isIdPart(src[j])) j++;
      push("re", src.slice(i, j));
      i = j;
    } else {
      let p = PUNCT.find((x) => src.startsWith(x, i));
      if (p === "?." && /[0-9]/.test(src[i + 2] ?? "")) p = undefined;
      p ??= c;
      if (c === "{") braces.push(false);
      else if (c === "}") braces.pop();
      push("p", p);
      i += p.length;
    }
  }
  if (braces.length) throw new Error("unbalanced braces");
  return out;
}

const SAFE_PREV_KW = new Set(["else", "do", "typeof", "void", "delete", "new", "in", "instanceof", "of", "case", "extends"]);
const SAFE_NEXT_P = new Set([")", "]", "}", ",", ".", "?.", "?", ":", ";", "=>", "=", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "**", "&", "|", "^", "&&", "||", "??", "<<", ">>", ">>>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>=", "**=", "&&=", "||=", "??="]);

/** Could a line break between these tokens be what ends a statement? */
function hazard(prev: Tok | undefined, next: Tok): boolean {
  if (!prev) return false;
  if (prev.t === "p" && ![")", "]", "}", "++", "--"].includes(prev.v)) return false;
  if (prev.t === "id" && SAFE_PREV_KW.has(prev.v)) return false;
  if (next.t === "p" && SAFE_NEXT_P.has(next.v)) return false;
  if (next.t === "id" && (next.v === "in" || next.v === "instanceof" || next.v === "of")) return false;
  return true;
}
const RESTRICTED = new Set(["return", "break", "continue", "throw", "yield", "async"]);

/** A string literal without its quotes, so 'a' and "a" (and \' inside) compare equal. */
const strBody = (v: string) => v.slice(1, -1).replace(/\\([\s\S])/g, (m, c: string) => (c === "'" || c === '"' ? c : m));

/** Decimal spelling without leading/trailing zeros (0.50 -> .5); other numbers as written. */
const numBody = (v: string) => {
  const m = /^(\d*)\.?(\d*)([eE][+-]?\d+)?$/.exec(v);
  if (!m || (v.includes(".") === false && !m[3] && !/^0\d/.test(v))) return v;
  const int = m[1].replace(/^0+/, ""), frac = m[2].replace(/0+$/, "");
  return (int || (frac ? "" : "0")) + (frac ? "." + frac : "") + (m[3] ?? "").toLowerCase();
};

/** true, or why the two token streams differ. */
export function sameJsTokens(a: Tok[], b: Tok[]): true | string {
  a = a.filter((t) => t.t !== "c");
  b = b.filter((t) => t.t !== "c");
  let i = 0, j = 0;
  let inserted = false;
  while (i < a.length || j < b.length) {
    const x = a[i], y = b[j];
    if (x && y && x.t === y.t && (x.v === y.v || (x.t === "str" && strBody(x.v) === strBody(y.v)) || (x.t === "num" && numBody(x.v) === numBody(y.v)))) {
      if (x.nl && !y.nl && !inserted && hazard(a[i - 1], x)) return `a line break before "${x.v}" was removed`;
      if (y.nl && !x.nl && ((j > 0 && b[j - 1].t === "id" && RESTRICTED.has(b[j - 1].v)) || (y.t === "p" && ["++", "--", "=>"].includes(y.v)))) return `a line break was added before "${y.v}"`;
      inserted = false;
      i++;
      j++;
    } else if (x && x.t === "p" && x.v === ";" && (i === a.length - 1 || (a[i + 1].t === "p" && a[i + 1].v === "}"))) i++; // `;}` -> `}`
    else if (y && y.t === "p" && y.v === ";" && x && (x.nl || (x.t === "p" && x.v === "}"))) {
      inserted = x.nl;
      j++;
    } else return `tokens differ near "${(x ?? y)?.v?.slice(0, 40)}"`;
  }
  return true;
}

export function sameJs(a: string, b: string): true | string {
  try {
    return sameJsTokens(tokenizeJs(a), tokenizeJs(b));
  } catch (e) {
    return `not valid JavaScript: ${errorMessage(e)}`;
  }
}

const word = (c: string) => /[A-Za-z0-9_$\\]/.test(c) || c.charCodeAt(0) > 127;

/** Source with comments and insignificant whitespace removed (line breaks kept where ASI could matter). */
export function compactJs(src: string): string {
  const toks = tokenizeJs(src);
  let out = "";
  let prev: Tok | undefined;
  for (const t of toks) {
    if (prev) {
      const a = out[out.length - 1], b = t.v[0];
      const sep =
        prev.t === "c" || t.t === "c" || (t.nl && hazard(prev, t)) || (prev.t === "p" && prev.v === ";" ? false : false)
          ? "\n"
          : (word(a) && word(b)) || (a === "+" && b === "+") || (a === "-" && b === "-") || (a === "/" && (b === "/" || b === "*")) || (a === "<" && b === "!") || (out.endsWith("--") && b === ">") || (prev.t === "num" && b === "." && /^\d+$/.test(prev.v))
            ? " "
            : (t.nl && prev.t === "id" && RESTRICTED.has(prev.v)) ? "\n" : "";
      out += sep;
    }
    out += t.v;
    prev = t;
  }
  return out;
}
