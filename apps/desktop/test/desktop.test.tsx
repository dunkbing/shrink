import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachShell, summaryText, type Shell } from "../src/shell";
import { byLabel, fakeRunner, hasCore, report, setup, until } from "./harness";

const fixture = fileURLToPath(new URL("./fixtures/launch.ts", import.meta.url));
const preload = fileURLToPath(import.meta.resolve("mantou-ui/preload"));
const open: (() => unknown)[] = [];
afterEach(() => open.splice(0).forEach((f) => f()));
const app = (...a: Parameters<typeof setup>) => {
  const s = setup(...a);
  open.push(s.done);
  return s;
};

/** A shell that records what the app asked of the desktop. */
function fakeShell() {
  const calls: string[] = [];
  const shell: Shell = {
    notify: async (o) => (calls.push(`notify:${o.title}|${o.body}`), true),
    setBadge: async (n) => (calls.push(`badge:${n}`), true),
    createTray: async (o) => (calls.push(`tray:${o.menu.map((m) => m.label ?? "-").join(",")}`), true),
    removeTray: async () => true,
    launchAtLogin: { get: async () => false, set: async (on) => (calls.push(`login:${on}`), true) },
  };
  return { calls, shell };
}

const paths3 = ["/x/b.png", "/x/a.png", "/x/c.png"];
const rowAt = (h: ReturnType<typeof setup>["h"], label: string) => h.center(byLabel(h, label));

