// HTML, CSS, JavaScript, JSON and the XML family (docs/FORMATS.md section 10). All off by default (web.* settings).
import { extname, join } from "node:path";
import { SkipFile, type Format, type Oracle, type Step } from "../types";
import { compactCss, parseCss, sameCss } from "./web-css";
import { compactJs, sameJs, tokenizeJs } from "./web-js";
import { checkXml, headText, htmlEvents, HTML_SENSITIVE, jsonTokens, readText, rootIsSvg, sameEvents, sameHtml, SafetyError, xmlEvents } from "./web-markup";
import { errorMessage } from "../errors";

const looksText = (head: Uint8Array) => !head.includes(0);
const startsWithTag = (head: Uint8Array) => headText(head).trimStart().startsWith("<");
const tiny = async (path: string) => ((await Bun.file(path).size) < 17 ? "too small to optimise" : null);

/** A native step: reads the text, writes the transformed text. */
function textStep(id: string, fn: (text: string) => string): Step {
  return {
    id,
    async run(input, output, ctx) {
      const text = await readText(input, SkipFile);
      await Bun.write(output, fn(text));
    },
  };
}

/** Runs `minify --type` (on a copy without a BOM: the tool refuses one); the tool's own exit code decides. */
const minify = (id: string, type: string, extra: string[] = []): Step => ({
  id,
  tool: "minify",
  async run(input, output, ctx) {
    let src = input;
    const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      src = join(ctx.dir, `nobom-${id}`);
      await Bun.write(src, bytes.subarray(3));
    }
    const r = await ctx.run("minify", ["--type", type, ...extra, "-o", output, src]);
    if (r.code !== 0) throw new Error(`minify exited with ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`);
  },
});

const ext = (name: string) => extname(name).slice(1).toLowerCase();

function textOracle<T>(prepare: (text: string) => T | Promise<T>, same: (orig: T, candidate: string) => true | string | Promise<true | string>): Oracle {
  return {
    async prepare(path) {
      return prepare(await readText(path, SkipFile));
    },
    async same(original, candidate) {
      let text: string;
      try {
        text = await readText(candidate, SkipFile);
      } catch (e) {
        return `the result is not valid UTF-8 text`;
      }
      return same(original as T, text);
    },
  };
}

// ---------------------------------------------------------------- JSON

