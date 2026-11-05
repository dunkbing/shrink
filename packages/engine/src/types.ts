export interface Settings {
  /** 1 (fast) to 9 (extreme). */
  level: number;
  /** Files processed at once; 0 = one per CPU core. */
  workers: number;
  preserveTimestamps: boolean;
  lowPriority: boolean;
  skipOptimized: boolean;
  include: string[] | null;
  exclude: string[] | null;
  disabledTools: string[] | null;
  /** Command used to run a tool, e.g. `{ pngout: ["wine", "pngout.exe"] }`. */
  toolPaths: Record<string, string[]> | null;
  /** Seconds a single step may run. */
  stepTimeout: number;
  /** What a `lossy` step has to prove: similarity (SSIM, 0 to 1) of pictures and of rendered PDF pages, and the least share it must save. */
  lossy: { ssim: number; pdfSsim: number; minSaving: number };
  jpeg: { lossy: boolean; keepMetadata: boolean; arithmetic: boolean };
  png: { lossy: boolean; keepMetadata: boolean };
  gif: { lossy: boolean; keepMetadata: boolean };
  webp: { lossy: boolean; keepMetadata: boolean };
  tiff: { keepMetadata: boolean };
  bmp: { keepMetadata: boolean };
  pdf: { profile: "none" | "screen" | "ebook" | "printer" | "prepress" | "custom"; dpi: number; skipLayered: boolean };
  audio: { keepMetadata: boolean; trimSilence: boolean };
  video: { keepMetadata: boolean };
  archive: { keepMetadata: boolean; recurse: boolean };
  web: { html: boolean; css: boolean; js: boolean; svg: boolean; jsExtensions: string[] | null };
  exe: { enabled: boolean; upx: boolean };
  lua: { minify: boolean };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/** What a step can see while it runs. */
export interface Context {
  settings: Settings;
  level: number;
  /** The file being optimised (the original path; never written by steps). */
  original: string;
  /** The format's id. */
  format: string;
  /** A private folder for this job. */
  dir: string;
  signal: AbortSignal;
  tools: Tools;
  /** Runs a tool by name (its configured command first); rejects if it is missing, fails, times out or is cancelled. */
  run(tool: string, args: string[], opts?: { cwd?: string }): Promise<RunResult>;
  note(message: string): void;
  /** Things the format learned about this file (set while reading it, read by steps): `protected` means keep metadata. */
  facts: Record<string, unknown>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Tools {
  /** The command that runs a tool, or null when it isn't available. */
  locate(name: string): Promise<string[] | null>;
}

export interface Step {
  /** "png.oxipng" */
  id: string;
  /** The external tool this step needs, if any: it is skipped (with a note) when it can't be found or is disabled. */
  tool?: string;
  /** Can change decoded content: runs only when the format's `lossy` setting is on. */
  lossy?: boolean;
  /** For a lossy step: the least share it must save (default `settings.lossy.minSaving`); 0 when the point is the change itself, as with trimming silence. */
  minSaving?: number;
  /** Drops metadata: runs only when metadata is not kept. */
  strip?: boolean;
  /** Runs only at this level or above. */
  minLevel?: number;
  /** false, or a reason string, to skip. */
  when?(ctx: Context): boolean | string;
  /** Reads `input`, writes the candidate to `output`. */
  run(input: string, output: string, ctx: Context): Promise<void>;
}

/** Proves a candidate holds the same content as the original. */
export interface Oracle {
  /** Reads the original once. Throws if it is damaged or can't be understood. */
  prepare?(path: string, ctx: Context): Promise<unknown>;
  /** true, or why the candidate differs. */
  same(original: unknown, candidate: string, ctx: Context): Promise<true | string>;
  /** For results of `lossy` steps: true if the candidate is similar enough (SSIM floor from the settings; size, orientation, ICC, alpha kept), or why not. */
  similar?(original: unknown, candidate: string, ctx: Context): Promise<true | string>;
}

export interface Format {
  id: string;
  /** Does the content (its first bytes, and the file name) look like this format? */
  detect(head: Uint8Array, name: string): boolean;
  /** `lossy` / `keepMetadata` settings of this format. */
  flags?(settings: Settings): { lossy?: boolean; keepMetadata?: boolean };
  /** A reason to leave the file alone before any step runs. */
  skip?(path: string, head: Uint8Array, ctx: Context): Promise<string | null>;
  steps: Step[];
  oracle: Oracle;
  /** Returns the format as it is for these settings (e.g. with extra extensions); the engine calls it once. */
  configure?(settings: Settings): Format;
  /** Extensions that normally hold this format (without the dot); a mismatch skips the file. */
  extensions?: string[];
}

/** Thrown by a format's reader for a file it will not touch (animated, unsupported variant...): reported as skipped, not damaged. */
export class SkipFile extends Error {}

export type Status = "optimized" | "unchanged" | "skipped" | "failed";

export interface StepReport {
  id: string;
  /** Size of the candidate, if it produced one. */
  size?: number;
  outcome: "kept" | "not smaller" | "rejected" | "skipped" | "failed";
  /** The step is lossy: what it kept changes the content within the similarity floor. */
  lossy?: boolean;
  detail?: string;
  ms: number;
}

export interface Report {
  path: string;
  status: Status;
  format?: string;
  before: number;
  after: number;
  /** Why it was skipped or failed. */
  reason?: string;
  steps: StepReport[];
  /** A lossy step was kept. */
  lossy?: boolean;
  notes: string[];
  dryRun?: boolean;
}

export interface Options {
  settings?: DeepPartial<Settings>;
  formats?: Format[];
  /** Where tools are looked for besides PATH. */
  toolDir?: string;
  /** Where the already-optimised list is kept (default `~/.shrink`). */
  cacheDir?: string;
  /** Where job folders go (default the system temp folder). */
  tempDir?: string;
  signal?: AbortSignal;
}
