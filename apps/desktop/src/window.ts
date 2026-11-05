import { join } from "node:path";
import { paths, win } from "mantou-ui";
import { readJson, writeJson } from "./settings";

const file = () => join(paths.config, "window.json");

/** The size and position the window had when the app last ran (published mantou-ui has no restoreState yet, mantou#75). */
export function loadWindow(): { width: number; height: number; x?: number; y?: number } {
  const v = readJson(file());
  const o: Record<string, unknown> = typeof v === "object" && v !== null ? { ...v } : {};
  const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
  const width = n("width"), height = n("height"), x = n("x"), y = n("y");
  return { width: width && width >= 600 ? width : 1000, height: height && height >= 400 ? height : 640, ...(x !== undefined && y !== undefined ? { x, y } : {}) };
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Saves the window's box a moment after it stops changing. */
export function rememberWindow() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    const w = await win.state();
    if (w && !w.maximized && !w.fullscreen && !w.minimized) writeJson(file(), { width: w.width, height: w.height, x: w.x, y: w.y });
  }, 500);
}
