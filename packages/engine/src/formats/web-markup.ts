// XML / SVG / HTML structure: ordered event streams compared for equality (whitespace that cannot matter is
// ignored), JSON token streams, and the guards the web formats share. Bun.XML validates XML; HTMLRewriter reads HTML.
import { sameCss, parseCss, serializeCss, COLOR_PROPS } from "./web-css";
import { sameJs } from "./web-js";

export type Ev =
  | { t: "s"; name: string; attrs: [string, string][] }
  | { t: "e"; name: string }
  | { t: "x"; text: string }
  | { t: "pi"; text: string }
  | { t: "dt"; text: string }
  | { t: "raw"; kind: "js" | "css" | "json" | "other"; text: string }
  | { t: "cc"; text: string };

const ENTITY_DECL = /<!ENTITY/i;

/** Rejects documents that declare entities (billion laughs, external entities): they are never parsed. */
export function checkXmlSafe(text: string): void {
  if (ENTITY_DECL.test(text)) throw new SafetyError("declares XML entities");
}
export class SafetyError extends Error {}

/** Parses with Bun's XML parser: throws if the document is not well formed. */
export function checkXml(text: string): void {
  checkXmlSafe(text);
  Bun.XML.parse(text);
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e]!;
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Namespaces of editor data that does not change how an SVG renders. */
const EDITOR_NS = [
  "http://www.inkscape.org/namespaces/inkscape",
  "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "http://purl.org/dc/elements/1.1/",
  "http://creativecommons.org/ns#",
  "http://web.resource.org/cc/",
  "http://ns.adobe.com/",
  "http://www.serif.com/",
  "http://www.bohemiancoding.com/sketch/ns",
  "http://schemas.microsoft.com/visio/",
];
const isEditorNs = (u: string) => EDITOR_NS.some((e) => u.startsWith(e));
/** Elements whose white space is content. */
const TEXTUAL = new Set(["text", "tspan", "textPath", "tref", "title", "desc", "style", "script", "foreignObject", "a"]);
/** Attributes (presentation, geometry) that the rendered-pixel compare verifies; the rest are compared as text. */
const RENDERED_ATTRS = new Set(
  ("d points transform gradientTransform patternTransform viewBox preserveAspectRatio x y width height cx cy r rx ry x1 y1 x2 y2 fx fy fr offset dx dy rotate textLength lengthAdjust " +
    "fill stroke stop-color flood-color lighting-color color fill-opacity stroke-opacity stop-opacity flood-opacity stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset " +
    "fill-rule clip-rule clip-path mask filter marker-start marker-mid marker-end font-family font-size font-weight font-style font-variant font-stretch letter-spacing word-spacing text-anchor text-decoration " +
    "dominant-baseline alignment-baseline baseline-shift direction writing-mode unicode-bidi shape-rendering text-rendering image-rendering color-interpolation color-interpolation-filters color-rendering " +
    "paint-order vector-effect mix-blend-mode isolation overflow clipPathUnits maskUnits maskContentUnits gradientUnits patternUnits patternContentUnits primitiveUnits filterUnits spreadMethod " +
    "stdDeviation in in2 result operator values type mode k1 k2 k3 k4 scale order kernelMatrix divisor bias targetX targetY edgeMode kernelUnitLength surfaceScale diffuseConstant specularConstant specularExponent " +
    "azimuth elevation z pointsAtX pointsAtY pointsAtZ limitingConeAngle baseFrequency numOctaves seed stitchTiles tableValues slope intercept amplitude exponent xChannelSelector yChannelSelector refX refY markerWidth markerHeight markerUnits orient")
    .split(" "),
);
/** Elements that only group: the renderer decides whether they matter. */
const GROUPING = new Set(["g", "defs"]);

export interface XmlOpts {
  /** SVG rules: editor data ignored, geometry/colour attributes left to the render check. */
  svg: boolean;
}

