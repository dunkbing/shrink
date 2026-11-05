import { basename, extname, join } from "node:path";
import { createMemo, createSignal } from "mantou-ui";
import { errorMessage, type Report, type Settings, type DeepPartial } from "@shrink/engine";
import { expand } from "./files";
import { sanitize, toEngine, readJson, writeJson, defaultSettings, type AppSettings } from "./settings";

export type ItemStatus = "queued" | "working" | "optimized" | "unchanged" | "skipped" | "failed";

export interface Item {
  path: string;
  name: string;
  format: string;
  before: number;
  after: number;
  status: ItemStatus;
  reason?: string;
}

/** The part of the engine the app uses; tests supply a fake. */
export interface Runner {
  optimizeMany(paths: string[], o: { signal: AbortSignal; onResult: (r: Report) => void }): Promise<Report[]>;
}

export interface StoreOptions {
  /** Where settings.json and results.json live. */
  dir: string;
  makeRunner(settings: DeepPartial<Settings>): Runner;
  /** Files that count as one (folders are walked); default: the real expansion. */
  expand?: (paths: string[]) => Promise<string[]>;
  /** Milliseconds results are held before being written (default 400). */
  saveDelay?: number;
}

const DONE: ItemStatus[] = ["optimized", "unchanged", "skipped", "failed"];

const STATUSES: ItemStatus[] = ["queued", "working", ...DONE];

function loadItems(file: string): Item[] {
  const v = readJson(file);
  if (!Array.isArray(v)) return [];
  const out: Item[] = [];
  for (const x of v) {
    if (typeof x !== "object" || x === null) continue;
    const o: Record<string, unknown> = { ...x };
    if (typeof o.path !== "string" || typeof o.status !== "string") continue;
    const st = STATUSES.find((s) => s === o.status);
    if (!st) continue;
    out.push({
      path: o.path,
      name: basename(o.path),
      format: typeof o.format === "string" ? o.format : "",
      before: typeof o.before === "number" ? o.before : 0,
      after: typeof o.after === "number" ? o.after : 0,
      status: st === "working" ? "queued" : st,
      reason: typeof o.reason === "string" ? o.reason : undefined,
    });
  }
  return out;
}

export function createStore(opts: StoreOptions) {
  const settingsFile = join(opts.dir, "settings.json");
  const resultsFile = join(opts.dir, "results.json");
  const [settings, setSettingsSignal] = createSignal<AppSettings>(sanitize(readJson(settingsFile)));
  const [items, setItems] = createSignal<Item[]>(loadItems(resultsFile));
  const [running, setRunning] = createSignal(false);
  /** Files finished in the current run, and how many it started with. */
  const [runDone, setRunDone] = createSignal(0);
  const [runTotal, setRunTotal] = createSignal(0);
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> = Promise.resolve();

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeJson(resultsFile, items());
  };
  const later = () => {
    timer ??= setTimeout(flush, opts.saveDelay ?? 400);
  };
  const patch = (path: string, p: Partial<Item>) => setItems((l) => l.map((i) => (i.path === path ? { ...i, ...p } : i)));

  const setSettings = (p: Partial<AppSettings>) => {
    const next = sanitize({ ...settings(), ...p });
    setSettingsSignal(next);
    writeJson(settingsFile, next);
  };

  const add = async (paths: string[]) => {
    const files = await (opts.expand ?? expand)(paths);
    const have = new Set(items().map((i) => i.path));
    const fresh = files.filter((f, n) => !have.has(f) && files.indexOf(f) === n);
    if (!fresh.length) return 0;
    setItems((l) => [...l, ...fresh.map((p): Item => ({ path: p, name: basename(p), format: extname(p).slice(1).toUpperCase(), before: 0, after: 0, status: "queued" }))]);
    later();
    return fresh.length;
  };

  const start = () => {
    if (running()) return current;
    const todo = items().filter((i) => i.status === "queued").map((i) => i.path);
    if (!todo.length) return current;
    const ctl = (abort = new AbortController());
    const runner = opts.makeRunner(toEngine(settings()));
    setRunning(true);
    setRunDone(0);
    setRunTotal(todo.length);
    // the engine takes paths in order, `workers` at a time: the next one to start follows each result
    const n = Math.min(todo.length, settings().workers > 0 ? settings().workers : Math.max(1, navigator.hardwareConcurrency ?? 2));
    let started = 0;
    const begin = () => started < todo.length && patch(todo[started++], { status: "working" });
    for (let k = 0; k < n; k++) begin();
    const onResult = (r: Report) => {
      if (r.reason === "cancelled" && ctl.signal.aborted) patch(r.path, { status: "queued", reason: undefined });
      else {
        patch(r.path, { status: r.status, format: r.format ?? "", before: r.before, after: r.after, reason: r.reason });
        setRunDone((d) => d + 1);
      }
      if (!ctl.signal.aborted) begin();
      later();
    };
    current = runner
      .optimizeMany(todo, { signal: ctl.signal, onResult })
      .then(() => undefined)
      .catch((e) => {
        for (const p of todo) setItems((l) => l.map((i) => (i.path === p && i.status === "working" ? { ...i, status: "failed", reason: errorMessage(e) } : i)));
      })
      .finally(() => {
        setItems((l) => l.map((i) => (i.status === "working" ? { ...i, status: "queued" } : i)));
        abort = null;
        setRunning(false);
        flush();
      });
    return current;
  };

  const stop = () => abort?.abort();

  /** Removes finished and queued files; the running ones stay. */
  const clear = () => {
    setItems((l) => l.filter((i) => i.status === "working"));
    flush();
  };

  const totals = createMemo(() => {
    let before = 0, saved = 0, optimized = 0;
    for (const i of items()) {
      if (i.status !== "optimized") continue;
      optimized++;
      before += i.before;
      saved += i.before - i.after;
    }
    return { before, saved, optimized };
  });

  return { settings, setSettings, items, running, runDone, runTotal, totals, add, start, stop, clear, flush, defaults: defaultSettings };
}

export type Store = ReturnType<typeof createStore>;