describe.skipIf(!hasCore)("desktop behaviour", () => {
  test("rows select by click, ctrl and shift; Cmd/Ctrl+A selects all; Delete removes", async () => {
    const { h, store } = app();
    await store.add(paths3);
    h.step();
    h.press(rowAt(h, "b.png: Queued"));
    expect([...store.selected()]).toEqual(["/x/b.png"]);
    h.press(byLabel(h, "c.png: Queued"));
    expect([...store.selected()]).toEqual(["/x/c.png"]);
    h.press(byLabel(h, "a.png: Queued"));
    h.key("Delete");
    expect(store.items().map((i) => i.name)).toEqual(["b.png", "c.png"]);
    expect(store.selected().size).toBe(0);
    h.key("a", { primary: true });
    expect(store.selected().size).toBe(2);
    h.key("Delete");
    expect(store.items()).toHaveLength(0);
  });

  test("shift extends and ctrl toggles the selection", async () => {
    const { store } = app();
    await store.add(["/x/1", "/x/2", "/x/3", "/x/4"]);
    store.select("/x/2");
    store.select("/x/4", "range");
    expect([...store.selected()]).toEqual(["/x/2", "/x/3", "/x/4"]);
    store.select("/x/3", "toggle");
    expect([...store.selected()]).toEqual(["/x/2", "/x/4"]);
  });

  test("columns sort: ascending, descending, then the original order", async () => {
    const { h, store } = app();
    await store.add(paths3);
    h.step();
    const names = () => store.sorted().map((i) => i.name);
    h.press(byLabel(h, "Sort by Name"));
    expect(names()).toEqual(["a.png", "b.png", "c.png"]);
    h.press(byLabel(h, "Sort by Name"));
    expect(names()).toEqual(["c.png", "b.png", "a.png"]);
    h.press(byLabel(h, "Sort by Name"));
    expect(names()).toEqual(["b.png", "a.png", "c.png"]);
  });

  test("sorting by saved and before uses the numbers", async () => {
    const run = fakeRunner((p) => report(p, { before: p.endsWith("a.png") ? 100 : 1000, after: p.endsWith("c.png") ? 100 : 900 }));
    const { store } = app({ makeRunner: run.make });
    await store.add(paths3);
    await store.start();
    store.sortBy("saved");
    expect(store.sorted().map((i) => i.name)).toEqual(["a.png", "b.png", "c.png"]); // 10%, 10%, 90%: stable
    store.sortBy("before");
    expect(store.sorted().map((i) => i.name)[0]).toBe("a.png");
  });

  test("right-click offers the file menu; each choice does its job", async () => {
    const run = fakeRunner((p) => report(p));
    const { h, store } = app({ makeRunner: run.make });
    await store.add(["/x/a.png", "/x/b.png"]);
    await store.start();
    h.step();
    const menu = async (choice: string | null, label = "a.png: Optimized") => {
      h.answer(choice);
      const [x, y] = rowAt(h, label);
      h.pointerButton("down", 2, x, y).pointerButton("up", 2, x, y);
      await until(h, () => h.lastService()?.kind === "showMenu" || h.lastService()?.kind === "reveal" || h.lastService()?.kind === "clipboardWrite");
    };
    await menu("reveal");
    const sent = JSON.stringify(h.lastService());
    expect(sent).toContain("/x/a.png"); // reveal's request
    expect(store.selected().has("/x/a.png")).toBe(true);

    await menu("copy");
    await until(h, () => h.clipboard === "/x/a.png");

    await menu("again");
    await until(h, () => store.items()[0].status === "optimized" && !store.running());
    expect(run.seen).toHaveLength(2); // a second run
    await menu("remove", "a.png: Optimized");
    await until(h, () => store.items().length === 1);
    expect(store.items()[0].name).toBe("b.png");
  });

  test("the menu lists the four choices", async () => {
    const { h, store } = app();
    await store.add(["/x/a.png"]);
    h.step();
    const [x, y] = rowAt(h, "a.png: Queued");
    h.answer(null).pointerButton("down", 2, x, y).pointerButton("up", 2, x, y);
    await until(h, () => h.lastService()?.kind === "showMenu");
    const labels = (h.lastService()!.items as { label?: string }[]).map((i) => i.label).filter(Boolean);
    expect(labels).toEqual(["Reveal in folder", "Copy path", "Optimize this file again", "Remove from list"]);
  });

  test("dry run reaches the engine, keeps the files out of the totals and can be run again", async () => {
    const dry: (boolean | undefined)[] = [];
    const make = () => ({
      optimizeMany: async (ps: string[], o: { dryRun?: boolean; onResult: (r: ReturnType<typeof report>) => void }) => (dry.push(o.dryRun), ps.map((p) => (o.onResult(report(p)), report(p)))),
    });
    const { h, store } = app({ makeRunner: make });
    store.setSettings({ dryRun: true });
    await store.add(["/x/a.png"]);
    await store.start();
    expect(dry).toEqual([true]);
    expect(store.items()[0]).toMatchObject({ status: "optimized", dry: true });
    expect(store.totals().saved).toBe(0);
    expect(store.drySaved()).toBe(400);
    store.setSettings({ dryRun: false });
    await store.again(["/x/a.png"]);
    expect(dry).toEqual([true, false]);
    expect(store.totals().saved).toBe(400);
    h.step();
  });

  test("Cmd/Ctrl+O asks for files and adds them", async () => {
    const { h, store } = app();
    h.answer(["/x/z.png"]).key("o", { primary: true });
    await until(h, () => store.items().length === 1);
    expect(h.lastService()?.kind).toBe("openFile");
  });

  test("the badge follows the queue; a notification says what was saved, and a setting turns it off", async () => {
    const run = fakeRunner();
    const { h, store } = app({ makeRunner: run.make });
    const { calls, shell } = fakeShell();
    attachShell(store, shell, { icon: "i.svg" });
    await store.add(["/x/a.png", "/x/b.png"]);
    const p = store.start();
    run.finish("/x/a.png", report("/x/a.png", { before: 3000, after: 1000 }));
    run.finish("/x/b.png", report("/x/b.png", { status: "failed", reason: "damaged", after: 1000 }));
    await p;
    expect(calls.filter((c) => c.startsWith("badge:"))).toEqual(["badge:0", "badge:2", "badge:1", "badge:0"]);
    expect(calls).toContain("notify:Optimization finished with failures|Saved 2.0 KB in 1 file, 1 failed");
    store.setSettings({ notifications: false });
    await store.add(["/x/c.png"]);
    const q = store.start();
    run.finish("/x/c.png");
    await q;
    expect(calls.filter((c) => c.startsWith("notify:"))).toHaveLength(1);
    h.step();
  });

  test("a run where everything failed says so", () => {
    expect(summaryText({ total: 2, optimized: 0, failed: 2, saved: 0, dry: false, cancelled: false })).toEqual({ title: "Optimization failed", body: "2 files failed" });
    expect(summaryText({ total: 1, optimized: 1, failed: 0, saved: 2048, dry: true, cancelled: false }).body).toBe("Would save 2.0 KB in 1 file");
  });

  test("the tray menu drives the app; closing goes to the tray only when asked", async () => {
    const run = fakeRunner();
    const { h, store } = app({ makeRunner: run.make });
    const { calls, shell } = fakeShell();
    const sh = attachShell(store, shell, { icon: "i.svg" });
    await until(h, () => calls.some((c) => c.startsWith("tray:")));
    expect(calls).toContain("tray:Show window,Start,Stop,-,undefined".replace("undefined", "-"));
    await store.add(["/x/a.png"]);
    expect(sh.menu("tray-start")).toBe(true);
    await until(h, () => store.running());
    sh.menu("tray-stop");
    await until(h, () => !store.running());
    expect(sh.menu("tray-show")).toBe(true); // restore: un-minimize, then focus
    await until(h, () => h.lastService()?.kind === "window" && h.lastService()?.op === "focus");
    expect(sh.menu("other")).toBe(false);
    expect(sh.closeRequested()).toBe("quit");
    store.setSettings({ closeToTray: true });
    expect(sh.closeRequested()).toBe("hidden");
    expect(h.lastService()).toMatchObject({ kind: "window", op: "minimize" });
  });

  test("launch at login follows the setting", async () => {
    const { store } = app();
    const { calls, shell } = fakeShell();
    attachShell(store, shell, { icon: "i.svg" });
    store.setSettings({ launchAtLogin: true });
    store.setSettings({ launchAtLogin: false });
    expect(calls.filter((c) => c.startsWith("login:"))).toEqual(["login:false", "login:true", "login:false"]);
  });

  // real processes: the first launch's argument, then a second launch (other cwd, relative path, a flag) handed over the socket
  test("launch files are added: the first launch's and a second launch's", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "shrink-inst-"));
    open.push(() => rmSync(tmp, { recursive: true, force: true }));
    const cwd = join(tmp, "work");
    mkdirSync(cwd);
    writeFileSync(join(tmp, "a.png"), "x");
    writeFileSync(join(cwd, "b.png"), "x");
    const [a, b] = [realpathSync(join(tmp, "a.png")), realpathSync(join(cwd, "b.png"))]; // macOS cwd is the real path
    const env = { ...process.env, MANTOU_APP: `shrink-test-${process.pid}`, MANTOU_TEMP: tmp };
    const start = (dir: string, ...args: string[]) => {
      const p = Bun.spawn(["bun", "--preload", preload, fixture, ...args], { cwd: dir, env, stdin: "pipe", stdout: "pipe" });
      const out = { text: "" };
      void (async () => {
        for await (const c of p.stdout) out.text += new TextDecoder().decode(c);
      })();
      open.push(() => p.kill());
      return Object.assign(p, { out });
    };
    const until = async (p: { out: { text: string } }, what: string) => {
      for (let i = 0; i < 400 && !p.out.text.includes(what); i++) await Bun.sleep(50);
      return p.out.text;
    };
    const first = start(tmp, a);
    expect(await until(first, "added " + a)).toContain("added " + a);
    const second = start(cwd, "b.png", "--flag");
    expect(await second.exited).toBe(0);
    expect(await until(first, "added " + b)).toContain("added " + b);
    first.stdin.write("x");
    await first.exited;
  }, 30000);
});