/** Ordered events of an XML document. Throws on anything not well formed. */
export function xmlEvents(src: string, o: XmlOpts): Ev[] {
  const s = src.replace(/^﻿/, "");
  const ev: Ev[] = [];
  const ns: Map<string, string>[] = [new Map([["xml", "http://www.w3.org/XML/1998/namespace"]])];
  const names: { q: string; resolved: string; preserve: boolean; textual: boolean; skip: boolean; group: boolean }[] = [];
  let buf = "";
  let skip = 0;
  const top = () => names[names.length - 1];
  const flush = () => {
    if (!buf) return;
    const t = top();
    if (t && !skip) {
      if (t.preserve) ev.push({ t: "x", text: buf });
      else {
        const c = buf.replace(/[ \t\r\n]+/g, " ");
        if (c !== " " || t.textual) ev.push({ t: "x", text: c });
      }
    } else if (!t && buf.trim()) throw new Error("text outside the root element");
    buf = "";
  };
  const resolve = (q: string, attr: boolean): string => {
    const c = q.indexOf(":");
    const prefix = c < 0 ? "" : q.slice(0, c);
    const local = c < 0 ? q : q.slice(c + 1);
    if (attr && c < 0) return local;
    for (let k = ns.length - 1; k >= 0; k--) if (ns[k].has(prefix)) return `${ns[k].get(prefix)}|${local}`;
    if (prefix) throw new Error(`unbound prefix ${prefix}`);
    return `|${local}`;
  };
  let i = 0;
  let roots = 0;
  while (i < s.length) {
    if (s[i] !== "<") {
      const e = s.indexOf("<", i);
      const end = e < 0 ? s.length : e;
      buf += decodeEntities(s.slice(i, end));
      i = end;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const e = s.indexOf("-->", i + 4);
      if (e < 0) throw new Error("unterminated comment");
      i = e + 3;
    } else if (s.startsWith("<![CDATA[", i)) {
      const e = s.indexOf("]]>", i);
      if (e < 0) throw new Error("unterminated CDATA");
      buf += s.slice(i + 9, e);
      i = e + 3;
    } else if (s.startsWith("<?", i)) {
      const e = s.indexOf("?>", i);
      if (e < 0) throw new Error("unterminated processing instruction");
      const text = s.slice(i + 2, e).trim();
      if (!/^xml(\s|$)/.test(text)) ev.push({ t: "pi", text: text.replace(/\s+/g, " ") });
      i = e + 2;
    } else if (s.startsWith("<!", i)) {
      let j = i + 2, depth = 0, q = "";
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) {
          if (c === q) q = "";
        } else if (c === '"' || c === "'") q = c;
        else if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= s.length) throw new Error("unterminated declaration");
      const text = s.slice(i, j + 1).replace(/\s+/g, " ");
      if (text.includes("[")) ev.push({ t: "dt", text });
      i = j + 1;
    } else if (s.startsWith("</", i)) {
      flush();
      const e = s.indexOf(">", i);
      if (e < 0) throw new Error("unterminated tag");
      const q = s.slice(i + 2, e).trim();
      const t = names.pop();
      if (!t || t.q !== q) throw new Error(`mismatched </${q}>`);
      ns.pop();
      if (t.skip) skip--;
      else if (!t.group) ev.push({ t: "e", name: t.resolved });
      i = e + 1;
    } else {
      flush();
      let j = i + 1, q = "";
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) {
          if (c === q) q = "";
        } else if (c === '"' || c === "'") q = c;
        else if (c === ">") break;
      }
      if (j >= s.length) throw new Error("unterminated tag");
      let inner = s.slice(i + 1, j);
      const selfClose = inner.endsWith("/");
      if (selfClose) inner = inner.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(inner);
      if (!m) throw new Error("bad tag");
      const q0 = m[1];
      const attrs: [string, string][] = [];
      const scope = new Map<string, string>();
      const rest = inner.slice(q0.length);
      const re = /\s+([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
      let pos = 0;
      for (;;) {
        re.lastIndex = pos;
        const a = re.exec(rest);
        if (!a) break;
        pos = re.lastIndex;
        const v = decodeEntities((a[3] ?? a[4]).replace(/[\t\r\n]/g, " "));
        if (a[1] === "xmlns") scope.set("", v);
        else if (a[1].startsWith("xmlns:")) scope.set(a[1].slice(6), v);
        else attrs.push([a[1], v]);
      }
      if (rest.slice(pos).trim()) throw new Error("bad attributes");
      ns.push(scope);
      if (!names.length && ++roots > 1) throw new Error("more than one root");
      const resolved = resolve(q0, false);
      const [uri, local] = resolved.split("|");
      const parent = top();
      const hide = skip > 0 || (o.svg && (isEditorNs(uri) || (uri === SVG_NS && local === "metadata")));
      const group = !hide && o.svg && uri === SVG_NS && GROUPING.has(local);
      const xs = attrs.find(([n]) => n === "xml:space")?.[1];
      const preserve = xs === "preserve" || (xs !== "default" && !!parent?.preserve);
      const textual = !!(o.svg && (TEXTUAL.has(local) || parent?.textual));
      names.push({ q: q0, resolved, preserve, textual, skip: hide, group });
      if (hide) skip++;
      else if (!group) {
        const seen = new Set<string>();
        const out: [string, string][] = [];
        for (const [n, v] of attrs) {
          const r = resolve(n, true);
          if (seen.has(r)) throw new Error(`duplicate attribute ${n}`);
          seen.add(r);
          if (o.svg && (isEditorNs(r.split("|")[0]) || n === "version" || n === "baseProfile" || (n === "type" && /^(text\/css|text\/javascript|application\/(x-)?javascript)$/.test(v) && (local === "style" || local === "script")))) continue;
          out.push([r, v]);
        }
        out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
        ev.push({ t: "s", name: resolved, attrs: out });
      }
      if (selfClose) {
        names.pop();
        ns.pop();
        if (hide) skip--;
        else if (!group) ev.push({ t: "e", name: resolved });
      }
      i = j + 1;
    }
  }
  flush();
  if (names.length) throw new Error("unclosed element");
  if (!roots) throw new Error("no root element");
  return o.svg ? foldRaw(ev) : ev;
}

