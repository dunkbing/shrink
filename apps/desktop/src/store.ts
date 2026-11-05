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
  /** A dry run: the sizes are what it would be; the file is untouched. */
  dry?: boolean;
}

export type SortKey = "name" | "format" | "before" | "after" | "saved" | "status";
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

/** What a run came to, for the notification. */
export interface RunSummary {
  total: number;
  optimized: number;
  failed: number;
  saved: number;
  dry: boolean;
  cancelled: boolean;
}

/** The part of the engine the app uses; tests supply a fake. */
export interface Runner {
  optimizeMany(paths: string[], o: { dryRun?: boolean; signal: AbortSignal; onResult: (r: Report) => void }): Promise<Report[]>;
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
      dry: o.dry === true ? true : undefined,
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
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [sort, setSort] = createSignal<Sort | null>(null);
  const finishers: ((s: RunSummary) => void)[] = [];
  let anchor: string | null = null;
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

  // one add at a time, so the same file arriving twice (drop and launch) is listed once
  let adding: Promise<number> = Promise.resolve(0);
  const add = (paths: string[]): Promise<number> => (adding = adding.then(() => addNow(paths)));
  const addNow = async (paths: string[]) => {
    const files = await (opts.expand ?? expand)(paths);
    const have = new Set(items().map((i) => i.path));
    const fresh = files.filter((f, n) => !have.has(f) && files.indexOf(f) === n);
    if (!fresh.length) return 0;
    setItems((l) => [...l, ...fresh.map((p): Item => ({ path: p, name: basename(p), format: extname(p).slice(1).toUpperCase(), before: 0, after: 0, status: "queued" }))]);
    later();
    return fresh.length;
  };

  const rank = (i: Item, k: SortKey) => (k === "saved" ? (i.status === "optimized" && i.before ? 1 - i.after / i.before : -1) : i[k]);
  /** The list as shown: in the chosen order (stable; the arrival order when none). */
  const sorted = createMemo(() => {
    const s = sort();
    if (!s) return items();
    return [...items()].sort((a, b) => {
      const x = rank(a, s.key), y = rank(b, s.key);
      return (typeof x === "string" && typeof y === "string" ? x.localeCompare(y, undefined, { numeric: true }) : Number(x) - Number(y)) * s.dir;
    });
  });
  /** Clicking a column: ascending, then descending, then the original order. */
  const sortBy = (key: SortKey) =>
    setSort((s) => (s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));

  /** A click on a row: alone, toggling (ctrl/cmd) or extending from the last one (shift). */
  const select = (path: string, how: "one" | "toggle" | "range" = "one") => {
    const list = sorted().map((i) => i.path);
    if (how === "range" && anchor && list.includes(anchor)) {
      const a = list.indexOf(anchor), b = list.indexOf(path);
      setSelected(new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1)));
      return;
    }
    anchor = path;
    if (how === "toggle") setSelected((s) => (s.has(path) ? new Set([...s].filter((p) => p !== path)) : new Set([...s, path])));
    else setSelected(new Set([path]));
  };
  const selectAll = () => setSelected(new Set(items().map((i) => i.path)));

  /** Drops files from the list (the ones being worked on stay). */
  const remove = (paths: string[]) => {
    const gone = new Set(paths);
    setItems((l) => l.filter((i) => !gone.has(i.path) || i.status === "working"));
    setSelected((s) => new Set([...s].filter((p) => !gone.has(p) || items().some((i) => i.path === p))));
    flush();
  };
  const removeSelected = () => remove([...selected()]);

  /** Puts finished files back in the queue (and starts, unless a run is on). */
  const again = (paths: string[]) => {
    const set = new Set(paths);
    setItems((l) => l.map((i) => (set.has(i.path) && i.status !== "working" ? { ...i, status: "queued", reason: undefined } : i)));
    later();
    return start();
  };

  const start = () => {
    if (running()) return current;
    const todo = items().filter((i) => i.status === "queued").map((i) => i.path);
    if (!todo.length) return current;
    const dry = settings().dryRun;
    let cancelled = false;
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
        patch(r.path, { dry: dry && r.status === "optimized" ? true : undefined, status: r.status, format: r.format ?? "", before: r.before, after: r.after, reason: r.reason });
        setRunDone((d) => d + 1);
      }
      if (!ctl.signal.aborted) begin();
      later();
    };
    current = runner
      .optimizeMany(todo, { dryRun: dry, signal: ctl.signal, onResult })
      .then(() => undefined)
      .catch((e) => {
        for (const p of todo) setItems((l) => l.map((i) => (i.path === p && i.status === "working" ? { ...i, status: "failed", reason: errorMessage(e) } : i)));
      })
      .finally(() => {
        setItems((l) => l.map((i) => (i.status === "working" ? { ...i, status: "queued" } : i)));
        cancelled = ctl.signal.aborted;
        abort = null;
        setRunning(false);
        flush();
        const done = todo.map((p) => items().find((i) => i.path === p)).filter((i): i is Item => !!i);
        const ok = done.filter((i) => i.status === "optimized");
        finishers.forEach((f) => f({ total: todo.length, optimized: ok.length, failed: done.filter((i) => i.status === "failed").length, saved: ok.reduce((n, i) => n + i.before - i.after, 0), dry, cancelled }));
      });
    return current;
  };

  const stop = () => abort?.abort();

  /** Removes finished and queued files; the running ones stay. */
  const clear = () => {
    setItems((l) => l.filter((i) => i.status === "working"));
    setSelected(new Set<string>());
    flush();
  };

  const totals = createMemo(() => {
    let before = 0, saved = 0, optimized = 0;
    for (const i of items()) {
      if (i.status !== "optimized" || i.dry) continue;
      optimized++;
      before += i.before;
      saved += i.before - i.after;
    }
    return { before, saved, optimized };
  });
  /** What the dry-run files would save. */
  const drySaved = createMemo(() => items().reduce((n, i) => (i.dry && i.status === "optimized" ? n + i.before - i.after : n), 0));
  /** Files waiting or being worked on (the dock badge). */
  const pending = createMemo(() => items().filter((i) => i.status === "queued" || i.status === "working").length);

  const onFinish = (f: (s: RunSummary) => void) => void finishers.push(f);

  return { settings, setSettings, items, sorted, sort, sortBy, selected, select, selectAll, remove, removeSelected, again, onFinish, drySaved, pending, running, runDone, runTotal, totals, add, start, stop, clear, flush, defaults: defaultSettings };
}

export type Store = ReturnType<typeof createStore>;
