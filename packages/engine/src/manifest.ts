// The tool manifest (tools/manifest.json): which external tools exist, how they are grouped in packs, where the packs are.
import raw from "../tools/manifest.json";

export type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "win32-x64";
export const PLATFORMS: Platform[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

/** Where the pack builder gets a tool from: an upstream release archive, a package manager, or a build script. */
export interface ToolSource {
  version?: string;
  url?: string;
  sha256?: string | null;
  /** Path of the executable inside the upstream archive. */
  member?: string;
  /** Installed by a package manager, with its libraries bundled by the builder. */
  system?: boolean;
  brew?: string;
  apt?: string;
  choco?: string;
  /** The executable's name in that package. */
  bin?: string;
  /** Script (relative to the repo) that builds it. */
  build?: string;
}

export interface ToolEntry {
  pack: string;
  licence: string;
  homepage: string;
  /** A tool already on PATH is used only if its version is at least this. */
  minVersion?: string;
  /** Arguments that make the tool print its version (default `--version`). */
  versionArgs?: string[];
  /** The executable this tool shares with another entry (mozjpegtran is jpegtran). */
  exeOf?: string;
  /** The builder takes the executable from another tool's build (ffprobe from ffmpeg). */
  builtWith?: string;
  experimental?: boolean;
  /** Platforms where the pack builder could not make it relocatable: why it is left out. */
  dropped?: Partial<Record<Platform, string>>;
  platforms: Partial<Record<Platform, ToolSource>>;
}

export interface PackFile {
  file: string;
  /** null until the pack is published: such a pack is never downloaded. */
  sha256: string | null;
  size: number | null;
}

export interface PackEntry {
  description: string;
  tools: string[];
  platforms: Partial<Record<Platform, PackFile>>;
}

export interface Manifest {
  version: number;
  /** `{version}` is replaced with the manifest version. */
  baseUrl: string;
  packs: Record<string, PackEntry>;
  tools: Record<string, ToolEntry>;
}

export const manifest = raw as unknown as Manifest;

/** The platform this process runs on, or null when no packs exist for it. */
export function currentPlatform(): Platform | null {
  const key = `${process.platform}-${process.arch}`;
  return PLATFORMS.find((p) => p === key) ?? null;
}

/** Path of a tool's executable inside its pack. */
export function exePath(m: Manifest, tool: string, platform: Platform): string {
  const name = m.tools[tool]?.exeOf ?? tool;
  return `bin/${name}${platform.startsWith("win32") ? ".exe" : ""}`;
}

/** The numbers of a version string ("ffmpeg version n7.1.2-1" -> [7,1,2]), or null. */
export function parseVersion(text: string): number[] | null {
  const m = /(\d+(?:\.\d+)+|\d+)/.exec(text.replace(/^[^\d]*\bversion\b/i, ""));
  return m ? m[1].split(".").map(Number) : null;
}

/** -1, 0 or 1; missing parts count as 0. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
