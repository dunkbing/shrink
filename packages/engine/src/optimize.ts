import { constants, copyFileSync, mkdtempSync, rmSync, statSync, realpathSync, utimesSync, accessSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Cache, hashFile } from "./cache";
import { detect, HEAD } from "./detect";
import { MissingTool, createTools, runCommand } from "./tools";
import { resolve } from "./settings";
import { SkipFile, type Context, type Format, type Options, type Report, type Settings, type StepReport, type Step } from "./types";

/** The part of a file that tells if it changed: size, mtime and a hash of its first and last blocks. */
async function fingerprint(path: string): Promise<string> {
  const st = statSync(path);
  const f = Bun.file(path);
  const h = new Bun.CryptoHasher("sha256");
  h.update(new Uint8Array(await f.slice(0, 65536).arrayBuffer()));
  h.update(new Uint8Array(await f.slice(Math.max(0, st.size - 65536), st.size).arrayBuffer()));
  return `${st.size}:${st.mtimeMs}:${h.digest("hex")}`;
}

function enabled(step: Step, format: Format, ctx: Context): string | null {
  const flags = format.flags?.(ctx.settings) ?? {};
  if (step.lossy && !flags.lossy) return "lossy steps are off";
  if (step.strip && (flags.keepMetadata || ctx.facts.protected)) return flags.keepMetadata ? "metadata is kept" : "the file's metadata affects how it looks";
  if (step.minLevel && ctx.level < step.minLevel) return `needs level ${step.minLevel}`;
  const w = step.when?.(ctx);
  if (w === false) return "does not apply";
  if (typeof w === "string") return w;
  return null;
}

export class Engine {
  readonly settings: Settings;
  private formats: Format[];
  private cache: Cache;
  private opts: Options;

  constructor(opts: Options = {}) {
    this.opts = opts;
    this.settings = resolve(opts.settings);
    this.formats = opts.formats ?? [];
    this.cache = new Cache(opts.cacheDir);
  }

