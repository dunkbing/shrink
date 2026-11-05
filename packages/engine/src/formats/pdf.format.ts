import { renameSync } from "node:fs";
import { devNull } from "node:os";
import { toolStep } from "../step";
import { MissingTool } from "../tools";
import { SkipFile, type Context, type Format } from "../types";
import { summarize, type PdfSummary } from "./pdf-summary";

interface Doc {
  warned: boolean;
  pages: number;
  renders: string[];
  text: string;
  summary: PdfSummary;
}

const MAX_SIZE = 4 * 2 ** 30;

/** Does the file contain any of these byte strings? Streams the file in blocks. */
async function contains(path: string, needles: string[]): Promise<string | null> {
  const keep = Math.max(...needles.map((n) => n.length));
  let tail = "";
  const rd = Bun.file(path).stream().getReader();
  try {
    for (;;) {
      const { done, value } = await rd.read();
      if (done) return null;
      const s = tail + Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("latin1");
      for (const n of needles) if (s.includes(n)) return n;
      tail = s.slice(-keep);
    }
  } finally {
    rd.cancel().catch(() => {});
  }
}

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

async function tool(ctx: Context, name: string, args: string[]) {
  try {
    return await ctx.run(name, args);
  } catch (e) {
    if (e instanceof MissingTool) throw new SkipFile(`cannot verify: ${name} is not available`);
    throw e;
  }
}

/** `ref` is the original's check result: its warnings are tolerated (and then also in a candidate); a candidate of a clean file must be clean. */
async function read(path: string, ctx: Context, ref?: Doc): Promise<Doc> {
  const original = !ref;
  const check = await tool(ctx, "qpdf", ["--check", path]);
  const msg = check.stderr + check.stdout;
  if (check.code !== 0 && !(check.code === 3 && (original || ref?.warned) && !/damaged|reconstruct|recover|truncat|xref|end of file|EOF/i.test(msg)))
    throw new Error(`qpdf --check: ${msg.trim().split("\n").find((l) => /error|warning|damaged|WARNING/i.test(l)) ?? `exit ${check.code}: ${msg.trim().slice(0, 200)}`}`);
  const np = await tool(ctx, "qpdf", ["--show-npages", path]);
  const pages = parseInt(np.stdout.trim(), 10);
  if (!(pages >= 0)) throw new Error("no page count");

  const draw = await tool(ctx, "mutool", ["draw", "-r", "72", "-s", "5", "-F", "pam", "-o", devNull, path]);
  if (draw.code !== 0) throw new Error(`mutool cannot render it: ${draw.stderr.trim().split("\n").pop()}`);
  const renders: string[] = [];
  for (const m of draw.stderr.matchAll(/^page .* (\d+) ([0-9a-f]{32})\s*$/gm)) renders[+m[1] - 1] = m[2];
  if (pages > 0 && (renders.length !== pages || renders.some((r) => !r))) throw new Error("not every page rendered");

  const txt = await tool(ctx, "mutool", ["draw", "-F", "text", "-o", "-", path]);
  if (txt.code !== 0) throw new Error("mutool cannot extract the text");

  const js = await tool(ctx, "qpdf", ["--json=2", "--json-key=qpdf", path]);
  if (js.code !== 0 && js.code !== 3) throw new Error("qpdf cannot describe it");
  if (original && /"\/(ByteRange|DocMDP)"/.test(js.stdout)) throw new SkipFile("signed");
  return { warned: check.code === 3, pages, renders, text: sha(txt.stdout), summary: summarize(JSON.parse(js.stdout)) };
}

export const pdf: Format = {
  id: "pdf",
  extensions: ["pdf", "ai", "epdf", "fdf"],
  detect: (h) => Buffer.from(h.subarray(0, 1024)).includes("%PDF-"),
  flags: () => ({}),
  async skip(path, _head, ctx) {
    if (Bun.file(path).size > MAX_SIZE) return "too large to verify";
    const hit = await contains(path, ["/ByteRange", "/DocMDP", "pdfaid:part", "/GTS_PDFA1"]);
    if (hit === "/ByteRange" || hit === "/DocMDP") return "signed";
    if (hit) return "PDF/A";
    try {
      if ((await ctx.run("qpdf", ["--is-encrypted", path])).code === 0) return "encrypted";
    } catch {}
    return null;
  },
  steps: [
    {
      // mutool takes anything that does not end in .pdf for a page range, so it writes to a .pdf name first
      id: "pdf.mutool",
      tool: "mutool",
      async run(input, output, ctx) {
        const tmp = output + ".pdf";
        const r = await ctx.run("mutool", ["clean", "-gggg", "-z", "-f", "-i", "-m", "-e", ctx.level >= 7 ? "100" : "0", "--structure=keep", input, tmp]);
        if (r.code !== 0) throw new Error(`mutool exited with ${r.code}: ${r.stderr.trim().split("\n").pop()}`);
        renameSync(tmp, output);
      },
    },
    toolStep({
      id: "pdf.cpdf",
      tool: "cpdf",
      minLevel: 5,
      args: (input, output) => ["-i", input, "-squeeze", "-o", output],
    }),
    toolStep({
      id: "pdf.qpdf",
      tool: "qpdf",
      ok: [0, 3],
      args: (input, output) => ["--object-streams=generate", "--recompress-flate", "--compression-level=9", "--stream-data=compress", input, output],
    }),
  ],
  oracle: {
    async prepare(path, ctx) {
      return read(path, ctx);
    },
    async same(original, candidate, ctx) {
      const a = original as Doc;
      let b: Doc;
      try {
        b = await read(candidate, ctx, a);
      } catch (e: any) {
        if (e instanceof SkipFile) return String(e.message);
        return `the result is not a sound PDF: ${e?.message ?? e}`;
      }
      if (a.pages !== b.pages) return `page count ${a.pages} became ${b.pages}`;
      for (let i = 0; i < a.pages; i++) if (a.renders[i] !== b.renders[i]) return `page ${i + 1} renders differently`;
      if (a.text !== b.text) return "extracted text differs";
      for (const k of ["annots", "form", "outlines", "names", "labels", "layers", "fonts"] as const) if (a.summary[k] !== b.summary[k]) return `${k} differ`;
      return true;
    },
  },
};

export const formats: Format[] = [pdf];
