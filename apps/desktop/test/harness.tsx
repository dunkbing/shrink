import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mount } from "mantou-ui";
import { HeadlessCore } from "mantou-ui/headless";
import type { Report } from "@shrink/engine";
import { App } from "../src/App";
import { createStore, type Runner, type StoreOptions } from "../src/store";

/** True when the native core can open a headless instance on this machine. */
export const hasCore = (() => {
  try {
    new HeadlessCore().free();
    return true;
  } catch {
    return false;
  }
})();

export const report = (path: string, o: Partial<Report> = {}): Report => ({ path, status: "optimized", before: 1000, after: 600, steps: [], notes: [], format: "png", ...o });

/** A runner that finishes each file when the test says so (or at once, with `auto`). */
export function fakeRunner(auto?: (path: string) => Report) {
  const waiting = new Map<string, (r: Report) => void>();
  const seen: unknown[] = [];
  const make = (settings: unknown): Runner => {
    seen.push(settings);
    return {
      async optimizeMany(paths, o) {
        const out = await Promise.all(
          paths.map(
            (p) =>
              new Promise<Report>((done) => {
                let settled = false;
                const finish = (r: Report) => (settled ? 0 : ((settled = true), o.onResult(r), done(r)));
                o.signal.addEventListener("abort", () => finish(report(p, { status: "failed", reason: "cancelled", after: 1000 })), { once: true });
                if (auto) queueMicrotask(() => finish(auto(p)));
                else waiting.set(p, finish);
              }),
          ),
        );
        return out;
      },
    };
  };
  return { make, seen, finish: (p: string, r: Report = report(p)) => waiting.get(p)?.(r), waiting };
}

export function setup(over: Partial<StoreOptions> = {}, dir?: string) {
  const own = dir ?? mkdtempSync(join(tmpdir(), "shrink-app-"));
  const store = createStore({ dir: own, makeRunner: () => ({ optimizeMany: async () => [] }), expand: async (p) => p, saveDelay: 5, ...over });
  const h = new HeadlessCore({ width: 1000, height: 640 });
  mount(h.ui, () => <App store={store} />);
  h.step();
  return { h, store, dir: own, done: () => (h.free(), dir ? 0 : rmSync(own, { recursive: true, force: true })) };
}

export const texts = (h: HeadlessCore) => [...h.ui.nodes.values()].filter((n) => n.isText).map((n) => n.textContent);

export const byText = (h: HeadlessCore, text: string) => {
  const n = [...h.ui.nodes.values()].find((x) => x.isText && x.textContent === text);
  if (!n) throw new Error(`no text "${text}" in: ${texts(h).join(" | ")}`);
  return n;
};

/** Steps until `cond` holds (async work in the app finishes between steps). */
export async function until(h: HeadlessCore, cond: () => boolean) {
  for (let i = 0; i < 200; i++) {
    h.step();
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met");
}

/** The node a screen reader would call `label` (the app's custom controls name themselves). */
export const byLabel = (h: HeadlessCore, label: string) => {
  const n = [...h.ui.nodes.values()].find((x) => (x as unknown as { acc?: { label?: string } }).acc?.label === label);
  if (!n) throw new Error(`no node labelled "${label}"`);
  return n;
};