  /** Optimises one file in place. Never throws: the report says what happened. */
  async optimizeFile(input: string, o: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<Report> {
    const settings = this.settings;
    const report: Report = { path: input, status: "unchanged", before: 0, after: 0, steps: [], notes: [], dryRun: o.dryRun };
    const skip = (reason: string): Report => ((report.status = "skipped"), (report.reason = reason), report);
    const abort = new AbortController();
    for (const s of [this.opts.signal, o.signal]) {
      if (s?.aborted) abort.abort();
      else s?.addEventListener("abort", () => abort.abort(), { once: true });
    }
    let dir: string | null = null;
    try {
      let path: string;
      try {
        path = realpathSync(input); // a symlink: the file it points to is optimised
        const st = statSync(path);
        if (!st.isFile()) return skip("not a file");
        report.before = report.after = st.size;
      } catch (e: any) {
        report.status = "failed";
        report.reason = e?.code === "ENOENT" ? "not found" : String(e?.message ?? e);
        return report;
      }
      if (report.before < 16) return skip(report.before === 0 ? "empty file" : "too small");
      if (!o.dryRun) {
        try {
          accessSync(path, constants.W_OK);
        } catch {
          return skip("read-only");
        }
      }
      const head = new Uint8Array(await Bun.file(path).slice(0, HEAD).arrayBuffer());
      const found = detect(head, basename(path), this.formats);
      if (!found) return skip("unsupported format");
      if ("skip" in found) return skip(found.skip);
      const format = found.format;
      report.format = format.id;

      const key = settings.skipOptimized ? Cache.key(await hashFile(path), settings) : null;
      if (key && this.cache.has(key)) return skip("already optimized");

      dir = mkdtempSync(join(this.opts.tempDir ?? tmpdir(), "shrink-"));
      const tools = createTools(settings, this.opts.toolDir);
      let cur = abort; // the running step's own controller: cancelled with the job, or when the step times out
      const ctx: Context = {
        settings,
        level: settings.level,
        original: path,
        format: format.id,
        dir,
        get signal() {
          return cur.signal;
        },
        tools,
        facts: {},
        note: (m) => report.notes.push(m),
        async run(tool, args, ro) {
          const cmd = await tools.locate(tool);
          if (!cmd) throw new MissingTool(tool);
          return runCommand([...cmd, ...args], { signal: cur.signal, timeoutMs: settings.stepTimeout * 1000, cwd: ro?.cwd, lowPriority: settings.lowPriority });
        },
      };

      const reason = await format.skip?.(path, head, ctx);
      if (reason) return skip(reason);

      const before = await fingerprint(path);
      const work = join(dir, "original");
      copyFileSync(path, work); // the copy steps read, and the way back if writing the result fails
      let prepared: unknown;
      try {
        prepared = await format.oracle.prepare?.(work, ctx);
      } catch (e: any) {
        if (abort.signal.aborted) return (report.status = "failed", report.reason = "cancelled", report);
        return skip(e instanceof SkipFile ? e.message : `damaged: ${e?.message ?? e}`);
      }

      let best = work;
      let bestSize = report.before;
      let n = 0;
      for (const step of format.steps) {
        if (abort.signal.aborted) {
          report.status = "failed";
          report.reason = "cancelled";
          return report;
        }
        const sr: StepReport = { id: step.id, outcome: "skipped", ms: 0 };
        report.steps.push(sr);
        const why = enabled(step, format, ctx);
        if (why) {
          sr.detail = why;
          continue;
        }
        if (step.tool && !(await tools.locate(step.tool))) {
          sr.detail = `${step.tool} not available`;
          report.notes.push(`${step.id}: ${step.tool} not available`);
          continue;
        }
        const out = join(dir, `step${++n}`);
        const t0 = performance.now();
        const stepAbort = new AbortController();
        const onJobAbort = () => stepAbort.abort(new Error("cancelled"));
        abort.signal.addEventListener("abort", onJobAbort);
        const timer = setTimeout(() => stepAbort.abort(new Error(`timed out after ${settings.stepTimeout}s`)), settings.stepTimeout * 1000);
        cur = stepAbort;
        try {
          await Promise.race([
            step.run(best, out, ctx),
            new Promise<never>((_, rej) => stepAbort.signal.addEventListener("abort", () => rej(stepAbort.signal.reason ?? new Error("cancelled")), { once: true })),
          ]);
          const file = Bun.file(out);
          if (!(await file.exists())) throw new Error("wrote no output");
          sr.size = file.size;
          if (file.size >= bestSize) sr.outcome = "not smaller";
          else {
            const verdict = await format.oracle.same(prepared, out, ctx);
            if (verdict === true) {
              sr.outcome = "kept";
              best = out;
              bestSize = file.size;
            } else {
              sr.outcome = "rejected";
              sr.detail = verdict;
            }
          }
        } catch (e: any) {
          sr.outcome = "failed";
          sr.detail = stepAbort.signal.aborted ? String((stepAbort.signal.reason as Error)?.message ?? "cancelled") : String(e?.message ?? e);
          if (abort.signal.aborted) {
            report.status = "failed";
            report.reason = "cancelled";
            return report;
          }
        }
        finally {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", onJobAbort);
          cur = abort;
        }
        sr.ms = Math.round(performance.now() - t0);
      }

      if (best === work) {
        if (key) this.cache.add(key);
        return report;
      }
      report.after = bestSize;
      report.status = "optimized";
      if (o.dryRun) return report;

      // The original is replaced only if it is still what we read.
      if ((await fingerprint(path)) !== before) {
        report.status = "unchanged";
        report.after = report.before;
        report.reason = "the file changed while it was being optimized";
        return report;
      }
      const st = statSync(path);
      try {
        await Bun.write(path, Bun.file(best)); // in place: keeps permissions, hard links and the inode
      } catch (e: any) {
        try {
          await Bun.write(path, Bun.file(work));
        } catch {} // best effort to put the original back
        report.status = "failed";
        report.after = report.before;
        report.reason = `could not write the result: ${e?.message ?? e}`;
        return report;
      }
      if (settings.preserveTimestamps) utimesSync(path, st.atime, st.mtime);
      if (key) this.cache.add(Cache.key(await hashFile(path), settings));
      return report;
    } catch (e: any) {
      report.status = "failed";
      report.reason = String(e?.message ?? e);
      return report;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Optimises many files, `workers` at a time; `onResult` hears each as it finishes. */
  async optimizeMany(paths: string[], o: { dryRun?: boolean; signal?: AbortSignal; onResult?: (r: Report) => void } = {}): Promise<Report[]> {
    const n = this.settings.workers > 0 ? this.settings.workers : Math.max(1, navigator.hardwareConcurrency ?? 2);
    const out: Report[] = new Array(paths.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, paths.length) }, async () => {
        while (next < paths.length) {
          const i = next++;
          out[i] = await this.optimizeFile(paths[i], o);
          o.onResult?.(out[i]);
        }
      }),
    );
    return out;
  }
}
