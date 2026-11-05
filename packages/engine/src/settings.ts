import type { DeepPartial, Settings } from "./types";

export const defaults: Settings = {
  level: 5,
  workers: 0,
  preserveTimestamps: true,
  lowPriority: true,
  skipOptimized: true,
  include: null,
  exclude: null,
  disabledTools: null,
  toolPaths: null,
  stepTimeout: 300,
  jpeg: { lossy: false, keepMetadata: false, arithmetic: false },
  png: { lossy: false, keepMetadata: false },
  gif: { lossy: false, keepMetadata: false },
  webp: { lossy: false, keepMetadata: false },
  tiff: { keepMetadata: false },
  bmp: { keepMetadata: false },
  pdf: { profile: "none", dpi: 150, skipLayered: false },
  audio: { keepMetadata: false, trimSilence: false },
  video: { keepMetadata: false },
  archive: { keepMetadata: false, recurse: false },
  web: { html: false, css: false, js: false, svg: true, jsExtensions: null },
  exe: { enabled: false, upx: false },
  lua: { minify: false },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(base: unknown, over: unknown): unknown {
  if (!isObject(over)) return over === undefined ? base : over;
  const b: Record<string, unknown> = isObject(base) ? base : {};
  const out: Record<string, unknown> = { ...b };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(b[k]) ? merge(b[k], v) : v === undefined ? b[k] : v;
  return out;
}

/** The defaults with `over` laid on top (nested objects merge). */
export function resolve(over: DeepPartial<Settings> = {}): Settings {
  const s = merge(defaults, over) as Settings; // `over` is a DeepPartial<Settings> laid over a full Settings
  s.level = Math.min(9, Math.max(1, Math.round(s.level)));
  return s;
}
