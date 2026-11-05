import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStore } from "../src/store";
import { byLabel, byText, fakeRunner, hasCore, report, setup, texts, until } from "./harness";

const open: (() => unknown)[] = [];
afterEach(() => open.splice(0).forEach((f) => f()));
const app = (...a: Parameters<typeof setup>) => {
  const s = setup(...a);
  open.push(s.done);
  return s;
};

describe.skipIf(!hasCore)("the app", () => {
  test("dropping files lists them; Start optimizes and shows the results and the total saved", async () => {
    const run = fakeRunner();
    const { h, store } = app({ makeRunner: run.make });
    expect(texts(h)).toContain("Drop files or folders here");
    h.hover([300, 300]).dropFiles("drop", ["/tmp/a.png", "/tmp/b.jpg"]);
    await until(h, () => store.items().length === 2);
    expect(texts(h)).toContain("a.png");
    expect(texts(h).filter((t) => t === "Queued")).toHaveLength(2);

    h.press(byText(h, "Start"));
    await until(h, () => store.running());
    expect(store.items().every((i) => i.status === "working")).toBe(true); // 2 files, at least 2 workers
    run.finish("/tmp/a.png", report("/tmp/a.png", { before: 2048, after: 1024 }));
    run.finish("/tmp/b.jpg", report("/tmp/b.jpg", { status: "skipped", reason: "unsupported format", format: "", after: 1000 }));
    await until(h, () => !store.running());
    const t = texts(h);
    expect(t).toContain("Optimized");
    expect(t).toContain("50.0%");
    expect(t).toContain("1.0 KB"); // after
    expect(t).toContain("Skipped: unsupported format");
    expect(t).toContain("Saved 1.0 KB (50.0%)");
    expect(t).toContain("Start");
  });

  test("folders are expanded, dropped paths are not added twice", async () => {
    const { h, store } = app({ expand: async (p) => p.flatMap((x) => (x === "/pics" ? ["/pics/1.png", "/pics/2.png"] : [x])) });
    h.hover([300, 300]).dropFiles("drop", ["/pics"]);
    await until(h, () => store.items().length === 2);
    h.dropFiles("drop", ["/pics/1.png", "/other.gif"]);
    await until(h, () => store.items().length === 3);
    expect(store.items().map((i) => i.name)).toEqual(["1.png", "2.png", "other.gif"]);
  });

  test("Stop cancels the run and the unfinished files go back to queued", async () => {
    const run = fakeRunner();
    const { h, store } = app({ makeRunner: run.make });
    await store.add(["/x/a.png", "/x/b.png", "/x/c.png"]);
    h.step();
    h.press(byText(h, "Start"));
    await until(h, () => store.running());
    run.finish("/x/a.png");
    await until(h, () => store.items()[0].status === "optimized");
    expect(texts(h)).toContain("Stop");
    h.press(byText(h, "Stop"));
    await until(h, () => !store.running());
    expect(store.items().map((i) => i.status)).toEqual(["optimized", "queued", "queued"]);
    expect(texts(h)).toContain("Start");
    // Start again picks up only what is left
    h.press(byText(h, "Start"));
    await until(h, () => store.running());
    expect(store.runTotal()).toBe(2);
  });

  test("settings are applied to the engine and persist across restarts", async () => {
    const run = fakeRunner((p) => report(p));
    const { h, store, dir } = app({ makeRunner: run.make });
    h.press(byText(h, "Allow lossy"));
    h.press(byText(h, "Dry run"));
    const [x0, y0, x1, y1] = h.rect(byLabel(h, "Level"))!;
    h.press([x0 + 8 + (7 / 8) * (x1 - x0 - 16), (y0 + y1) / 2]); // the 8th of 9 steps
    expect(store.settings()).toMatchObject({ lossy: true, dryRun: true, level: 8 });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toMatchObject({ lossy: true, dryRun: true, level: 8 });
    await store.add(["/x/a.png"]);
    await store.start();
    expect(run.seen[0]).toMatchObject({ level: 8, png: { lossy: true, keepMetadata: false }, exe: { enabled: false }, web: { html: false } });

    const again = createStore({ dir, makeRunner: run.make, saveDelay: 5 });
    expect(again.settings()).toMatchObject({ lossy: true, dryRun: true, level: 8 });
  });

  test("results are kept after a restart; a run that was interrupted comes back queued", async () => {
    const run = fakeRunner((p) => (p.endsWith("a.png") ? report(p, { before: 4000, after: 1000 }) : report(p, { status: "failed", reason: "damaged", after: 1000 })));
    const { store, dir } = app({ makeRunner: run.make });
    await store.add(["/x/a.png", "/x/b.png"]);
    await store.start();
    const pending = fakeRunner();
    const second = createStore({ dir, makeRunner: pending.make, expand: async (p) => p, saveDelay: 5 });
    expect(second.items().map((i) => [i.name, i.status, i.after])).toEqual([["a.png", "optimized", 1000], ["b.png", "failed", 1000]]);
    expect(second.totals().saved).toBe(3000);
    await second.add(["/x/c.png"]);
    void second.start();
    second.flush(); // as if the app died with c.png working
    const third = createStore({ dir, makeRunner: pending.make, saveDelay: 5 });
    expect(third.items().map((i) => i.status)).toEqual(["optimized", "failed", "queued"]);
    second.stop();
  });

  test("the tools tab lists the tools and how many are ready", async () => {
    const { h } = app();
    h.press(byText(h, "Tools"));
    await until(h, () => texts(h).some((t) => /\d+ of \d+ ready/.test(t)));
    expect(texts(h)).toContain("oxipng");
  });
});
