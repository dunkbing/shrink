// Executable cases (docs/FORMATS.md, section 16): PE, ELF and Mach-O through the real strip tools.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, createTools, defaults } from "../src";
import { exe } from "../src/formats/exe.format";
import { parseAr, parseElf, sameElf } from "../src/formats/elf-parse";
import { parseMacho, sameMacho } from "../src/formats/macho-parse";
import { parsePe, peChecksum, samePe } from "../src/formats/pe-parse";
import { env, type Env } from "./fake";
import { makeAr, makeElf, makePe } from "./lib/exe";

const envs: Env[] = [];
const make = (settings: any = { exe: { enabled: true } }, extra: any = {}) => {
  const e = env({ formats: [exe], settings });
  envs.push(e);
  return Object.assign(e, extra) as Env;
};
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

let gnuStrip = false;
let appleStrip = false;
beforeAll(async () => {
  const t = createTools(defaults);
  gnuStrip = (await t.locate("gnu-strip")) !== null;
  appleStrip = process.platform === "darwin" && (await t.locate("strip")) !== null;
});
const need = (cond: () => boolean) => (name: string, fn: () => Promise<void>) => test(name, async () => (cond() ? fn() : void 0));
const withGnu = need(() => gnuStrip);
const withApple = need(() => appleStrip && Bun.which("cc") !== null);
const bytes = (p: string) => new Uint8Array(readFileSync(p));

