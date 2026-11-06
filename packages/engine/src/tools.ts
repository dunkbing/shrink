import { join } from "node:path";
import { compareVersions, parseVersion } from "./manifest";
import type { ToolProvisioner } from "./provision";
import type { RunResult, Settings, Tools } from "./types";

export class MissingTool extends Error {
  constructor(public tool: string) {
    super(`tool not found: ${tool}`);
  }
}

/** Places a tool is commonly installed under another name (Homebrew keeps mozjpeg's jpegtran out of PATH). */
const KNOWN: Record<string, string[]> = {
  mozjpegtran: ["/opt/homebrew/opt/mozjpeg/bin/jpegtran", "/usr/local/opt/mozjpeg/bin/jpegtran", "/usr/bin/mozjpegtran"],
  ghostscript: ["gs", "gswin64c", "gswin32c"],
  // GNU strip (ELF, PE, ar): Homebrew keeps binutils off PATH, and on macOS plain `strip` is the Mach-O one
  "gnu-strip": ["/opt/homebrew/opt/binutils/bin/strip", "/usr/local/opt/binutils/bin/strip", "llvm-strip", "/opt/homebrew/opt/llvm/bin/llvm-strip", ...(process.platform === "darwin" ? [] : ["strip"])],
  "7zz": ["7z", "7zip"],
};

/** Versions of tools found on PATH, asked once per executable. */
const versions = new Map<string, Promise<number[] | null>>();

async function versionOf(exe: string, args: string[]): Promise<number[] | null> {
  const key = exe + "\0" + args.join(" ");
  let v = versions.get(key);
  if (!v) {
    v = (async () => {
      try {
        const proc = Bun.spawn([exe, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
        const timer = setTimeout(() => proc.kill("SIGKILL"), 10000);
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        clearTimeout(timer);
        const first = (out + "\n" + err).split("\n").find((l) => /\d/.test(l));
        return first ? parseVersion(first) : null;
      } catch {
        return null;
      }
    })();
    versions.set(key, v);
  }
  return v;
}

/**
 * Finds tools: the settings' `toolPaths`, then the tool folder, then a tool on PATH that is new enough (the manifest's
 * `minVersion`), then one the provisioner has installed. `ensure` downloads it when it is in none of these; an older
 * tool on PATH is the last resort when the download isn't possible.
 */
export function createTools(settings: Settings, toolDir?: string, provisioner?: ToolProvisioner | null): Tools {
  const system = new Map<string, Promise<string[] | null>>();
  const onPath = (name: string) => {
    let found = system.get(name);
    if (!found) {
      found = (async () => {
        for (const c of [name, ...(KNOWN[name] ?? [])]) {
          const w = c.startsWith("/") ? ((await Bun.file(c).exists()) ? c : null) : Bun.which(c, { PATH: process.env.PATH });
          if (w) return [w];
        }
        return null;
      })();
      system.set(name, found);
    }
    return found;
  };
  const explicit = async (name: string): Promise<string[] | null> => {
    if (settings.disabledTools?.includes(name)) return null;
    const set = settings.toolPaths?.[name];
    if (set?.length) return set;
    if (toolDir) {
      for (const ext of process.platform === "win32" ? [".exe", ""] : [""]) {
        const p = join(toolDir, name + ext);
        if (await Bun.file(p).exists()) return [p];
      }
    }
    return null;
  };
  /** The tool on PATH, if it is new enough. */
  const current = async (name: string): Promise<string[] | null> => {
    const cmd = await onPath(name);
    const min = provisioner?.manifest.tools[name]?.minVersion;
    if (!cmd || !min) return cmd;
    const v = await versionOf(cmd[0], provisioner!.manifest.tools[name].versionArgs ?? ["--version"]);
    return v && compareVersions(v, min.split(".").map(Number)) >= 0 ? cmd : null;
  };
  const locate = async (name: string): Promise<string[] | null> => {
    if (settings.disabledTools?.includes(name)) return null;
    const own = await explicit(name);
    if (own) return own;
    const sys = await current(name);
    if (sys) return sys;
    const got = provisioner?.installed(name);
    if (got) return [got];
    // an older tool beats none, once a download can't help
    if (!provisioner || !provisioner.canProvide(name)) return onPath(name);
    return null;
  };
  return {
    locate,
    async ensure(name) {
      const have = await locate(name);
      if (have || settings.disabledTools?.includes(name)) return have;
      if (provisioner && (await provisioner.ensure(name))) return locate(name);
      return locate(name);
    },
  };
}

/** Runs a command: killed on timeout or abort; at low priority when asked. Never parses output as options. */
export async function runCommand(cmd: string[], o: { signal: AbortSignal; timeoutMs: number; cwd?: string; lowPriority?: boolean }): Promise<RunResult> {
  if (o.signal.aborted) throw new Error("cancelled");
  const argv = o.lowPriority && process.platform !== "win32" && Bun.which("nice") ? ["nice", "-n", "10", ...cmd] : cmd;
  const proc = Bun.spawn(argv, { cwd: o.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  let why: string | null = null;
  const kill = (reason: string) => {
    why = reason;
    proc.kill("SIGKILL");
  };
  const onAbort = () => kill("cancelled");
  o.signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => kill(`timed out after ${Math.round(o.timeoutMs / 1000)}s`), o.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (why) throw new Error(why);
    // Windows tools end lines with \r\n; the parsers split on \n
    return process.platform === "win32" ? { code, stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n") } : { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", onAbort);
  }
}
