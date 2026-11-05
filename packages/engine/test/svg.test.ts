// SVG / SVGZ cases (docs/FORMATS.md, section 8) with the real minify and resvg.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { Engine } from "../src/optimize";
import { formats as svgFormats } from "../src/formats/svg.format";
import { sameEvents, xmlEvents } from "../src/formats/web-markup";
import { env, type Env } from "./fake";
import { fakeTool, inkscapeSvg } from "./lib/web";

const have = Bun.which("minify") !== null && Bun.which("resvg") !== null;
const t = have ? test : test.skip;
const envs: Env[] = [];
const make = (settings = {}) => (envs.push(env({ formats: svgFormats, settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));
const text = (p: string) => readFileSync(p, "utf8");

t("SVG-01: Inkscape output with metadata shrinks a lot and keeps its structure", async () => {
  const e = make();
  const src = inkscapeSvg(40);
  const p = await e.file("a.svg", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before * 0.75);
  const out = text(p);
  expect(out).not.toContain("sodipodi");
  expect(out).not.toContain("metadata");
  expect(sameEvents(xmlEvents(src, { svg: true }), xmlEvents(out, { svg: true }), { svg: true })).toBe(true);
});

t("SVG-02: <style> rules and ids referenced by use and url(#x) still resolve", async () => {
  const e = make();
  const src = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="60" viewBox="0 0 120 60">
  <!-- shapes -->
  <style type="text/css">
    .a { fill : #ff0000 ; stroke : black }
    #c2 { fill : url( #g ) }
  </style>
  <defs>
    <linearGradient id="g" x1="0" x2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#0000ff"/></linearGradient>
    <circle id="dot" cx="10" cy="10" r="8" class="a"/>
  </defs>
  <use xlink:href="#dot" x="0"/>
  <use xlink:href="#dot" x="30"/>
  <circle id="c2" cx="90" cy="30" r="20"/>
</svg>
`;
  const p = await e.file("a.svg", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = text(p);
  expect(out).toContain('id="dot"');
  expect(out).toMatch(/href="#dot"/);
  expect(out).toContain('id="g"');
  expect(out).toMatch(/url\(\s*#g\s*\)/);
});

t("SVG-03: an embedded base64 image is kept byte for byte", async () => {
  const e = make();
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const src = `<?xml version="1.0"?>\n<!-- a picture -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40">\n  <image x="0" y="0" width="40" height="40" xlink:href="data:image/png;base64,${b64}"/>\n</svg>\n`;
  const p = await e.file("a.svg", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(text(p)).toContain(b64);
});

t("SVG-04: text whose spaces would be lost is left alone", async () => {
  const e = make();
  const src = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50">\n  <!-- c -->\n  <text x="5" y="30">Hello <tspan font-weight="bold">big</tspan> world</text>\n</svg>\n`;
  const p = await e.file("a.svg", src);
  const r = await e.engine.optimizeFile(p);
  const out = text(p);
  // either left untouched, or the spaces around the tspan survived
  if (r.status === "unchanged") expect(out).toBe(src);
  else expect(out).toMatch(/Hello <tspan[^>]*>big<\/tspan> world/);
});

t("SVG-05: xml:space=\"preserve\" is respected", async () => {
  const e = make();
  const src = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50">\n  <!-- c -->\n  <text x="5" y="30" xml:space="preserve">a    b   c</text>\n</svg>\n`;
  const p = await e.file("a.svg", src);
  await e.engine.optimizeFile(p);
  expect(text(p)).toContain("a    b   c");
});

t("SVG-06: SVGZ is unpacked, optimised and packed again", async () => {
  const e = make();
  const src = inkscapeSvg(40);
  const p = await e.file("a.svgz", gzipSync(src, { level: 1 }));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const bytes = readFileSync(p);
  expect(bytes[0]).toBe(0x1f);
  const out = gunzipSync(bytes).toString("utf8");
  expect(out.startsWith("<svg")).toBe(true);
  expect(sameEvents(xmlEvents(src, { svg: true }), xmlEvents(out, { svg: true }), { svg: true })).toBe(true);
  // packed again at the best level: a second run finds nothing
  const r2 = await e.engine.optimizeFile(p);
  expect(r2.status).not.toBe("optimized");
});

t("SVG-07: malformed XML is left untouched", async () => {
  const e = make();
  for (const [name, src] of [["a.svg", `<svg xmlns="http://www.w3.org/2000/svg"><g><rect/></svg>`], ["b.svg", inkscapeSvg(10).slice(0, 700)], ["c.svg", `<svg xmlns="http://www.w3.org/2000/svg">\n<a b=1/></svg>                  `]]) {
    const p = await e.file(name, src);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(text(p)).toBe(src);
  }
});

t("SVG-08: DOCTYPE entities, internal or external, are never loaded or expanded", async () => {
  const e = make();
  const external = `<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40">\n  <!-- c -->\n  <text x="1" y="20">&xxe;</text>\n</svg>\n`;
  const lol = `<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY a "aaaaaaaaaa"> <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"> <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"> <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"> <!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"> <!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;"> <!ENTITY g "&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;"> <!ENTITY h "&g;&g;&g;&g;&g;&g;&g;&g;&g;&g;"> <!ENTITY i "&h;&h;&h;&h;&h;&h;&h;&h;&h;&h;"> ]>\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><!-- c --><text x="1" y="20">&i;</text></svg>\n`;
  for (const [name, src] of [["x.svg", external], ["lol.svg", lol]]) {
    const p = await e.file(name, src);
    const t0 = performance.now();
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("entities");
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(text(p)).toBe(src);
  }
});

t("COMMON-08 (SVG): a tool that changes a colour or a path is rejected, the file is untouched", async () => {
  const e = make();
  const src = inkscapeSvg(20);
  const p = await e.file("a.svg", src);
  for (const [label, edit, expectDetail] of [
    ["colour", "s/fill:red/fill:lime/g", "rendered"],
    ["path", "s/M10 10/M12 10/", "rendered"],
    ["attribute", "s/<rect/<rect data-x=\"1\"/", "differ"],
  ] as const) {
    const bad = await fakeTool(e.dir, `bad-${label}`, `minify --type svg -o "$OUT" "$IN" && sed '${edit}' "$OUT" > "$OUT.x" && mv "$OUT.x" "$OUT"`);
    const liar = new Engine({ formats: svgFormats, cacheDir: e.dir + "/cache-" + label, tempDir: e.dir + "/tmp", settings: { toolPaths: { minify: bad } } });
    const r = await liar.optimizeFile(p);
    expect(r.steps[0].outcome, label).toBe("rejected");
    expect(r.steps[0].detail, label).toContain(expectDetail);
    expect(text(p)).toBe(src);
  }
});

t("COMMON (SVG): never larger, idempotent, tiny and empty files, wrong extension", async () => {
  const e = make();
  const p = await e.file("a.svg", inkscapeSvg(10));
  const r1 = await e.engine.optimizeFile(p);
  const bytes = readFileSync(p);
  const r2 = await e.engine.optimizeFile(p);
  expect(r1.after).toBeLessThanOrEqual(r1.before);
  expect(r2.status).not.toBe("optimized");
  expect(readFileSync(p)).toEqual(bytes);
  for (const n of [0, 1, 16]) {
    const q = await e.file(`tiny${n}.svg`, "<".repeat(n));
    expect((await e.engine.optimizeFile(q)).status).toBe("skipped");
  }
  const { allFormats } = await import("../src/formats");
  const all = env({ formats: allFormats });
  envs.push(all);
  const wrong = await all.file("pic.png", inkscapeSvg(5));
  const rw = await all.engine.optimizeFile(wrong);
  expect(rw.status).toBe("skipped");
  expect(rw.reason).toContain("extension");
});

t("web.svg off: SVG is left untouched", async () => {
  const e = make({ web: { svg: false } });
  const p = await e.file("a.svg", inkscapeSvg(10));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("off");
});

t("COMMON-10 (SVG): a missing minify skips the step, nothing breaks", async () => {
  const e = make({ disabledTools: ["minify"] });
  const src = inkscapeSvg(10);
  const p = await e.file("a.svg", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(r.steps[0].outcome).toBe("skipped");
  expect(text(p)).toBe(src);
});

t("SVG: a missing renderer means no verification, so the file is skipped", async () => {
  const e = make({ disabledTools: ["resvg", "rsvg-convert"] });
  const p = await e.file("a.svg", inkscapeSvg(10));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("cannot verify");
});