// ---- helpers for building Mach-O test programs with the system compiler
const scratch = mkdtempSync(join(tmpdir(), "shrink-exe-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
function compile(name: string, extra: string[] = []): string {
  const src = join(scratch, `${name}.c`);
  const fns = Array.from({ length: 60 }, (_, i) => `static int local_function_number_${i}(int x){return x*${i + 2}+${i};}`).join("\n");
  const table = Array.from({ length: 60 }, (_, i) => `local_function_number_${i}`).join(",");
  writeFileSync(src, `#include <stdio.h>\n${fns}\nint (*volatile table[])(int)={${table}};\nint main(void){int s=0;for(int i=0;i<60;i++)s+=table[i](i);printf("sum %d\\n",s);return 0;}\n`);
  const out = join(scratch, name);
  const r = Bun.spawnSync(["cc", "-g", "-O0", ...extra, "-o", out, src]);
  if (r.exitCode !== 0) throw new Error(`cc failed: ${r.stderr}`);
  return out;
}
const run = (p: string) => {
  const r = Bun.spawnSync([p]);
  return `${r.exitCode}:${r.stdout}`;
};

// ---- the oracle itself

test("PE parser: sections, symbols, checksum", () => {
  const pe = parsePe(makePe({ symbols: 4, debugSection: true, checksum: true }));
  expect(pe.sections.map((s) => s.name)).toEqual([".text", ".data", "/4"]);
  expect(pe.symEnd).toBe(pe.bytes.length);
  expect(pe.checksum).toBe(peChecksum(pe.bytes, pe.optOff + 64));
});

test("EXE oracle: a changed byte in a loadable section is rejected (PE, ELF, Mach-O)", async () => {
  const pe = makePe({ symbols: 3 });
  const pe2 = pe.slice();
  pe2[0x200 + 1] ^= 1;
  expect(samePe(parsePe(pe), parsePe(pe2))).toContain("contents changed");
  const elf = makeElf();
  const elf2 = elf.slice();
  elf2[0x78] ^= 1;
  expect(sameElf(parseElf(elf), parseElf(elf2))).toContain("changed");
  if (process.platform === "darwin" && Bun.which("cc")) {
    const m = new Uint8Array(readFileSync(compile("tamper")));
    const m2 = m.slice();
    const seg = parseMacho(m).slices[0].macho.segments.find((s) => s.name === "__TEXT")!;
    m2[seg.sections[0] ? seg.sections[0].offset + 4 : seg.fileoff + 0x4000] ^= 1;
    expect(sameMacho(parseMacho(m), parseMacho(m2), true)).toContain("changed");
  }
});

test("EXE oracle: only debug sections may vanish, and none may appear", () => {
  const withDebug = makePe({ debugSection: true });
  const without = makePe();
  expect(samePe(parsePe(withDebug), parsePe(without))).toBe(true);
  expect(samePe(parsePe(without), parsePe(withDebug))).toContain("section count");
  const renamed = withDebug.slice();
  renamed.set(new TextEncoder().encode(".rsrc\0\0\0"), 0x80 + 4 + 20 + 240 + 80); // the third section is no longer debug data
  expect(samePe(parsePe(renamed), parsePe(without))).toContain("section count");
});

// ---- cases

withGnu("EXE-01: a PE with a symbol table and a debug section shrinks and keeps its sections", async () => {
  const e = make();
  const original = makePe({ symbols: 40, debugSection: true, checksum: true });
  const p = await e.file("a.exe", original);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  const out = parsePe(bytes(p));
  expect(samePe(parsePe(original), out)).toBe(true);
  expect(out.symPtr).toBe(0);
  expect(out.checksum).toBe(peChecksum(bytes(p), out.optOff + 64));
});

test("EXE-01: the native PE step alone removes the symbol table (no tool needed)", async () => {
  const e = make({ exe: { enabled: true }, disabledTools: ["gnu-strip", "leanify", "upx"] });
  const original = makePe({ symbols: 40 });
  const p = await e.file("a.dll", original);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.steps[0]).toMatchObject({ id: "exe.pe-symbols", outcome: "kept" });
  expect(bytes(p).length).toBe(parsePe(original).symPtr);
});

test("EXE: off by default, and an enabled setting is required", async () => {
  const e = make({});
  const original = makePe({ symbols: 40 });
  const p = await e.file("a.exe", original);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("exe.enabled");
  expect(readFileSync(p)).toEqual(Buffer.from(original));
});

test("EXE-02: a signed PE is skipped", async () => {
  const e = make();
  const original = makePe({ symbols: 40, signed: true });
  const p = await e.file("a.exe", original);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("signed");
  expect(readFileSync(p)).toEqual(Buffer.from(original));
});

test("EXE-03: appended overlay data is never touched (PE and ELF)", async () => {
  const e = make();
  for (const [name, data] of [["a.exe", makePe({ symbols: 40, overlay: 500 })], ["a.out", makeElf({ overlay: 500 })]] as const) {
    const p = await e.file(name, data);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("appended");
    expect(readFileSync(p)).toEqual(Buffer.from(data));
  }
});

withGnu("EXE-04: ELF strip keeps the loadable segments and sections", async () => {
  const e = make();
  const original = makeElf();
  const p = await e.file("prog", original);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before / 2);
  const out = parseElf(bytes(p));
  expect(sameElf(parseElf(original), out)).toBe(true);
  expect(out.sections.map((s) => s.name)).not.toContain(".symtab");
  const readelf = Bun.which("readelf") ?? (process.platform === "darwin" ? "/opt/homebrew/opt/binutils/bin/readelf" : null);
  if (readelf && (await Bun.file(readelf).exists())) expect(Bun.spawnSync([readelf, "-h", p]).exitCode).toBe(0);
});

withGnu("EXE-04: ELF shared object keeps its dynamic symbols (only .symtab goes)", async () => {
  const so = makeElf();
  new DataView(so.buffer).setUint16(16, 3, true); // ET_DYN
  const e = make();
  const p = await e.file("lib.so", so);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(sameElf(parseElf(so), parseElf(bytes(p)))).toBe(true);
});

withGnu("EXE: a relocatable object keeps its symbols and loses only debug data", async () => {
  const e = make();
  const original = makeElf({ rel: true });
  const p = await e.file("a.o", original);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = parseElf(bytes(p));
  expect(out.sections.map((s) => s.name)).toContain(".symtab");
  expect(out.sections.map((s) => s.name)).not.toContain(".debug_info");
  expect(sameElf(parseElf(original), out)).toBe(true);
});

withGnu("EXE: an ar archive of ELF objects is stripped member by member", async () => {
  const e = make();
  const members = [{ name: "first.o", data: makeElf({ rel: true }) }, { name: "second.o", data: makeElf({ rel: true, extern: "other" }) }];
  const original = makeAr(members);
  const p = await e.file("lib.a", original);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const out = parseAr(bytes(p)).members;
  expect(out.map((m) => m.name)).toEqual(["first.o", "second.o"]);
  expect(parseElf(out[0].data).sections.map((s) => s.name)).not.toContain(".debug_info");
});

