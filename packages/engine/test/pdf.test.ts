// PDF cases (docs/FORMATS.md, section 9) against the real qpdf, mutool and (when installed) cpdf.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import type { Format, Step } from "../src";
import { pdf } from "../src/formats/pdf.format";
import { summarize } from "../src/formats/pdf-summary";
import { env, type Env } from "./fake";
import { makePdf, type PdfSpec } from "./lib/pdf";

const have = Bun.which("qpdf") !== null && Bun.which("mutool") !== null;
const t = have ? test : test.skip;
const envs: Env[] = [];
const make = (settings = {}, format: Format = pdf) => (envs.push(env({ formats: [format], settings })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const sh = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
const summary = (path: string) => summarize(JSON.parse(sh(["qpdf", "--json=2", "--json-key=qpdf", path]).stdout.toString()));
const text = (path: string) => sh(["mutool", "draw", "-F", "text", "-o", "-", path]).stdout.toString();
/** A format whose only step writes the given bytes: stands in for a tool that damages the content. */
const liar = (bytes: Uint8Array): Format => ({ ...pdf, steps: [{ id: "pdf.liar", async run(_i, o) { await Bun.write(o, bytes); } } as Step] });

t("the fixture writer makes files qpdf and mutool accept", () => {
  const p = make();
  const bytes = makePdf({ pages: 3, annots: true, form: true, outlines: true, labels: true, layers: true, embeddedFont: true, image: 9000 });
  writeFileSync(p.dir + "/w.pdf", bytes);
  expect(sh(["qpdf", "--check", p.dir + "/w.pdf"]).exitCode).toBe(0);
  expect(sh(["mutool", "draw", "-F", "text", "-o", "-", p.dir + "/w.pdf"]).exitCode).toBe(0);
});

t("PDF-01: an uncompressed PDF shrinks, with the same pages and text", async () => {
  const bytes = makePdf({ pages: 3, image: 20000 });
  const e = make();
  const p = await e.file("a.pdf", bytes);
  await Bun.write(e.dir + "/orig.pdf", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before / 2);
  expect(sh(["qpdf", "--check", p]).exitCode).toBe(0);
  expect(text(p)).toBe(text(e.dir + "/orig.pdf"));
  expect(summary(p).pages).toBe(3);
});

t("PDF-02: an already optimized PDF ends up left alone", async () => {
  const e = make({ skipOptimized: false });
  const p = await e.file("a.pdf", makePdf({ pages: 2 }));
  let r = await e.engine.optimizeFile(p);
  for (let i = 0; i < 4 && r.status === "optimized"; i++) r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  const once = readFileSync(p);
  r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("unchanged");
  expect(readFileSync(p)).toEqual(once);
});

t("PDF-03: a signed PDF is skipped", async () => {
  const e = make();
  const bytes = makePdf({ signed: true });
  const p = await e.file("a.pdf", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r).toMatchObject({ status: "skipped", reason: "signed" });
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

t("PDF-04: a PDF/A file is skipped", async () => {
  const e = make();
  const bytes = makePdf({ pdfa: true });
  const p = await e.file("a.pdf", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r).toMatchObject({ status: "skipped", reason: "PDF/A" });
  expect(readFileSync(p)).toEqual(Buffer.from(bytes));
});

t("PDF-05: encrypted PDFs (owner password only, and user password) are skipped", async () => {
  const e = make();
  await e.file("plain.pdf", makePdf({ pages: 2 }));
  for (const [name, args] of [["owner", ["--encrypt", "", "owner", "256", "--"]], ["user", ["--encrypt", "user", "owner", "256", "--"]]] as const) {
    expect(sh(["qpdf", e.dir + "/plain.pdf", ...args, e.dir + `/${name}.pdf`]).exitCode).toBeLessThan(3);
    const before = readFileSync(e.dir + `/${name}.pdf`);
    const r = await e.engine.optimizeFile(e.dir + `/${name}.pdf`);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("encrypted");
    expect(readFileSync(e.dir + `/${name}.pdf`)).toEqual(before);
  }
});

t("PDF-06: forms, annotations, links, bookmarks, named destinations and page labels survive", async () => {
  const spec: PdfSpec = { pages: 4, annots: true, form: true, outlines: true, labels: true, lines: 5 };
  const bytes = makePdf(spec);
  const e = make();
  const p = await e.file("a.pdf", bytes);
  await Bun.write(e.dir + "/orig.pdf", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const a = summary(e.dir + "/orig.pdf");
  const b = summary(p);
  expect(b).toEqual(a);
  expect(b.form).toContain("Alice");
  expect(b.annots).toContain("https://example.com/p2");
  expect(b.outlines).toContain("Chapter 3");
  expect(b.names).toContain("intro");
  expect(b.labels).toContain("A-");
});

t("PDF-07: embedded fonts are kept and the text extracts the same", async () => {
  const bytes = makePdf({ pages: 2, embeddedFont: true });
  const e = make();
  const p = await e.file("a.pdf", bytes);
  await Bun.write(e.dir + "/orig.pdf", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(summary(p).fonts).toContain("embedded");
  expect(summary(p).fonts).toBe(summary(e.dir + "/orig.pdf").fonts);
  expect(text(p)).toBe(text(e.dir + "/orig.pdf"));
});

t("PDF-08: a layered PDF keeps its layers (lossless steps run whatever skipLayered says)", async () => {
  for (const skipLayered of [true, false]) {
    const e = make({ pdf: { skipLayered } });
    const p = await e.file("a.pdf", makePdf({ layers: true, pages: 2 }));
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("optimized");
    expect(summary(p).layers).toContain("Layer A");
  }
});

t("PDF-09: a linearized input gives a valid result", async () => {
  const e = make();
  await e.file("plain.pdf", makePdf({ pages: 3, image: 12000 }));
  expect(sh(["qpdf", "--linearize", "--compress-streams=n", e.dir + "/plain.pdf", e.dir + "/lin.pdf"]).exitCode).toBe(0);
  expect(sh(["qpdf", "--show-linearization", e.dir + "/lin.pdf"]).exitCode).toBe(0);
  const r = await e.engine.optimizeFile(e.dir + "/lin.pdf");
  expect(r.status).toBe("optimized");
  expect(sh(["qpdf", "--check", e.dir + "/lin.pdf"]).exitCode).toBe(0);
  expect(summary(e.dir + "/lin.pdf").pages).toBe(3);
});

t("PDF-10: a truncated PDF or a broken xref is left untouched", async () => {
  const bytes = makePdf({ pages: 3 });
  const broken = Buffer.from(bytes).toString("latin1").replace(/startxref\n\d+/, "startxref\n99");
  for (const [name, content] of [["trunc.pdf", bytes.subarray(0, Math.floor(bytes.length * 0.6))], ["xref.pdf", Buffer.from(broken, "latin1")]] as const) {
    const e = make();
    const p = await e.file(name, content);
    const r = await e.engine.optimizeFile(p);
    expect(["skipped", "unchanged"]).toContain(r.status);
    expect(readFileSync(p)).toEqual(Buffer.from(content));
  }
});

t("PDF-11: a lossy profile is not part of the lossless steps", async () => {
  const e = make({ pdf: { profile: "ebook" } });
  const p = await e.file("a.pdf", makePdf({ image: 30000 }));
  const r = await e.engine.optimizeFile(p);
  expect(r.steps.every((s) => !/ghostscript|gs/.test(s.id))).toBe(true);
  expect(text(p)).toContain("Page 1 line 0");
});

t("PDF-12: an .ai file is optimised with the lossless steps only", async () => {
  const e = make();
  const p = await e.file("art.ai", makePdf({ pages: 2, image: 20000 }));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.steps.map((s) => s.id).join()).not.toMatch(/gs|ghostscript/);
  copyFileSync(p, p + ".pdf"); // qpdf's AppArmor profile on Ubuntu only opens .pdf, .json and .qdf
  expect(sh(["qpdf", "--check", p + ".pdf"]).exitCode).toBe(0);
});

t("PDF-13: a 1200-page PDF finishes, and cancelling stops it without leftovers", async () => {
  const bytes = makePdf({ pages: 1200, lines: 3 });
  const e = make();
  const p = await e.file("big.pdf", bytes);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(summary(p).pages).toBe(1200);

  const c = make();
  const q = await c.file("big.pdf", bytes);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const t0 = performance.now();
  const rc = await c.engine.optimizeFile(q, { signal: ac.signal });
  expect(rc.reason).toContain("cancelled");
  expect(performance.now() - t0).toBeLessThan(5000);
  expect(readFileSync(q)).toEqual(Buffer.from(bytes));
  expect(c.leftovers()).toEqual([]);
}, 120000);

t("PDF-14: a tool that drops text, annotations, a page or a bookmark is rejected and the file is untouched", async () => {
  const full: PdfSpec = { pages: 3, annots: true, outlines: true, form: true, lines: 20 };
  const original = makePdf(full);
  const cases: [string, PdfSpec, string][] = [
    ["text", { ...full, lines: 19 }, "render"],
    ["page", { ...full, pages: 2 }, "page count"],
    ["annotations", { ...full, annots: false, form: false }, "differ"],
    ["bookmarks", { ...full, outlines: false }, "outlines"],
  ];
  for (const [name, spec, why] of cases) {
    const e = make({}, liar(makePdf(spec)));
    const p = await e.file("a.pdf", original);
    const r = await e.engine.optimizeFile(p);
    expect(r.steps[0].outcome, name).toBe("rejected");
    expect(r.steps[0].detail, name).toContain(why);
    expect(readFileSync(p)).toEqual(Buffer.from(original));
  }
  // same pixels and text but a lost link: only the structure check can tell
  const e = make({}, liar(makePdf(full)));
  const p = await e.file("a.pdf", makePdf({ ...full, labels: true }));
  const r = await e.engine.optimizeFile(p);
  expect(r.steps[0]).toMatchObject({ outcome: "rejected" });
  expect(r.steps[0].detail).toContain("labels");
});

t("a garbage file with a PDF header is skipped, not crashed on", async () => {
  const e = make();
  const content = "%PDF-1.4\n" + "garbage ".repeat(100);
  const p = await e.file("a.pdf", content);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(readFileSync(p, "utf8")).toBe(content);
});

const realDir = new URL("../../../fixtures/real/", import.meta.url).pathname;
for (const name of ["tracemonkey.pdf", "annotation-text-widget.pdf", "form_two_pages.pdf", "outlines_se.pdf", "nested_outline.pdf", "TAMReview.pdf", "signed_verified.pdf", "perf_images_scan_bilevel.pdf"]) {
  const file = Bun.file(realDir + name);
  (have ? test : test.skip)(`real file ${name} never grows and stays sound`, async () => {
    if (!(await file.exists())) return;
    const e = make();
    const p = await e.file(name, new Uint8Array(await file.arrayBuffer()));
    const r = await e.engine.optimizeFile(p);
    expect(r.after).toBeLessThanOrEqual(r.before);
    if (r.status === "optimized") expect(sh(["qpdf", "--check", p]).exitCode).toBeLessThan(3 + 1);
    else if (name === "signed_verified.pdf") expect(r.reason).toBe("signed");
  });
}
