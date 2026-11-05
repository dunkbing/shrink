// Executables and libraries (docs/FORMATS.md section 16): off by default (`exe.enabled`).
// The oracle ("bytes-subset") parses both files and proves the loadable content is equal.
import { inPlaceStep, toolStep } from "../step";
import { SkipFile, type Context, type Format, type Settings, type Step } from "../types";
import { ET_REL, elfOverlay, isAr, isElf, parseAr, parseElf, sameAr, sameElf, type ArMember, type Elf } from "./elf-parse";
import { MH_OBJECT, isMacho, parseMacho, sameMacho, signatureKind } from "./macho-parse";
import { DIR_CLR, DIR_SECURITY, isPe, parsePe, peOverlay, samePe, stripPeSymbols, type Pe } from "./pe-parse";
import { errorMessage } from "../errors";

type Kind = "pe" | "elf" | "macho" | "ar";
type Parsed = { kind: "pe"; pe: Pe } | { kind: "elf"; elf: Elf } | { kind: "macho"; m: ReturnType<typeof parseMacho>; sig: string; signedOk?: boolean } | { kind: "ar"; members: ArMember[] };

const MAX = 512 * 1024 * 1024;

function kindOf(head: Uint8Array): Kind | null {
  if (isElf(head)) return "elf";
  if (isAr(head)) return "ar";
  if (isMacho(head)) return "macho";
  if (isPe(head)) return "pe";
  return null;
}

function parseAny(bytes: Uint8Array): Parsed {
  const kind = kindOf(bytes);
  if (kind === "pe") return { kind, pe: parsePe(bytes) };
  if (kind === "elf") return { kind, elf: parseElf(bytes) };
  if (kind === "macho") {
    const m = parseMacho(bytes);
    return { kind, m, sig: m.slices.map((s) => signatureKind(s.macho)).join(",") };
  }
  if (kind === "ar") return { kind, members: parseAr(bytes).members };
  throw new Error("not an executable");
}

const isUpx = (p: Parsed) =>
  (p.kind === "pe" && p.pe.sections.some((s) => /^UPX\d$/.test(s.name))) ||
  (p.kind === "elf" && Buffer.from(p.elf.bytes.subarray(0, Math.min(p.elf.bytes.length, 4096))).includes("UPX!"));

const kindIs = (...k: Kind[]) => (ctx: Context) => k.includes(ctx.facts.kind as Kind);

const peSymbols: Step = {
  id: "exe.pe-symbols",
  when: (ctx) => (ctx.facts.kind === "pe" ? ctx.facts.peTail === true || "no symbol table at the end of the file" : false),
  async run(input, output) {
    const out = stripPeSymbols(parsePe(new Uint8Array(await Bun.file(input).arrayBuffer())));
    if (!out) throw new Error("no trailing symbol table");
    await Bun.write(output, out);
  },
};

const gnuStrip = toolStep({
  id: "exe.strip",
  tool: "gnu-strip",
  when: kindIs("pe", "elf", "ar"),
  // object files and archives keep their symbols (the linker needs them): only debug data goes
  args: (input, output, ctx) => [ctx.facts.kind === "ar" || ctx.facts.elfType === ET_REL ? "--strip-debug" : "-s", "-o", output, input],
});

const machoStrip = toolStep({ id: "exe.strip-macho", tool: "strip", when: kindIs("macho"), args: (input, output) => ["-x", "-o", output, input] });

const leanify = inPlaceStep({ id: "exe.leanify", tool: "leanify", minLevel: 5, when: kindIs("pe"), args: (file) => ["-q", file] });

const upx = toolStep({
  id: "exe.upx",
  tool: "upx",
  minLevel: 5,
  when: (ctx) => {
    if (!ctx.settings.exe.upx) return "UPX is off (exe.upx)";
    if (ctx.facts.packed) return "already packed";
    return (ctx.facts.kind === "pe" || (ctx.facts.kind === "elf" && ctx.facts.elfType !== ET_REL)) ? true : "not a PE or ELF program";
  },
  args: (input, output, ctx) => [ctx.level >= 8 ? "--ultra-brute" : ctx.level >= 6 ? "--best" : "-6", "-q", "-o", output, input],
});

