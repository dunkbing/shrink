// CSS rule-list parser: the oracle for CSS minification (selectors, declarations and nesting compared in a
// normal form) and a whitespace/comment-only compactor built on the same parse.

export type CssNode =
  | { k: "decl"; p: string; v: string }
  /** `body` is null for a statement at-rule (`@import ...;`) */
  | { k: "rule"; sel: string; body: CssNode[] | null }
  | { k: "c"; text: string };

/** Strings and unquoted url() bodies are swapped for placeholders so that whitespace rules never touch them. */
function protect(s: string): { text: string; parts: string[] } {
  const parts: string[] = [];
  let text = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (s[j] === "\\") j++;
        else if (s[j] === "\n") throw new Error("unterminated string");
        j++;
      }
      if (j >= s.length) throw new Error("unterminated string");
      text += `\u0000${parts.length}\u0000`;
      parts.push(s.slice(i, j + 1));
      i = j + 1;
    } else if (c === "\\") {
      text += `\u0000${parts.length}\u0000`;
      parts.push(s.slice(i, i + 2));
      i += 2;
    } else if ((c === "u" || c === "U") && /^url\(\s*[^"'\s)]/i.test(s.slice(i, i + 20)) && !/[\w-]/.test(s[i - 1] ?? " ")) {
      const e = s.indexOf(")", i);
      if (e < 0) throw new Error("unterminated url()");
      const inner = s.slice(i + 4, e).trim();
      text += `url(\u0000${parts.length}\u0000)`;
      parts.push(inner);
      i = e + 1;
    } else {
      text += c;
      i++;
    }
  }
  return { text, parts };
}
const restore = (text: string, parts: string[]) => text.replace(/\u0000(\d+)\u0000/g, (_, n) => parts[+n]);

const COLOR_NAMES = new Map(("aqua 00ffff|black 000000|blue 0000ff|fuchsia ff00ff|gray 808080|grey 808080|green 008000|lime 00ff00|maroon 800000|navy 000080|olive 808000|purple 800080|red ff0000|silver c0c0c0|teal 008080|white ffffff|yellow ffff00|orange ffa500|brown a52a2a|pink ffc0cb|cyan 00ffff|magenta ff00ff|gold ffd700|indigo 4b0082|violet ee82ee|tan d2b48c|coral ff7f50|salmon fa8072|khaki f0e68c|crimson dc143c|tomato ff6347|orchid da70d6|plum dda0dd|peru cd853f|sienna a0522d|snow fffafa|ivory fffff0|linen faf0e6|beige f5f5dc|azure f0ffff|bisque ffe4c4|wheat f5deb3|lavender e6e6fa|turquoise 40e0d0|chocolate d2691e|firebrick b22222|orangered ff4500|skyblue 87ceeb|steelblue 4682b4|slategray 708090|darkgray a9a9a9|lightgray d3d3d3|gainsboro dcdcdc|whitesmoke f5f5f5|goldenrod daa520|hotpink ff69b4|deeppink ff1493|royalblue 4169e1|darkblue 00008b|darkgreen 006400|darkred 8b0000|limegreen 32cd32|forestgreen 228b22|seagreen 2e8b57|dodgerblue 1e90ff|midnightblue 191970|slateblue 6a5acd|mintcream f5fffa|honeydew f0fff0|aliceblue f0f8ff|ghostwhite f8f8ff|oldlace fdf5e6|seashell fff5ee|mistyrose ffe4e1|lightyellow ffffe0|lightblue add8e6|lightgreen 90ee90|lightpink ffb6c1|darkorange ff8c00|rebeccapurple 663399").split("|").map((p) => p.split(" ") as [string, string]));
const shortHex = (h: string) => ((h.length === 6 || h.length === 8) && /^(.)\1(.)\2(.)\3(?:(.)\4)?$/.test(h) ? h[0] + h[2] + h[4] + (h.length === 8 ? h[6] : "") : h);

function normNumber(m: string): string {
  const mm = /^([+-]?)(\d*)\.?(\d*)(e[+-]?\d+)?$/i.exec(m);
  if (!mm) return m;
  let [, sign, int, frac, exp] = mm;
  int = int.replace(/^0+/, "");
  frac = frac.replace(/0+$/, "");
  if (!int && !frac) return "0";
  return sign.replace("+", "") + int + (frac ? "." + frac : "") + (exp ?? "").toLowerCase();
}

