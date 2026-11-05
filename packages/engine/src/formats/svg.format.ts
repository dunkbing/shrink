// SVG and SVGZ (docs/FORMATS.md section 8). Oracle: the XML structure (editor data aside) and a rendered-pixel compare.
import { gunzipSync, gzipSync, constants } from "node:zlib";
import { join } from "node:path";
import { toolStep } from "../step";
import { SkipFile, type Context, type Format, type Oracle, type Step } from "../types";
import { checkXml, headText, MAX_TEXT, readText, rootIsSvg, SafetyError, sameEvents, xmlEvents, type Ev } from "./web-markup";
import { errorMessage } from "../errors";

const decoder = new TextDecoder("utf-8", { fatal: true });
let counter = 0;

interface Prepared {
  events: Ev[];
  png: Uint8Array;
}

/** Renders with resvg (or rsvg-convert) at 2x; the PNG bytes are the picture. */
async function render(svgPath: string, ctx: Context): Promise<Uint8Array> {
  const out = join(ctx.dir, `render${++counter}.png`);
  if (await ctx.tools.locate("resvg")) await ctx.run("resvg", ["--zoom", "2", svgPath, out]);
  else if (await ctx.tools.locate("rsvg-convert")) await ctx.run("rsvg-convert", ["--zoom", "2", "-o", out, svgPath]);
  else throw new SkipFile("cannot verify: no SVG renderer (resvg) installed");
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

async function prepareText(text: string, ctx: Context): Promise<Prepared> {
  const enc = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
  if (enc && !/^utf-?8$/i.test(enc)) throw new SkipFile(`encoding ${enc} is not verified`);
  try {
    checkXml(text);
  } catch (e) {
    if (e instanceof SafetyError) throw new SkipFile(`${e.message} (never expanded)`);
    throw e;
  }
  const events = xmlEvents(text, { svg: true });
  const file = join(ctx.dir, `orig${++counter}.svg`);
  await Bun.write(file, text);
  let png: Uint8Array;
  try {
    png = await render(file, ctx);
  } catch (e) {
    if (e instanceof SkipFile) throw e;
    throw new SkipFile(`cannot render to verify: ${errorMessage(e).slice(0, 80)}`);
  }
  return { events, png };
}

async function sameText(p: Prepared, text: string, ctx: Context): Promise<true | string> {
  let events: Ev[];
  try {
    checkXml(text);
    events = xmlEvents(text, { svg: true });
  } catch (e) {
    return `not well-formed SVG: ${errorMessage(e)}`;
  }
  const s = sameEvents(p.events, events, { svg: true });
  if (s !== true) return s;
  const file = join(ctx.dir, `cand${++counter}.svg`);
  await Bun.write(file, text);
  let png: Uint8Array;
  try {
    png = await render(file, ctx);
  } catch (e) {
    return `the result does not render: ${errorMessage(e).slice(0, 80)}`;
  }
  if (png.length !== p.png.length || Buffer.compare(png, p.png) !== 0) return "the rendered picture differs";
  return true;
}

const svgOracle: Oracle = {
  async prepare(path, ctx) {
    return prepareText(await readText(path, SkipFile), ctx);
  },
  async same(original, candidate, ctx) {
    let text: string;
    try {
      text = await readText(candidate, SkipFile);
    } catch {
      return "the result is not valid UTF-8 text";
    }
    return sameText(original as Prepared, text, ctx);
  },
};

const gate = async (path: string, ctx: Context) => (ctx.settings.web.svg ? ((await Bun.file(path).size) < 17 ? "too small to optimise" : null) : "SVG minification is off (web.svg)");

export const svg: Format = {
  id: "svg",
  extensions: ["svg"],
  detect: (h) => rootIsSvg(headText(h)) && !(h[0] === 0x1f && h[1] === 0x8b),
  skip: (path, _h, ctx) => gate(path, ctx),
  steps: [toolStep({ id: "web.svg.minify", tool: "minify", args: (input, output) => ["--type", "svg", "-o", output, input] })],
  oracle: svgOracle,
};

// ---------------------------------------------------------------- SVGZ

const gunzip = (b: Uint8Array) => gunzipSync(b, { maxOutputLength: MAX_TEXT });
/** Level 9 gzip with no name or time stamp. */
const regzip = (text: string) => gzipSync(text, { level: 9, memLevel: 9 });

function svgzStep(id: string, tool: string | undefined, args?: (input: string, output: string) => string[]): Step {
  return {
    id,
    tool,
    async run(input, output, ctx) {
      const text = decoder.decode(gunzip(new Uint8Array(await Bun.file(input).arrayBuffer())));
      if (!tool) return void (await Bun.write(output, regzip(text)));
      const a = join(ctx.dir, `unz${++counter}.svg`), b = join(ctx.dir, `min${counter}.svg`);
      await Bun.write(a, text);
      const [cmd, ...rest] = args!(a, b);
      const r = await ctx.run(tool, [cmd, ...rest]);
      if (r.code !== 0) throw new Error(`${tool} exited with ${r.code}`);
      await Bun.write(output, regzip(await Bun.file(b).text()));
    },
  };
}

export const svgz: Format = {
  id: "svgz",
  extensions: ["svgz"],
  detect(h, n) {
    if (h[0] !== 0x1f || h[1] !== 0x8b || !n.toLowerCase().endsWith(".svgz")) return false;
    try {
      return rootIsSvg(new TextDecoder().decode(gunzipSync(h, { finishFlush: constants.Z_SYNC_FLUSH })).replace(/^﻿/, ""));
    } catch {
      return false;
    }
  },
  skip: (path, _h, ctx) => gate(path, ctx),
  steps: [
    svgzStep("web.svgz.minify", "minify", (i, o) => ["--type", "svg", "-o", o, i]),
    svgzStep("web.svgz.regzip", undefined),
  ],
  oracle: {
    async prepare(path, ctx) {
      let text: string;
      try {
        text = decoder.decode(gunzip(new Uint8Array(await Bun.file(path).arrayBuffer())));
      } catch (e) {
        if (e instanceof TypeError) throw new SkipFile("not UTF-8 text");
        throw e;
      }
      return prepareText(text, ctx);
    },
    async same(original, candidate, ctx) {
      let text: string;
      try {
        text = decoder.decode(gunzip(new Uint8Array(await Bun.file(candidate).arrayBuffer())));
      } catch {
        return "the result is not a valid gzip of UTF-8 text";
      }
      return sameText(original as Prepared, text, ctx);
    },
  },
};

export const formats: Format[] = [svg, svgz];
