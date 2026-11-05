// Lua cases (docs/FORMATS.md section 18).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lua, luac } from "../src/formats/lua.format";
import { compactLua, tokenizeLua } from "../src/formats/lua-token";
import { env, type Env } from "./fake";

const envs: Env[] = [];
const make = (settings: object = { lua: { minify: true } }) => (envs.push(env({ formats: [lua, luac], settings: settings as any })), envs[envs.length - 1]);
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

const src = `#!/usr/bin/env lua
-- a comment
local function f(a, b)   -- trailing
  --[==[ long
  comment ]==]
  local s = [[
text  with   spaces
]]
  return a - -b, "x  y", 'it\\'s', 0x1p-2, 1e+5, a .. b, ...
end

--[[ block ]] print(f(1, 2))   
x = a - - b ; y = t[ [[k]] ]
`;

test("LUA-02: comments and indentation go, tokens and their lines are identical", async () => {
  const e = make();
  const p = await e.file("a.lua", src.repeat(5));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const a = tokenizeLua(src.repeat(5)), b = tokenizeLua(readFileSync(p, "latin1"));
  expect(b).toEqual(a);
  expect(readFileSync(p, "latin1")).toContain("a- -b");
});

test("LUA-03: off by default, with the reason", async () => {
  const e = make({});
  const p = await e.file("a.lua", src);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("lua.minify");
  expect(readFileSync(p, "latin1")).toBe(src);
});

test("LUA-01: bytecode is untouched with an honest reason", async () => {
  const e = make();
  const bc = Buffer.concat([Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x54, 0]), Buffer.alloc(200, 7)]);
  const p = await e.file("a.luac", bc);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("unsupported: Lua bytecode");
  expect(readFileSync(p).equals(bc)).toBe(true);
});

test("COMMON-05 for lua: an unfinished string or long comment is untouched and reported damaged", async () => {
  const e = make();
  for (const [n, t] of [["s.lua", 'print("hello world, this is cut'], ["c.lua", "x = 1 --[[ never closed\nfoo bar baz"]] as const) {
    const p = await e.file(n, t);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(readFileSync(p, "utf8")).toBe(t);
  }
});

test("COMMON-08 for lua: the oracle rejects changed tokens, moved lines and broken output", async () => {
  const e = make();
  const ctx: any = { settings: e.engine.settings, dir: e.dir, facts: {} };
  const prepared = await lua.oracle.prepare!(await e.file("o.lua", src), ctx);
  const check = async (t: string) => lua.oracle.same(prepared, await e.file(`${Math.random()}.lua`, t), ctx);
  expect(await check(src.replace("a - -b", "a - b"))).toContain("differs");
  expect(await check(src.replace("x  y", "x y"))).toContain("differs");
  expect(await check(src.replace("\n\n--[[ block", "\n--[[ block"))).toContain("line");
  expect(await check(src + 'z = "unfinished')).toContain("tokenize");
  expect(await check(compactLua(src))).toBe(true);
});

test("compaction never glues tokens that would read differently", () => {
  for (const t of ["a - -b", "a .. .5", "x = 1 .. 2", "t[ [[k]] ]", "a = b - - - c", "f(...)..'x'", "x = a< <b", "return - -1"]) {
    const c = compactLua(t);
    expect(tokenizeLua(c).map((k) => k.text)).toEqual(tokenizeLua(t).map((k) => k.text));
  }
});