const JSON_EXT = ["json", "geojson", "webmanifest", "jsonld", "gltf"];
export const json: Format = {
  id: "json",
  extensions: JSON_EXT,
  detect: (h, n) => JSON_EXT.includes(ext(n)) && /^[[{"\d\-tfn]/.test(headText(h).trimStart()),
  skip: async (path, _h, ctx) => (ctx.settings.web.js ? tiny(path) : "JSON minification is off (web.js)"),
  steps: [minify("web.json.minify", "json", ["--json-keep-numbers"])],
  oracle: textOracle(
    (t) => jsonTokens(t),
    (a, t) => {
      let b: string[];
      try {
        b = jsonTokens(t);
      } catch (e) {
        return `not valid JSON: ${errorMessage(e)}`;
      }
      return a.length === b.length && a.every((x, i) => x === b[i]) ? true : "JSON content differs";
    },
  ),
};

// ---------------------------------------------------------------- JavaScript

const JS_EXT = ["js", "mjs", "cjs"];
// tdewolff's JavaScript minifier rewrites code (`true` -> `!0`, `if` -> `&&`), which a token comparison cannot
// prove equal, so JavaScript uses the native whitespace/comment step only.
export const js: Format = {
  id: "js",
  extensions: JS_EXT,
  detect: (h, n) => JS_EXT.includes(ext(n)) && looksText(h),
  skip: async (path, _h, ctx) => (ctx.settings.web.js ? tiny(path) : "JavaScript minification is off (web.js)"),
  steps: [textStep("web.js.compact", compactJs)],
  oracle: textOracle(
    (t) => {
      tokenizeJs(t);
      return t;
    },
    (a, t) => sameJs(a, t),
  ),
};

// web.jsExtensions: more names for JavaScript. The engine asks each format for its form under the settings (`configure`).
// TypeScript and JSX are never handled, whatever the list says.
const NOT_JS = new Set(["ts", "tsx", "jsx", "mts", "cts"]);
js.configure = (settings) => {
  const extra = (settings.web.jsExtensions ?? []).map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter((e) => e && !NOT_JS.has(e) && !JS_EXT.includes(e));
  if (!extra.length) return js;
  const all = [...JS_EXT, ...extra];
  return { ...js, extensions: all, detect: (h, n) => all.includes(ext(n)) && looksText(h) };
};

// ---------------------------------------------------------------- CSS

export const css: Format = {
  id: "css",
  extensions: ["css"],
  detect: (h, n) => ext(n) === "css" && looksText(h),
  skip: async (path, _h, ctx) => (ctx.settings.web.css ? tiny(path) : "CSS minification is off (web.css)"),
  steps: [textStep("web.css.compact", compactCss), minify("web.css.minify", "css")],
  oracle: textOracle(
    (t) => {
      parseCss(t);
      return t;
    },
    (a, t) => sameCss(a, t),
  ),
};

// ---------------------------------------------------------------- HTML

export const html: Format = {
  id: "html",
  extensions: ["html", "htm"],
  detect: (h, n) => ["html", "htm"].includes(ext(n)) && looksText(h) && headText(h).includes("<"),
  async skip(path, _h, ctx) {
    if (!ctx.settings.web.html) return "HTML minification is off (web.html)";
    const small = await tiny(path);
    if (small) return small;
    const text = await Bun.file(path).text();
    return HTML_SENSITIVE.test(text) ? "white-space sensitive content (pre, textarea, white-space: pre...)" : null;
  },
  steps: [minify("web.html.minify", "html", ["--html-keep-conditional-comments", "--html-keep-special-comments", "--js-keep-var-names"])],
  oracle: {
    async prepare(path) {
      const t = await readText(path, SkipFile);
      if (/<!--(?![\s\S]*-->)/.test(t)) throw new Error("unterminated comment");
      return htmlEvents(t);
    },
    async same(original, candidate) {
      let t: string;
      try {
        t = await readText(candidate, SkipFile);
      } catch {
        return "the result is not valid UTF-8 text";
      }
      return sameHtml(original as Awaited<ReturnType<typeof htmlEvents>>, t);
    },
  },
};

// ---------------------------------------------------------------- XML family

const XML_EXT = ["xml", "xhtml", "xsl", "xslt", "kml", "smil", "fb2"];
function xmlPrepare(t: string) {
  const enc = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(t)?.[1];
  if (enc && !/^utf-?8$/i.test(enc)) throw new SkipFile(`encoding ${enc} is not verified`);
  try {
    checkXml(t);
  } catch (e) {
    if (e instanceof SafetyError) throw new SkipFile(`${e.message} (never expanded)`);
    throw e;
  }
  return xmlEvents(t, { svg: false });
}
export const xml: Format = {
  id: "xml",
  extensions: XML_EXT,
  detect: (h, n) => XML_EXT.includes(ext(n)) && startsWithTag(h) && !rootIsSvg(headText(h)),
  skip: async (path, _h, ctx) => (ctx.settings.web.html ? tiny(path) : "XML minification is off (web.html)"),
  steps: [minify("web.xml.minify", "xml")],
  oracle: textOracle(xmlPrepare, (a, t) => {
    try {
      checkXml(t);
      return sameEvents(a, xmlEvents(t, { svg: false }), { svg: false });
    } catch (e) {
      return `not well-formed XML: ${errorMessage(e)}`;
    }
  }),
};

export const formats: Format[] = [json, js, css, html, xml];