/** The reason an executable is left alone, or null. Parse failures are left to the oracle, which reports them as damage. */
function whySkip(bytes: Uint8Array, ctx: Context): string | null {
  let p: Parsed;
  try {
    p = parseAny(bytes);
  } catch {
    return null;
  }
  ctx.facts.kind = p.kind;
  ctx.facts.packed = isUpx(p);
  if (p.kind === "pe") {
    const pe = p.pe;
    if (pe.dirs[DIR_SECURITY].rva || pe.dirs[DIR_SECURITY].size) return "signed (Authenticode)";
    if (pe.dirs[DIR_CLR].rva) return ".NET assembly";
    if (peOverlay(pe) > 0) return "has data appended after its sections (installer, self-extractor or overlay)";
    if (ctx.facts.packed) return "already packed";
    ctx.facts.peTail = pe.symPtr !== 0 && pe.symEnd === bytes.length && pe.symPtr >= pe.rawEnd;
  } else if (p.kind === "elf") {
    ctx.facts.elfType = p.elf.type;
    if (elfOverlay(p.elf) > 0) return "has data appended after its sections (self-extractor or overlay)";
    if (ctx.facts.packed) return "already packed";
  } else if (p.kind === "macho") {
    if (p.m.slices.some((s) => s.macho.filetype === MH_OBJECT)) return "Mach-O object file (its symbols are needed to link it)";
    if (p.m.slices.some((s) => ["identity", "adhoc"].includes(signatureKind(s.macho)))) return "code-signed or notarised (stripping would invalidate the signature)";
    if (!p.m.fat && p.m.slices.some((s) => s.macho.end < s.size)) return "has data appended after its segments";
  } else {
    if (p.members.some((m) => !isElf(m.data))) return "archive holds objects that are not ELF (only ELF archives are rewritten)";
  }
  return null;
}

async function codesignOk(path: string): Promise<boolean> {
  if (process.platform !== "darwin" || !Bun.which("codesign")) return true;
  return (await Bun.spawn(["codesign", "--verify", path], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
}

export const exe: Format = {
  id: "exe",
  extensions: ["exe", "dll", "ocx", "cpl", "scr", "sys", "drv", "efi", "o", "obj", "a", "lib", "so", "dylib", "ko"],
  detect: (h) => kindOf(h) !== null,
  flags: (_s: Settings) => ({}),
  async skip(path, _head, ctx) {
    if (!ctx.settings.exe.enabled) return "executables are off (turn on exe.enabled)";
    const f = Bun.file(path);
    if (f.size > MAX) return "larger than 512 MiB";
    return whySkip(new Uint8Array(await f.arrayBuffer()), ctx);
  },
  steps: [peSymbols, gnuStrip, machoStrip, leanify, upx],
  oracle: {
    async prepare(path) {
      const f = Bun.file(path);
      if (f.size > MAX) throw new SkipFile("larger than 512 MiB");
      const p = parseAny(new Uint8Array(await f.arrayBuffer()));
      // a signature that verified before must verify after
      if (p.kind === "macho" && p.sig.split(",").some((x) => x !== "none")) p.signedOk = await codesignOk(path);
      return p;
    },
    async same(original, candidatePath, ctx) {
      const a = original as Parsed;
      let bytes = new Uint8Array(await Bun.file(candidatePath).arrayBuffer());
      let b: Parsed;
      try {
        b = parseAny(bytes);
        if (isUpx(b) && !isUpx(a)) {
          // a packed result is proven by unpacking it: the unpacked program must equal the original
          const t = `${candidatePath}.unpacked`;
          const r = await ctx.run("upx", ["-d", "-q", "-o", t, candidatePath]);
          if (r.code !== 0) return "the packed result does not unpack";
          bytes = new Uint8Array(await Bun.file(t).arrayBuffer());
          b = parseAny(bytes);
        }
      } catch (e) {
        return `the result does not parse: ${errorMessage(e)}`;
      }
      if (a.kind !== b.kind) return "file kind changed";
      switch (a.kind) {
        case "pe":
          return samePe(a.pe, (b as typeof a).pe);
        case "elf":
          return sameElf(a.elf, (b as typeof a).elf);
        case "ar":
          return sameAr(a.members, (b as Extract<Parsed, { kind: "ar" }>).members);
        case "macho": {
          const linker = a.sig.split(",").some((s) => s !== "none");
          const r = sameMacho(a.m, (b as typeof a).m, linker);
          if (r !== true) return r;
          if (linker && a.signedOk && !(await codesignOk(candidatePath))) return "the result's code signature is not valid";
          return true;
        }
      }
    },
  },
};

export const formats: Format[] = [exe];
