// HTML / CSS / JavaScript / JSON / XML cases (docs/FORMATS.md, section 10).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Engine } from "../src/optimize";
import { formats as webFormats } from "../src/formats/web.format";
import { compactCss, sameCss } from "../src/formats/web-css";
import { compactJs, sameJs } from "../src/formats/web-js";
import { env, type Env } from "./fake";
import { tamperedMinify } from "./lib/web";

const have = Bun.which("minify") !== null;
const t = have ? test : test.skip;
const on = { web: { html: true, css: true, js: true, svg: true } };
const envs: Env[] = [];
const make = (settings: object = on) => (envs.push(env({ formats: webFormats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const text = (p: string) => readFileSync(p, "utf8");
async function run(name: string, src: string | Uint8Array, settings: object = on) {
  const e = make(settings);
  const p = await e.file(name, src);
  const r = await e.engine.optimizeFile(p);
  if (process.env.DBG) console.log(name, JSON.stringify(r.steps), r.reason);
  return { r, out: readFileSync(p), p, e, src };
}

// ------------------------------------------------------------------ HTML

const page = (body: string, head = "") => `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Test   page</title>\n  ${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

t("WEB-01: HTML comments and layout white space go, the document stays the same", async () => {
  const { r, out } = await run("a.html", page(`  <!-- gone -->\n  <div class="a  b">\n    <p>Hello   <b>big</b> <i>world</i></p>\n    <input type="checkbox" disabled="disabled">\n  </div>\n  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>`));
  expect(r.status).toBe("optimized");
  const s = out.toString();
  expect(s).not.toContain("gone");
  expect(s).toContain("<b>big</b> <i>world</i>");
});

t("WEB-02: a page with <pre> is left byte-exact", async () => {
  const src = page(`<!-- c -->\n<pre>\n  keep   this\n    layout\n</pre>`);
  const { r, out } = await run("a.html", src);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("white-space");
  expect(out.toString()).toBe(src);
});

t("WEB-03: inline <script> and <style> are handled and still mean the same", async () => {
  const { r, out } = await run("a.html", page(`<p id=x>hi</p>\n<script>\n  // note\n  var a = 1;\n  function f( x ) { return x + a ; }\n</script>`, `<style>\n  p   { color : #ff0000 ;  margin : 0px }\n</style>`));
  expect(r.status).toBe("optimized");
  expect(out.toString()).not.toContain("// note");
});

t("WEB-04: conditional comments are kept", async () => {
  const { out } = await run("a.html", page(`<!-- plain -->\n<p>x</p>`, `<!--[if lt IE 9]>\n  <script src="html5shiv.js"></script>\n<![endif]-->`));
  expect(out.toString()).toContain("[if lt IE 9]");
});

t("WEB-09 (HTML): a binary file with an .html name is left alone", async () => {
  const bytes = new Uint8Array([0x3c, 0x68, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  const { r, out } = await run("a.html", bytes);
  expect(["skipped", "unchanged"]).toContain(r.status);
  expect(Buffer.from(out)).toEqual(Buffer.from(bytes));
});

t("COMMON-08 (HTML): a tool that changes a word or an attribute is rejected", async () => {
  const e = make();
  const src = page(`<!-- c -->\n<p class="a">Hello world</p>\n<a href="/x">link</a>`);
  const p = await e.file("a.html", src);
  for (const [label, edit] of [["text", 't => t.replace("Hello world", "Hello there")'], ["attribute", 't => t.replace("/x", "/y")']]) {
    const bad = await tamperedMinify(e.dir, `bad-${label}`, "html", edit);
    const liar = new Engine({ formats: webFormats, cacheDir: e.dir + "/c-" + label, tempDir: e.dir + "/tmp", settings: { ...on, toolPaths: { minify: bad } } });
    const r = await liar.optimizeFile(p);
    expect(r.steps[0].outcome, label).toBe("rejected");
    expect(text(p)).toBe(src);
  }
});

// ------------------------------------------------------------------ CSS

const css = `/* header */
:root { --gap : 4px ; --empty:; }
a  >  b , c ~ d {
  margin : 0px  0.50em ;
  width : calc( 100% - (2 * var(--gap)) ) ;
  color : #FFFFFF !important ;
  content : "a  ;  b" ;
  background : url( "x y.png" ) ;
}
@media (min-width : 600px) and (max-width:900px) {
  .x:not( .y ) { padding : 1px 2px }
}
@import url(foo.css) screen;
a[href = "x"] , a :hover { top : 0 }
`;

test("WEB-05: calc() spacing, @media, !important, custom properties and strings survive compaction", () => {
  const out = compactCss(css);
  expect(out.length).toBeLessThan(css.length * 0.8);
  expect(out).toContain("calc(100% - (2 * var(--gap)))");
  expect(out).toContain("!important");
  expect(out).toContain("--gap:4px");
  expect(out).toContain('"a  ;  b"');
  expect(out).toContain("@media (min-width:600px) and (max-width:900px){");
  expect(out).toContain("a :hover"); // a descendant :hover is not a.hover
  expect(sameCss(css, out)).toBe(true);
});

test("CSS oracle: any change to a selector, value, property or nesting is seen", () => {
  const base = "a{color:red;margin:0 1px}@media (min-width:1px){b{top:0}}";
  expect(sameCss(base, "a { color : red ; margin : 0 1px }  @media (min-width:1px) { b { top : 0 } }")).toBe(true);
  for (const bad of ["a{color:blue;margin:0 1px}@media (min-width:1px){b{top:0}}", "a{color:red;margin:0 2px}@media (min-width:1px){b{top:0}}", "a b{color:red;margin:0 1px}@media (min-width:1px){b{top:0}}", "a{color:red;margin:0 1px}@media (min-width:2px){b{top:0}}", "a{margin:0 1px;color:red}@media (min-width:1px){b{top:0}}", "a{color:red;margin:0 1px}b{top:0}"]) expect(sameCss(base, bad)).not.toBe(true);
  expect(sameCss("a b{x:y}", "a{x:y}b{x:y}")).not.toBe(true);
  expect(sameCss("a{content:'a  b'}", "a{content:'a b'}")).not.toBe(true);
});

t("WEB-05 (engine): a stylesheet shrinks and is verified", async () => {
  const { r, out } = await run("a.css", css);
  expect(r.status).toBe("optimized");
  expect(out.toString()).toContain("calc(100% - (2 * var(--gap)))");
});

// ------------------------------------------------------------------ JavaScript

/** Runs code in a clean function and returns what it returns, so compaction can be checked by behaviour. */
const exec = (code: string) => new Function(code)();

const jsHazards = `
// ASI hazards
var a = 1
var b = 2
var c = a
+ b
var d = a
++b
var e = (function () { return 1 })
var f = [1, 2, 3].length
function g() {
  return
  42
}
var i = 10, j = 2, k = 5
var div = i / j / k
var re = /ab+c/gi.test("xabbc") ? "yes" : "no"
var cls = /[/]x/.test("/x")
var tpl = \`a\${ i }b\${ \`n\${ j }\` }c\`
var s = 'it\\'s' + "say \\"hi\\""
var inc = a
+ +b
var neg = a - -b
var obj = { x: 1, "y z": 2 }
var arrow = x => x * 2
"use strict"
return [a, b, c, d, e(), f, g(), div, re, cls, tpl, s, inc, neg, obj.x, obj["y z"], arrow(4), k].join("|")
`;

test("WEB-06: JavaScript compaction keeps behaviour (ASI hazards, regex vs division, templates, strings)", () => {
  const out = compactJs(jsHazards);
  expect(out.length).toBeLessThan(jsHazards.length);
  expect(exec(out)).toBe(exec(jsHazards));
  expect(sameJs(jsHazards, out)).toBe(true);
});

test("JS oracle: joining lines that rely on ASI, or changing a token, is seen", () => {
  expect(sameJs("var a = 1\nvar b = 2", "var a=1\nvar b=2")).toBe(true);
  expect(sameJs("var a = 1\nvar b = 2", "var a=1;var b=2")).toBe(true);
  expect(sameJs("var a = 1\nvar b = 2", "var a=1 var b=2")).not.toBe(true);
  expect(sameJs("a\n++b", "a++b")).not.toBe(true);
  expect(sameJs("x = y\n(z)", "x=y(z)")).not.toBe(true); // no ASI happens here, but the check is conservative
  expect(sameJs("function f(){return\n1}", "function f(){return 1}")).not.toBe(true);
  expect(sameJs("function f(){return 1}", "function f(){return\n1}")).not.toBe(true);
  expect(sameJs("a = b / c / d", "a = b / c / e")).not.toBe(true);
  expect(sameJs("a = 'x'", 'a = "x"')).toBe(true);
  expect(sameJs("a = 'x'", 'a = "y"')).not.toBe(true);
  expect(sameJs("a = 'it\\'s'", 'a = "it\'s"')).toBe(true);
  expect(sameJs("a = `x${b}y`", "a = `x${c}y`")).not.toBe(true);
  expect(sameJs("a = /x/g", "a = /x/i")).not.toBe(true);
  expect(sameJs("f(a, b)", "f(b, a)")).not.toBe(true);
  expect(sameJs("if (a) { b() }", "if (a) { b(); }")).toBe(true);
  expect(sameJs("var a = 'unterminated", "var a = 1")).not.toBe(true);
});

t("WEB-06 (engine): a script shrinks, runs the same and passes the token check", async () => {
  const { r, out } = await run("a.js", jsHazards.replace("return [", "var __r = [").replace(".join(\"|\")", ".join(\"|\")\nmodule_result = __r"));
  expect(r.status).toBe("optimized");
  expect(out.toString().length).toBeLessThan(r.before);
});

// ------------------------------------------------------------------ JSON

t("WEB-07: JSON keeps big numbers, -0, exponents and duplicate keys spelled as they were", async () => {
  const src = `{\n  "big": 12345678901234567890123,\n  "negzero": -0,\n  "exp": 1E+5,\n  "frac": 1.50,\n  "dup": 1,\n  "dup": 2,\n  "arr": [ 1 , 2.0 , 3e-2 ],\n  "s": "a  b \\u0041 \\/"\n}\n`;
  const { r, out } = await run("a.json", src);
  expect(r.status).toBe("optimized");
  const s = out.toString();
  for (const needle of ["12345678901234567890123", "-0", "1E+5", "1.50", '"dup":1,"dup":2', "2.0", "3e-2", "a  b \\u0041 \\/"]) expect(s).toContain(needle);
});

t("WEB-07 (tampered): a tool that rewrites a number is rejected", async () => {
  const e = make();
  const src = `{\n  "a": 1.50,\n  "b": [1, 2, 3]\n}\n`;
  const p = await e.file("a.json", src);
  const bad = await tamperedMinify(e.dir, "bad-json", "json", 't => t.replace("1.50", "1.5")', "--json-keep-numbers");
  const liar = new Engine({ formats: webFormats, cacheDir: e.dir + "/c2", tempDir: e.dir + "/tmp", settings: { ...on, toolPaths: { minify: bad } } });
  const r = await liar.optimizeFile(p);
  expect(r.steps[0].outcome).toBe("rejected");
  expect(text(p)).toBe(src);
});

// ------------------------------------------------------------------ XML

t("XML family: comments and layout white space go, text and attributes stay", async () => {
  const src = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- a comment -->\n<root xmlns:x="urn:x">\n  <item  id="1"   x:k='v'>  some   text  </item>\n  <item id="2"><![CDATA[a < b]]></item>\n  <empty />\n</root>\n`;
  const { r, out } = await run("a.xml", src);
  expect(r.status === "optimized" || r.status === "unchanged").toBe(true);
  if (r.status === "optimized") expect(out.toString()).not.toContain("a comment");
});

t("WEB-11: an XML file with entity declarations (billion laughs) is rejected, never expanded", async () => {
  const lol = `<?xml version="1.0"?>\n<!DOCTYPE lolz [ <!ENTITY lol "lol"> <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"> <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"> <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;"> <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;"> <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;"> <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;"> <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;"> ]>\n<lolz>&lol8;</lolz>\n`;
  const t0 = performance.now();
  const { r, out } = await run("lol.xml", lol);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("entities");
  expect(performance.now() - t0).toBeLessThan(5000);
  expect(out.toString()).toBe(lol);
});

// ------------------------------------------------------------------ shared cases

test("WEB-08: a BOM and CRLF line ends are handled", () => {
  const src = "﻿.a {\r\n  color : red ;\r\n}\r\n/* c */\r\n.b { top : 0 }\r\n";
  const out = compactCss(src);
  expect(out).toBe(".a{color:red}.b{top:0}");
  expect(sameCss(src, out)).toBe(true);
  const js = "﻿var a = 1;\r\nvar b = 2\r\nvar c = a\r\n+ b\r\n";
  expect(sameJs(js, compactJs(js))).toBe(true);
  expect(exec(compactJs(js + "return c"))).toBe(3);
});

t("WEB-08 (engine): a JSON file with a BOM and CRLF is minified", async () => {
  const { r, out } = await run("a.json", '﻿{\r\n  "a": [1, 2],\r\n  "b": null\r\n}\r\n');
  expect(r.status).toBe("optimized");
  expect(JSON.parse(out.toString().replace(/^﻿/, ""))).toEqual({ a: [1, 2], b: null });
});

t("WEB-09: invalid input is left untouched", async () => {
  const bad: [string, string][] = [
    ["a.json", `{ "a": 1, }`],
    ["b.json", `{ "a": [1, 2 }`],
    ["a.css", `a { color: red; `],
    ["b.css", `a { content: "open }`],
    ["a.js", `var a = "open;\nvar b = 2;`],
    ["b.js", `function f( { return 1 }`.padEnd(40) + "`unterminated"],
    ["a.xml", `<a><b></a>`.padEnd(30, " ")],
  ];
  for (const [name, src] of bad) {
    const { r, out } = await run(name, src);
    expect(r.status, name).toBe("skipped");
    expect(out.toString(), name).toBe(src);
  }
});

test("WEB-10: with the settings off nothing is touched", async () => {
  const files: [string, string][] = [["a.css", css], ["a.js", jsHazards], ["a.json", '{ "a" : 1,\n  "b" : [1, 2, 3] }\n'], ["a.html", page("<p>x</p>")], ["a.xml", "<a>\n  <b/>\n</a>\n"]];
  for (const [name, src] of files) {
    const { r, out } = await run(name, src, {});
    expect(r.status, name).toBe("skipped");
    expect(r.reason, name).toContain("off");
    expect(out.toString(), name).toBe(src);
  }
});

t("COMMON (web): empty and tiny files, idempotence, never larger", async () => {
  for (const [name, content] of [["e.css", ""], ["t.js", "a"], ["t.json", "{}"], ["t.html", "<p>"]]) {
    const { r } = await run(name, content);
    expect(r.status, name).toBe("skipped");
  }
  const e = make();
  const p = await e.file("a.css", css);
  const r1 = await e.engine.optimizeFile(p);
  const once = readFileSync(p);
  const r2 = await e.engine.optimizeFile(p);
  expect(r1.after).toBeLessThanOrEqual(r1.before);
  expect(r2.status).not.toBe("optimized");
  expect(readFileSync(p)).toEqual(once);
});

t("COMMON-07 (web): content that is not the format its extension claims is skipped", async () => {
  const { allFormats } = await import("../src/formats");
  const e = env({ formats: allFormats, settings: on });
  envs.push(e);
  const a = await e.engine.optimizeFile(await e.file("a.json", "\x00\x01\x02 not json at all .........."));
  expect(a.status).toBe("skipped");
  const b = await e.engine.optimizeFile(await e.file("data.png", '{ "a" : 1 }\n'));
  expect(b.status).toBe("skipped");
});

test("COMMON-10 (web): without minify, the native steps still run and the rest are skipped", async () => {
  const e = make({ ...on, disabledTools: ["minify"] });
  const p = await e.file("a.css", css);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.steps.find((s) => s.id === "web.css.minify")?.outcome).toBe("skipped");
  const q = await e.file("a.json", '{ "a" : 1,\n  "b" : 2 }\n');
  expect((await e.engine.optimizeFile(q)).status).toBe("unchanged");
});
