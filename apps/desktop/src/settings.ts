import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeepPartial, Settings } from "@shrink/engine";

/** What the settings panel edits; the engine's settings are derived from it. */
export interface AppSettings {
  level: number;
  lossy: boolean;
  keepMetadata: boolean;
  /** 0 = one per CPU core. */
  workers: number;
  skipOptimized: boolean;
  /** The formats that are off unless asked for. */
  html: boolean;
  css: boolean;
  js: boolean;
  exe: boolean;
  lua: boolean;
  /** Optimize without writing: only report the sizes. */
  dryRun: boolean;
  /** A notification when a run ends. */
  notifications: boolean;
  /** Closing the window keeps the app in the tray. */
  closeToTray: boolean;
  launchAtLogin: boolean;
}

export const defaultSettings: AppSettings = {
  level: 5,
  lossy: false,
  keepMetadata: false,
  workers: 0,
  skipOptimized: true,
  html: false,
  css: false,
  js: false,
  exe: false,
  lua: false,
  dryRun: false,
  notifications: true,
  closeToTray: false,
  launchAtLogin: false,
};

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** Any JSON becomes valid settings: unknown or wrong-typed fields fall back to the defaults. */
export function sanitize(v: unknown): AppSettings {
  const o: Record<string, unknown> = typeof v === "object" && v !== null ? { ...v } : {};
  const d = defaultSettings;
  return {
    level: int(o.level, d.level, 1, 9),
    lossy: bool(o.lossy, d.lossy),
    keepMetadata: bool(o.keepMetadata, d.keepMetadata),
    workers: int(o.workers, d.workers, 0, 32),
    skipOptimized: bool(o.skipOptimized, d.skipOptimized),
    html: bool(o.html, d.html),
    css: bool(o.css, d.css),
    js: bool(o.js, d.js),
    exe: bool(o.exe, d.exe),
    lua: bool(o.lua, d.lua),
    dryRun: bool(o.dryRun, d.dryRun),
    notifications: bool(o.notifications, d.notifications),
    closeToTray: bool(o.closeToTray, d.closeToTray),
    launchAtLogin: bool(o.launchAtLogin, d.launchAtLogin),
  };
}

/** The engine's settings for these choices. */
export function toEngine(s: AppSettings): DeepPartial<Settings> {
  const keep = { keepMetadata: s.keepMetadata };
  const lossy = { ...keep, lossy: s.lossy };
  return {
    level: s.level,
    workers: s.workers,
    skipOptimized: s.skipOptimized,
    jpeg: lossy,
    png: lossy,
    gif: lossy,
    webp: lossy,
    tiff: keep,
    bmp: keep,
    audio: keep,
    video: keep,
    archive: keep,
    web: { html: s.html, css: s.css, js: s.js },
    exe: { enabled: s.exe },
    lua: { minify: s.lua },
  };
}

/** Reads a JSON file; null when it is missing or broken. */
export function readJson(file: string): unknown {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

/** Writes through a temporary file so a crash never leaves half a file. */
export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}
