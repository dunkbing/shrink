// Lua (docs/FORMATS.md section 18). Source (.lua): comments, indentation and blank-line-free joins are removed only
// when the setting `lua.minify` is on, and a result is kept only if its token stream AND the line of every token equal
// the original's (so error messages and debug info behave the same). Bytecode (.luac): recognised and left alone, with
// the reason, because stripping its debug data changes behaviour and each Lua build reads only its own bytecode layout.
import { SkipFile, type Format, type Settings, type Step } from "../types";
import { compactLua, tokenizeLua, type Tok } from "./lua-token";
import { errorMessage } from "../errors";

const latin = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const ext = (n: string) => (n.includes(".") ? n.split(".").pop()!.toLowerCase() : "");
const enabled = (s: Settings) => s.lua.minify;

const compact: Step = {
  id: "lua.compact",
  async run(input, output) {
    const text = latin(new Uint8Array(await Bun.file(input).arrayBuffer()));
    await Bun.write(output, Buffer.from(compactLua(text), "latin1"));
  },
};

function same(a: Tok[], b: Tok[]): true | string {
  if (a.length !== b.length) return "token count differs";
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind || a[i].text !== b[i].text) return `token ${i} differs`;
    if (a[i].line !== b[i].line) return `token ${i} moved to another line`;
  }
  return true;
}

export const lua: Format = {
  id: "lua",
  extensions: ["lua"],
  detect: (h, n) => ext(n) === "lua" && !h.includes(0) && h[0] !== 0x1b,
  async skip(path, _h, ctx) {
    if (!enabled(ctx.settings)) return "Lua minification is off (turn on lua.minify)";
    return Bun.file(path).size > 64 << 20 ? "larger than 64 MiB" : null;
  },
  steps: [compact],
  oracle: {
    async prepare(path) {
      const b = new Uint8Array(await Bun.file(path).arrayBuffer());
      if (b.includes(0)) throw new SkipFile("not Lua source (binary data)");
      return tokenizeLua(latin(b));
    },
    async same(original, candidate) {
      try {
        return same(original as Tok[], tokenizeLua(latin(new Uint8Array(await Bun.file(candidate).arrayBuffer()))));
      } catch (e) {
        return `the result does not tokenize: ${errorMessage(e)}`;
      }
    },
  },
};

export const luac: Format = {
  id: "lua.bytecode",
  extensions: ["luac", "lub", "luc"],
  detect: (h) => h[0] === 0x1b && ((h[1] === 0x4c && h[2] === 0x75 && h[3] === 0x61) || (h[1] === 0x4c && h[2] === 0x4a)),
  async skip() {
    return "unsupported: Lua bytecode can not be rewritten and proven identical (stripping debug data changes error messages, and the layout is tied to the Lua build)";
  },
  steps: [],
  oracle: { same: async () => "unsupported" },
};

export const formats: Format[] = [lua, luac];