/** Folds the text of <style>/<script> into one comparable chunk. */
function foldRaw(ev: Ev[]): Ev[] {
  const out: Ev[] = [];
  for (let k = 0; k < ev.length; k++) {
    const e = ev[k];
    out.push(e);
    if (e.t === "s" && e.name === `${SVG_NS}|style` || e.t === "s" && e.name === `${SVG_NS}|script`) {
      const kind = e.name.endsWith("|style") ? "css" : "js";
      let text = "";
      let j = k + 1;
      while (ev[j] && ev[j].t === "x") text += (ev[j++] as any).text;
      if (j > k + 1) {
        out.push({ t: "raw", kind, text });
        k = j - 1;
      }
    }
  }
  return out;
}

const normNum = (v: string) =>
  v
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ ?, ?/g, ",")
    .replace(/(?<![\w#.-])([+-]?)0*(\d*)(\.\d*?)0*(?![\d])/g, (m, s, i, f) => (f === "." ? s + (i || "0") : s + i + f))
    .replace(/(?<![\w#.-])([+-]?)0+(\d)/g, "$1$2");

function attrCanon(name: string, value: string, svg: boolean): string | null {
  const local = name.split("|").pop()!;
  if (svg && RENDERED_ATTRS.has(local)) return "*";
  if (svg && local === "style") {
    try {
      return serializeCss(parseCss(value, true, true), true);
    } catch {
      return value;
    }
  }
  if (svg) return normNum(value);
  return value;
}

/** true, or why the two event streams differ. */
export function sameEvents(a: Ev[], b: Ev[], o: XmlOpts): true | string {
  if (a.length !== b.length) {
    const n = Math.min(a.length, b.length);
    for (let k = 0; k < n; k++) {
      const r = sameEvent(a[k], b[k], o);
      if (r !== true) return r;
    }
    return `structure differs (${a.length} vs ${b.length} nodes)`;
  }
  for (let k = 0; k < a.length; k++) {
    const r = sameEvent(a[k], b[k], o);
    if (r !== true) return r;
  }
  return true;
}

function sameEvent(x: Ev, y: Ev, o: XmlOpts): true | string {
  if (x.t !== y.t) return `node kinds differ (${x.t} vs ${y.t})`;
  switch (x.t) {
    case "s": {
      const z = y as typeof x;
      if (x.name !== z.name) return `element ${x.name} became ${z.name}`;
      const ax = x.attrs.map(([n, v]) => [n, attrCanon(n, v, o.svg)] as const);
      const az = z.attrs.map(([n, v]) => [n, attrCanon(n, v, o.svg)] as const);
      if (ax.length !== az.length || ax.some(([n], k) => n !== az[k][0])) return `attributes of <${x.name.split("|")[1]}> differ`;
      for (let k = 0; k < ax.length; k++) if (ax[k][1] !== az[k][1]) return `attribute ${ax[k][0]} of <${x.name.split("|")[1]}> differs`;
      return true;
    }
    case "e":
      return x.name === (y as typeof x).name ? true : "end tags differ";
    case "raw": {
      const z = y as typeof x;
      const r = x.kind === "css" ? sameCss(x.text, z.text, true) : sameJs(x.text, z.text);
      return r === true ? true : `${x.kind}: ${r}`;
    }
    default:
      return x.text === (y as typeof x).text ? true : `${x.t} differs: "${x.text.slice(0, 40)}" vs "${(y as typeof x).text.slice(0, 40)}"`;
  }
}

// ---------------------------------------------------------------- JSON

export type JsonTok = string;

/** RFC 8259 tokens with the raw spelling of strings and numbers. Throws if the text is not valid JSON. */
export function jsonTokens(src: string): JsonTok[] {
  const s = src.replace(/^﻿/, "");
  const out: string[] = [];
  const re = /\s*(?:("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:]))/y;
  let i = 0;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) break;
    out.push(m[0].trim());
    i = re.lastIndex;
  }
  if (s.slice(i).trim()) throw new Error(`invalid JSON at offset ${i}`);
  JSON.parse(s); // grammar check
  return out;
}
export function sameJson(a: JsonTok[], b: string): true | string {
  let t: JsonTok[];
  try {
    t = jsonTokens(b);
  } catch (e: any) {
    return `not valid JSON: ${e?.message ?? e}`;
  }
  if (a.length !== t.length) return "JSON content differs";
  for (let k = 0; k < a.length; k++) if (a[k] !== t[k]) return `JSON differs near ${a[k].slice(0, 30)} / ${t[k].slice(0, 30)}`;
  return true;
}

// ---------------------------------------------------------------- HTML

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const OPTIONAL_END = new Set(["html", "head", "body", "p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot", "option", "optgroup", "colgroup", "caption", "rb", "rt", "rtc", "rp"]);
const BARE_OK = new Set(["html", "head", "body", "tbody", "colgroup"]);
const BLOCK = new Set("html head body title meta link script style base noscript template div p ul ol li dl dt dd table thead tbody tfoot tr td th caption colgroup col form fieldset legend h1 h2 h3 h4 h5 h6 header footer nav main section article aside hr br blockquote address figure figcaption details summary select option optgroup datalist menu dialog hgroup".split(" "));
/** Elements whose content is never parsed as markup. */
const RAW_TEXT = new Set(["script", "style", "title", "textarea"]);
const URL_ATTRS = new Set(["href", "src", "action", "poster", "data", "cite", "formaction"]);

export const HTML_SENSITIVE = /<(pre|textarea|xmp|listing|plaintext)[\s>]|white-space\s*:\s*(pre|break-spaces)|<svg[\s\S]*?<text[\s>]/i;

interface HEv {
  t: "s" | "e" | "x" | "cc" | "dt" | "raw";
  v: string;
  attrs?: [string, string][];
  kind?: string;
}

/** Ordered events of an HTML document as lol-html tokenizes it (no tree is built). */
export async function htmlEvents(src: string): Promise<HEv[]> {
  const ev: HEv[] = [];
  let raw = null as { tag: string; type: string; text: string } | null;
  const rw = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        const attrs: [string, string][] = [];
        for (const [n, v] of el.attributes) attrs.push([n.toLowerCase(), v]);
        attrs.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
        ev.push({ t: "s", v: tag, attrs });
        if (!VOID.has(tag) && !el.selfClosing) {
          if (RAW_TEXT.has(tag)) raw = { tag, type: (el.getAttribute("type") ?? "").toLowerCase().split(";")[0].trim(), text: "" };
          el.onEndTag(() => {
            if (raw && raw.tag === tag) {
              ev.push({ t: "raw", v: raw.text, kind: tag === "style" ? "css" : tag === "script" ? (raw.type === "" || /javascript|ecmascript|^module$/.test(raw.type) ? "js" : /json|importmap|speculationrules/.test(raw.type) ? "json" : "other") : "other" });
              raw = null;
            }
            ev.push({ t: "e", v: tag });
          });
        }
      },
    })
    .onDocument({
      text(t) {
        if (raw) raw.text += t.text;
        else if (t.text) ev.push({ t: "x", v: t.text });
      },
      comments(c) {
        if (/^\[if|^<!\[endif|^\[endif/i.test(c.text) || /^\s*\[if/i.test(c.text)) ev.push({ t: "cc", v: c.text.replace(/[\s"']+/g, "") });
      },
      doctype(d) {
        ev.push({ t: "dt", v: `${d.name?.toLowerCase()}|${d.publicId ?? ""}|${d.systemId ?? ""}` });
      },
    });
  await rw.transform(new Response(src)).text();
  return ev;
}

function canonHtml(ev: HEv[]): HEv[] {
  // 1. merge adjacent text; 2. decide which white space can matter (before optional tags disappear); 3. drop optional tags
  const merged: HEv[] = [];
  for (const e of ev) {
    const last = merged[merged.length - 1];
    if (e.t === "x" && last?.t === "x") last.v += e.v;
    else merged.push(e.t === "x" ? { ...e } : e);
  }
  const blocky = (e?: HEv) => !e || (e.t === "s" || e.t === "e" ? BLOCK.has(e.v) : e.t === "dt" || e.t === "raw" || e.t === "cc");
  const res: HEv[] = [];
  for (let k = 0; k < merged.length; k++) {
    const e = merged[k];
    if (e.t === "x") {
      let t = e.v.replace(/[ \t\r\n\f]+/g, " ");
      if (blocky(merged[k - 1])) t = t.replace(/^ /, "");
      if (blocky(merged[k + 1])) t = t.replace(/ $/, "");
      if (t) res.push({ t: "x", v: t });
    } else if (e.t === "s" && BARE_OK.has(e.v) && !e.attrs!.length) continue;
    else if (e.t === "e" && OPTIONAL_END.has(e.v)) continue;
    else res.push(e);
  }
  return res;
}

function htmlAttr(tag: string, n: string, v: string): string {
  if (v === n) return "";
  if (n === "class") return v.trim().replace(/\s+/g, " ");
  if (n === "style") {
    try {
      return serializeCss(parseCss(v, true), true);
    } catch {
      return v;
    }
  }
  if (n.startsWith("on")) return v.trim();
  if (n === "content" && tag === "meta") return v.trim().replace(/\s*([,;])\s*/g, "$1").replace(/(\d)\.0+(?!\d)/g, "$1");
  if (URL_ATTRS.has(n)) return v.trim();
  if (n === "type" && ((tag === "script" && /^(text|application)\/(x-)?(java|ecma)script$/i.test(v)) || ((tag === "style" || tag === "link") && /^text\/css$/i.test(v)))) return "\u0000default";
  return v;
}

/** true, or why the two HTML token streams differ. */
export async function sameHtml(a: HEv[], bSrc: string): Promise<true | string> {
  let b: HEv[];
  try {
    b = canonHtml(await htmlEvents(bSrc));
  } catch (e: any) {
    return `not readable HTML: ${e?.message ?? e}`;
  }
  const x = canonHtml(a);
  const n = Math.max(x.length, b.length);
  for (let k = 0; k < n; k++) {
    const p = x[k], q = b[k];
    if (!p || !q) return `document structure differs (${x.length} vs ${b.length} nodes)`;
    if (p.t !== q.t) return `${p.t} ${p.v.slice(0, 20)} vs ${q.t} ${q.v.slice(0, 20)}`;
    if (p.t === "s") {
      if (p.v !== q.v) return `<${p.v}> became <${q.v}>`;
      const fa = p.attrs!.map(([n2, v]) => [n2, htmlAttr(p.v, n2, v)] as const).filter(([, v]) => v !== "\u0000default");
      const fb = q.attrs!.map(([n2, v]) => [n2, htmlAttr(q.v, n2, v)] as const).filter(([, v]) => v !== "\u0000default");
      if (fa.length !== fb.length || fa.some(([n2], i) => n2 !== fb[i][0])) return `attributes of <${p.v}> differ`;
      for (let i = 0; i < fa.length; i++) {
        const [nm, va] = fa[i];
        const vb = fb[i][1];
        if (va === vb) continue;
        if (nm.startsWith("on")) {
          const r = sameJs(va, vb);
          if (r === true) continue;
        }
        return `attribute ${nm} of <${p.v}> differs`;
      }
    } else if (p.t === "raw") {
      const r = p.kind === "css" ? sameCss(p.v, q.v) : p.kind === "js" ? sameJs(p.v, q.v) : p.kind === "json" ? (() => { try { return sameJson(jsonTokens(p.v), q.v); } catch (e: any) { return String(e?.message ?? e); } })() : p.v.trim().replace(/\s+/g, " ") === q.v.trim().replace(/\s+/g, " ") ? true : "script content differs";
      if (r !== true) return `${p.kind}: ${r}`;
    } else if (p.v !== q.v) return `${p.t} differs: "${p.v.slice(0, 40)}" vs "${q.v.slice(0, 40)}"`;
  }
  return true;
}

// ---------------------------------------------------------------- shared helpers

export const MAX_TEXT = 64 << 20;

/** The file as UTF-8 text; a SkipFile for anything that is not valid UTF-8 or is too large to verify. */
export async function readText(path: string, SkipFile: new (m: string) => Error): Promise<string> {
  const f = Bun.file(path);
  if (f.size > MAX_TEXT) throw new SkipFile("too large to verify");
  const bytes = new Uint8Array(await f.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkipFile("not UTF-8 text");
  }
}

/** The start of a file as text, without a BOM. */
export const headText = (head: Uint8Array) => new TextDecoder().decode(head).replace(/^﻿/, "");

/** Is the document's root element `<svg>`? (looks past the XML declaration, comments and DOCTYPE) */
export function rootIsSvg(head: string): boolean {
  let t = head.trimStart();
  for (;;) {
    if (t.startsWith("<?")) t = t.slice(Math.max(t.indexOf("?>"), 0) + 2);
    else if (t.startsWith("<!--")) {
      const e = t.indexOf("-->");
      if (e < 0) return false;
      t = t.slice(e + 3);
    } else if (/^<!DOCTYPE/i.test(t)) {
      const m = /^<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i.exec(t);
      if (!m) return /<svg[\s>]/.test(t);
      t = t.slice(m[0].length);
    } else break;
    t = t.trimStart();
  }
  return /^<(?:[\w.-]+:)?svg[\s>/]/.test(t);
}
