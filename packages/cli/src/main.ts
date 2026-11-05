#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { Engine, ToolProvisioner, allFormats, createTools, errorMessage, resolve as resolveSettings, type PackState, type Report } from "@shrink/engine";

const USAGE = `shrink [flags] files or folders...

Makes files smaller without changing what they contain. Files are optimized in place.

  -l, --level n        1 (fast) to 9 (extreme), default 5
  -j, --jobs n         files at once (default: one per CPU core)
      --lossy          allow steps that change decoded content
      --keep-metadata  keep EXIF, comments and other metadata
      --no-cache       also process files already optimized
  -n, --dry-run        show what would change, write nothing
      --offline        never download tools (also: SHRINK_OFFLINE=1)
  -v, --verbose        every step, and why files were skipped

Tools (oxipng, ffmpeg, ...) are downloaded by themselves when a file needs them. \`shrink tools\` lists them.
  -h, --help
`;

const SKIP_DIRS = new Set([".git", ".svn", ".hg", "node_modules", "__pycache__"]);
const KNOWN = new Set(allFormats.flatMap((f) => f.extensions ?? []));

function expand(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string, top: boolean) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return void out.push(p); // reported as "not found"
    if (!st.isDirectory()) return void (top || KNOWN.has(extname(p).slice(1).toLowerCase()) ? out.push(p) : 0);
    for (const e of readdirSync(p)) if (!SKIP_DIRS.has(e)) walk(join(p, e), false);
  };
  for (const p of paths) walk(p, true);
  return out;
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** The "preparing tools" line on stderr (a single line per pack when stderr is not a terminal). */
function progressLine(): (s: PackState) => void {
  const tty = process.stderr.isTTY;
  const shown = new Map<string, string>();
  return (s) => {
    if (s.phase !== "downloading" && s.phase !== "extracting" && s.phase !== "ready" && s.phase !== "failed" && s.phase !== "offline") return;
    const names = s.tools.length > 3 ? `${s.tools.slice(0, 3).join(", ")} and ${s.tools.length - 3} more` : s.tools.join(", ");
    const text = s.phase === "downloading" ? `preparing tools (${names} ${s.total ? mb(s.total) : ""})…` : s.phase === "extracting" ? `unpacking tools (${names})…` : s.phase === "ready" ? `tools ready (${names})` : `tools not available (${names}): ${s.error ?? s.phase}`;
    if (shown.get(s.pack) === text.replace(/ ?\d+ MB/, "")) return;
    if (tty && s.phase === "downloading") return void process.stderr.write(`\r${text}${s.total ? ` ${Math.round((s.received / s.total) * 100)}%` : ""}   `);
    shown.set(s.pack, text.replace(/ ?\d+ MB/, ""));
    process.stderr.write(`${tty ? "\r" : ""}${text}${tty ? "          \n" : "\n"}`);
  };
}

/** `shrink tools`: where each tool comes from. */
async function toolsStatus(offline: boolean): Promise<number> {
  const provisioner = new ToolProvisioner({ offline });
  const tools = createTools(resolveSettings(), undefined, provisioner);
  for (const name of Object.keys(provisioner.manifest.tools).sort()) {
    const have = await tools.locate(name);
    const how = !have ? (provisioner.canProvide(name) ? `will be downloaded (${provisioner.packOf(name)} pack)` : "not available") : provisioner.installed(name) === have[0] ? "downloaded" : "installed on this machine";
    console.log(`${name.padEnd(12)} ${how}${have ? `  ${have.join(" ")}` : ""}`);
  }
  console.log(`\ntools folder: ${provisioner.dir}`);
  return 0;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        level: { type: "string", short: "l" }, jobs: { type: "string", short: "j" }, lossy: { type: "boolean" },
        "keep-metadata": { type: "boolean" }, "no-cache": { type: "boolean" }, "dry-run": { type: "boolean", short: "n" },
        verbose: { type: "boolean", short: "v" }, offline: { type: "boolean" }, help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    console.error(`shrink: ${errorMessage(e)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (positionals.length === 1 && positionals[0] === "tools" && !statSync("tools", { throwIfNoEntry: false })) return toolsStatus(!!values.offline);
  const level = values.level ? Number(values.level) : undefined;
  if (level !== undefined && !(level >= 1 && level <= 9)) {
    console.error("shrink: --level must be 1 to 9");
    return 2;
  }
  const keep = !!values["keep-metadata"], lossy = !!values.lossy;
  const provisioner = new ToolProvisioner({ offline: values.offline ? true : undefined, onProgress: progressLine() });
  const engine = new Engine({
    formats: allFormats,
    provisioner,
    settings: {
      ...(level ? { level } : {}),
      workers: values.jobs ? Number(values.jobs) : 0,
      skipOptimized: !values["no-cache"],
      png: { lossy, keepMetadata: keep }, jpeg: { lossy, keepMetadata: keep }, gif: { lossy, keepMetadata: keep }, webp: { lossy, keepMetadata: keep },
    },
  });
  const ac = new AbortController();
  process.on("SIGINT", () => (ac.signal.aborted ? process.exit(130) : ac.abort()));

  let saved = 0, before = 0, done = 0, failed = 0;
  const show = (r: Report) => {
    done++;
    before += r.before;
    saved += r.before - r.after;
    if (r.status === "failed") failed++;
    if (r.status === "skipped" && !values.verbose) return;
    const pct = r.before ? ((1 - r.after / r.before) * 100).toFixed(1) : "0.0";
    const tail = r.status === "optimized" ? `${size(r.before)} -> ${size(r.after)} (-${pct}%)` : r.reason ? `${r.status}: ${r.reason}` : r.status;
    console.log(`${r.path}: ${tail}${r.dryRun ? " [dry run]" : ""}`);
    if (values.verbose) {
      for (const s of r.steps) console.log(`    ${s.id}: ${s.outcome}${s.size !== undefined ? ` ${size(s.size)}` : ""}${s.detail ? ` (${s.detail})` : ""}`);
      for (const n of r.notes) console.log(`    note: ${n}`);
    }
  };
  await engine.optimizeMany(expand(positionals), { dryRun: !!values["dry-run"], signal: ac.signal, onResult: show });
  const pct = before ? ((saved / before) * 100).toFixed(1) : "0.0";
  console.log(`\n${done} files, ${size(saved)} ${values["dry-run"] ? "could be " : ""}saved (${pct}%)`);
  return ac.signal.aborted ? 130 : failed ? 1 : 0;
}

process.exit(await main());