withGnu("EXE: an archive with long member names is either stripped with its names intact or left alone", async () => {
  const e = make();
  const names = ["first.o", "a_member_with_a_long_name.o"];
  const original = makeAr(names.map((name) => ({ name, data: makeElf({ rel: true }) })));
  const p = await e.file("lib.a", original);
  const r = await e.engine.optimizeFile(p);
  expect(["optimized", "unchanged"]).toContain(r.status);
  expect(parseAr(bytes(p)).members.map((m) => m.name)).toEqual(names);
});

test("EXE: an archive with a non-ELF member is skipped with a reason", async () => {
  const e = make();
  const p = await e.file("lib.a", makeAr([{ name: "x.o", data: new Uint8Array(200).fill(1) }]));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("not ELF");
});

test("EXE-06: a .NET assembly is skipped", async () => {
  const e = make();
  const original = makePe({ symbols: 40, dotnet: true });
  const p = await e.file("a.dll", original);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain(".NET");
});

test("EXE-07: UPX never runs unless exe.upx is on", async () => {
  const marker = join(scratch, "upx-ran");
  rmSync(marker, { force: true });
  // a fake tool as a bun script, so it runs the same everywhere
  const script = join(scratch, "fake-upx.js");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\nprocess.exit(1);\n`);
  const fake = [process.execPath, script];
  const original = makePe({ symbols: 40 });
  const off = make({ exe: { enabled: true }, toolPaths: { upx: fake }, level: 9 });
  const r = await off.engine.optimizeFile(await off.file("a.exe", original));
  expect(r.steps.find((s) => s.id === "exe.upx")?.detail).toContain("exe.upx");
  expect(await Bun.file(marker).exists()).toBe(false);
  const on = make({ exe: { enabled: true, upx: true }, toolPaths: { upx: fake }, level: 9 });
  const r2 = await on.engine.optimizeFile(await on.file("b.exe", original));
  expect(r2.steps.find((s) => s.id === "exe.upx")?.outcome).toBe("failed");
  expect(await Bun.file(marker).exists()).toBe(true);
});

withGnu("EXE-08 / COMMON-08: a strip that changes code is rejected and the file is untouched", async () => {
  const original = makeElf();
  const script = join(scratch, "liar.js");
  // gets `-s -o out in`: copies the input to the output, flips a code byte and cuts the file at 300 bytes
  writeFileSync(script, `const fs = require("node:fs");\nconst [, , out, inp] = process.argv.slice(2);\nconst b = fs.readFileSync(inp);\nb[120] = 0x58;\nfs.writeFileSync(out, b.subarray(0, 300));\n`);
  const liar = [process.execPath, script];
  const e = make({ exe: { enabled: true }, toolPaths: { "gnu-strip": liar } });
  const p = await e.file("prog", original);
  const r = await e.engine.optimizeFile(p);
  const step = r.steps.find((s) => s.id === "exe.strip")!;
  expect(step.outcome).toBe("rejected");
  expect(r.status).toBe("unchanged");
  expect(readFileSync(p)).toEqual(Buffer.from(original));
});

test("EXE-09 / COMMON-05: truncated PE, ELF and Mach-O files are left alone as damaged", async () => {
  const e = make();
  const cases: [string, Uint8Array][] = [
    ["a.exe", makePe({ symbols: 40, debugSection: true }).subarray(0, 0x300)],
    ["a.so", makeElf().subarray(0, 0x200)],
    ["b.exe", makePe({ symbols: 40 }).subarray(0, 0x1fe)],
  ];
  if (process.platform === "darwin" && Bun.which("cc")) cases.push(["mac", new Uint8Array(readFileSync(compile("trunc"))).subarray(0, 20000)]);
  for (const [name, data] of cases) {
    const p = await e.file(name, data);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("damaged");
    expect(readFileSync(p)).toEqual(Buffer.from(data));
  }
});

// ---- Mach-O with the system compiler

withApple("EXE-01 smoke: a compiled Mach-O program is stripped, still passes codesign, and prints the same", async () => {
  const prog = compile("smoke");
  const before = run(prog);
  expect(before).toContain("sum");
  const e = make();
  const p = await e.file("smoke", bytes(prog));
  chmodSync(p, 0o755);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  expect(r.after).toBeLessThan(r.before);
  expect(run(p)).toBe(before);
  expect(Bun.spawnSync(["codesign", "--verify", p]).exitCode).toBe(0);
});

withApple("EXE-05: a universal (fat) Mach-O keeps both slices", async () => {
  const fat = compile("fat", ["-arch", "arm64", "-arch", "x86_64"]);
  const e = make();
  const p = await e.file("fat", bytes(fat));
  chmodSync(p, 0o755);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("optimized");
  const a = parseMacho(bytes(fat));
  const b = parseMacho(bytes(p));
  expect(a.slices.length).toBe(2);
  expect(sameMacho(a, b, true)).toBe(true);
  expect(run(p)).toContain("sum");
});

withApple("EXE-05: a Mach-O signed with an identity-style or ad hoc signature is skipped", async () => {
  const prog = compile("signed");
  expect(Bun.spawnSync(["codesign", "-s", "-", "-f", "--identifier", "x.y", prog]).exitCode).toBe(0);
  const e = make();
  const data = bytes(prog);
  const p = await e.file("signed", data);
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("signed");
  expect(readFileSync(p)).toEqual(Buffer.from(data));
});

withApple("EXE: Mach-O object files are skipped", async () => {
  const src = join(scratch, "obj.c");
  writeFileSync(src, "int f(int x){return x+1;}\n");
  const out = join(scratch, "obj.o");
  Bun.spawnSync(["cc", "-g", "-c", "-o", out, src]);
  const e = make();
  const p = await e.file("obj.o", bytes(out));
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("object");
});

test("COMMON-07: an executable with a .png name is skipped for the mismatch (when both formats are registered)", async () => {
  const { png } = await import("../src");
  const e = env({ formats: [exe, png], settings: { exe: { enabled: true } } });
  envs.push(e);
  const p = await e.file("a.png", makeElf());
  const r = await e.engine.optimizeFile(p);
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("extension");
});

need(() => Bun.which("upx") !== null)("EXE-07: with exe.upx on, a packed PE is proven by unpacking it", async () => {
  const e = make({ exe: { enabled: true, upx: true }, disabledTools: ["gnu-strip"], level: 7 });
  const original = makePe({ debugSection: true });
  const p = await e.file("a.exe", original);
  const r = await e.engine.optimizeFile(p);
  const step = r.steps.find((s) => s.id === "exe.upx")!;
  expect(["kept", "rejected", "not smaller"]).toContain(step.outcome);
  if (step.outcome === "kept") expect(bytes(p).length).toBeLessThan(original.length);
  else expect(readFileSync(p)).toEqual(Buffer.from(original));
});

// ---- real files (fixtures/real, fetched by `bun run fixtures:fetch misc`) and the system's own binaries

import { existsSync, readdirSync } from "node:fs";
const realDir = join(import.meta.dir, "../../../fixtures/real");
const real = existsSync(realDir) ? readdirSync(realDir).filter((f) => f.startsWith("exe-")) : [];

test("real PE/ELF/object files: nothing fails or grows, and each result passes the oracle", async () => {
  if (!gnuStrip) return;
  const e = make();
  let optimized = 0;
  for (const f of real) {
    const data = bytes(join(realDir, f));
    const p = await e.file(f, data);
    const r = await e.engine.optimizeFile(p);
    expect(["optimized", "unchanged", "skipped"]).toContain(r.status);
    expect(r.after).toBeLessThanOrEqual(r.before);
    if (r.status === "optimized") {
      optimized++;
      if (f.endsWith(".exe")) expect(samePe(parsePe(data), parsePe(bytes(p)))).toBe(true);
      else expect(sameElf(parseElf(data), parseElf(bytes(p)))).toBe(true);
    }
  }
  if (real.some((f) => f.endsWith(".elf"))) expect(optimized).toBeGreaterThan(0);
});

test("system binaries (signed by the OS) are skipped, never touched", async () => {
  if (process.platform !== "darwin") return;
  const e = make();
  for (const src of ["/bin/ls", "/usr/bin/true"]) {
    const data = bytes(src);
    const p = await e.file(src.split("/").pop()!, data);
    const r = await e.engine.optimizeFile(p);
    expect(r.status).toBe("skipped");
    expect(readFileSync(p)).toEqual(Buffer.from(data));
  }
});
