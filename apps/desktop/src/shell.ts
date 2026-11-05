// The desktop around the window: tray, dock badge, notifications, launch at login, closing. The store drives it; tests give a fake Shell.
import { createEffect, createRoot, createSignal, launchAtLogin, notify, removeTray, createTray, setBadge, win, type MenuItem } from "mantou-ui";
import { size } from "./files";
import type { RunSummary, Store } from "./store";

export interface Shell {
  notify(o: { title: string; body?: string }): Promise<boolean>;
  setBadge(n: number): Promise<boolean>;
  createTray(o: { icon: string; tooltip: string; menu: MenuItem[] }): Promise<boolean>;
  removeTray(): Promise<boolean>;
  launchAtLogin: { get(): Promise<boolean>; set(on: boolean): Promise<boolean> };
}

export const realShell: Shell = { notify, setBadge, createTray, removeTray, launchAtLogin };

export const trayMenu: MenuItem[] = [
  { id: "tray-show", label: "Show window" },
  { id: "tray-start", label: "Start" },
  { id: "tray-stop", label: "Stop" },
  { separator: true },
  { role: "quit" },
];

/** The text of the end-of-run notification. */
export function summaryText(s: RunSummary): { title: string; body: string } {
  const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  if (s.failed && !s.optimized) return { title: "Optimization failed", body: `${files(s.failed)} failed` };
  const verb = s.dry ? "Would save" : "Saved";
  const title = s.cancelled ? "Optimization stopped" : s.failed ? "Optimization finished with failures" : "Optimization finished";
  return { title, body: `${verb} ${size(s.saved)} in ${files(s.optimized)}${s.failed ? `, ${s.failed} failed` : ""}` };
}

/** Wires the store to the shell; returns what to call to stop. */
export function attachShell(store: Store, shell: Shell, o: { icon: string }) {
  const [tray, setTray] = createSignal(false);
  const dispose = createRoot((off) => {
    createEffect(() => void shell.setBadge(store.pending()));
    // the tray lives as long as the app: the close-to-tray choice only changes what closing does
    void shell.createTray({ icon: o.icon, tooltip: "Shrink", menu: trayMenu }).then(setTray);
    let last: boolean | null = null;
    createEffect(() => {
      const on = store.settings().launchAtLogin;
      if (on !== last) void shell.launchAtLogin.set(on);
      last = on;
    });
    return off;
  });
  store.onFinish((s) => {
    if (!store.settings().notifications || (!s.optimized && !s.failed)) return;
    void shell.notify(summaryText(s));
  });
  return {
    dispose,
    /** A window close request: hide into the tray, or tell the caller to quit. */
    closeRequested(): "hidden" | "quit" {
      if (store.settings().closeToTray && tray()) return void win.minimize(), "hidden";
      return "quit";
    },
    /** Tray menu items; true when it was one. */
    menu(id: string): boolean {
      if (id === "tray-show") void win.focus();
      else if (id === "tray-start") void store.start();
      else if (id === "tray-stop") store.stop();
      else return false;
      return true;
    },
  };
}