/** Declaration value in a normal form. `numbers` also normalises number spelling and hex colours (for comparing a tool's output). */
function normValue(v: string, numbers: boolean): string {
  const { text, parts } = protect(v);
  let t = text.replace(/\s+/g, " ").trim().replace(/\s*!\s*important\s*$/i, "!important");
  t = t.replace(/ ?, ?/g, ",").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/\) (?=[a-z#"'\u0000])/gi, ")").replace(/ ?([/])\s?/g, "$1");
  if (numbers) {
    const calc = /\b(?:calc|min|max|clamp|var|env)\(/i.test(t);
    t = t.replace(/(?<![\w#.\u0000-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/gi, (_, num: string, unit: string) => {
      const n = normNumber(num);
      if (n === "0" && !calc && /^(px|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q)$/i.test(unit)) return "0";
      return n + unit;
    });
    t = t.replace(/#([0-9a-f]{3,8})\b/gi, (_, h: string) => "#" + shortHex(h.toLowerCase()));
    t = t.replace(/\brgb\(\s*(\d{1,3}),(\d{1,3}),(\d{1,3})\)/gi, (m, r, g, b) => (+r > 255 || +g > 255 || +b > 255 ? m : "#" + shortHex([r, g, b].map((x) => (+x).toString(16).padStart(2, "0")).join(""))));
    t = t.replace(/rgba\(0,0,0,0\)/gi, "transparent");
    t = t.replace(/(?<![\w#.-])([a-z]+)(?![\w(-])/gi, (m, n: string) => (COLOR_NAMES.has(n.toLowerCase()) ? "#" + shortHex(COLOR_NAMES.get(n.toLowerCase())!) : m));
  }
  return restore(t, parts);
}

function normSelector(s: string): string {
  const { text, parts } = protect(s);
  let t = text.replace(/\s+/g, " ").trim();
  if (t.startsWith("@")) t = t.replace(/ ?, ?/g, ",").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ?: ?/g, ":");
  else t = t.replace(/ ?([,>~+]) ?/g, "$1").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/\[ /g, "[").replace(/ \]/g, "]").replace(/ ?(=|[~|^$*]=) ?/g, "$1");
  // [type="x"] and [type=x] are the same when x is an identifier
  t = t.replace(/\[([\w-]+)([~|^$*]?=)\u0000(\d+)\u0000/g, (m, a, op, n) => (/^(["'])-?[A-Za-z_][\w-]*\1$/.test(parts[+n]) ? `[${a}${op}${parts[+n].slice(1, -1)}` : m));
  return restore(t, parts);
}

/** Finds the end of a prelude/declaration: the index of the first `;`, `{` or `}` outside strings, parens and brackets. */
function scan(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) throw new Error("unterminated string");
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ";" || c === "{" || c === "}")) return i;
    i++;
  }
  return i;
}

/** Removes comments (keeping `/*!` ones as markers). */
function stripComments(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      if (e < 0) throw new Error("unterminated comment");
      const text = s.slice(i, e + 2);
      out += text.startsWith("/*!") ? "\u0001" + text.replace(/\u0001/g, "") + "\u0002" : " ";
      i = e + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Properties whose values are verified by rendering, not by text (SVG). */
export const COLOR_PROPS = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"]);

export function parseCss(src: string, numbers = false, lenient = false): CssNode[] {
  const s = stripComments(src.replace(/^﻿/, ""));
  let i = 0;
  const block = (top: boolean): CssNode[] => {
    const nodes: CssNode[] = [];
    for (;;) {
      while (i < s.length && /[\s;]/.test(s[i])) i++;
      if (i >= s.length) {
        if (!top) throw new Error("unclosed block");
        return nodes;
      }
      if (s[i] === "}") {
        if (top) throw new Error("unbalanced }");
        i++;
        return nodes;
      }
      if (s[i] === "\u0001") {
        const e = s.indexOf("\u0002", i);
        nodes.push({ k: "c", text: s.slice(i + 1, e) });
        i = e + 1;
        continue;
      }
      const start = i;
      i = scan(s, i);
      const head = s.slice(start, i).replace(/[\u0001\u0002]/g, " ");
      const end = s[i];
      if (end === "{") {
        i++;
        const custom = /^\s*--[\w-]*\s*:/.test(head);
        if (custom) {
          // a custom property whose value is a {} block: keep the text as is
          let depth = 1, j = i;
          while (j < s.length && depth) {
            if (s[j] === "{") depth++;
            else if (s[j] === "}") depth--;
            j++;
          }
          if (depth) throw new Error("unclosed block");
          nodes.push({ k: "decl", p: head.slice(0, head.indexOf(":")).trim(), v: "{" + s.slice(i, j - 1).replace(/\s+/g, " ").trim() + "}" });
          i = j;
        } else nodes.push({ k: "rule", sel: normSelector(head), body: block(false) });
      } else {
        if (end === ";") i++;
        if (!head.trim()) continue;
        if (head.trimStart().startsWith("@")) nodes.push({ k: "rule", sel: normSelector(head), body: null });
        else {
          const { text } = protect(head);
          const c = text.indexOf(":");
          if (c < 0) throw new Error(`not a declaration: ${head.trim().slice(0, 40)}`);
          const name = head.slice(0, c).trim();
          const p = name.startsWith("--") ? name : name.toLowerCase();
          nodes.push({ k: "decl", p, v: lenient && COLOR_PROPS.has(p) ? "*" : normValue(head.slice(c + 1), numbers) });
        }
      }
    }
  };
  const r = block(true);
  return r;
}

/** Serialised normal form; empty rules and licence comments dropped when `compare` (the oracle's view). */
export function serializeCss(nodes: CssNode[], compare = false): string {
  let out = "";
  let pendingSemi = false;
  for (const n of nodes) {
    let text: string;
    if (n.k === "c") {
      if (compare) continue;
      text = n.text + "\n";
    } else if (n.k === "decl") text = `${n.p}:${n.v}`;
    else if (n.body === null) text = n.sel + ";";
    else {
      const sel = compare ? n.sel.replace(/^(@[\w-]+) \(/, "$1(") : n.sel;
      const inner = serializeCss(n.body, compare);
      if (compare && !inner) continue;
      text = sel + "{" + inner + "}";
    }
    if (pendingSemi) out += ";";
    out += text;
    pendingSemi = n.k === "decl";
  }
  return out;
}

export function sameCss(a: string, b: string, lenient = false): true | string {
  try {
    const x = serializeCss(parseCss(a, true, lenient), true);
    const y = serializeCss(parseCss(b, true, lenient), true);
    if (x === y) return true;
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    return `rules differ near "${x.slice(Math.max(0, i - 20), i + 30)}" / "${y.slice(Math.max(0, i - 20), i + 30)}"`;
  } catch (e: any) {
    return `not valid CSS: ${e?.message ?? e}`;
  }
}

/** The stylesheet with comments and extra whitespace removed (values and selectors otherwise as written). */
export function compactCss(src: string): string {
  return serializeCss(parseCss(src, false));
}
