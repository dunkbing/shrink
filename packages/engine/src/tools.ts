import { join } from "node:path";
import type { RunResult, Settings, Tools } from "./types";

export class MissingTool extends Error {
  constructor(public tool: string) {
    super(`tool not found: ${tool}`);
  }
}

/** Places a tool is commonly installed under another name (Homebrew keeps mozjpeg's jpegtran out of PATH). */
const KNOWN: Record<string, string[]> = {
  mozjpegtran: ["/opt/homebrew/opt/mozjpeg/bin/jpegtran", "/usr/local/opt/mozjpeg/bin/jpegtran", "/usr/bin/mozjpegtran"],
  ghostscript: ["gs"],
};

/** Finds tools: the settings' `toolPaths`, then the tool folder, then PATH. */
export function createTools(settings: Settings, toolDir?: string): Tools {
  const cache = new Map<string, Promise<string[] | null>>();
  return {
    locate(name) {
      if (settings.disabledTools?.includes(name)) return Promise.resolve(null);
      let found = cache.get(name);
      if (!found) {
        found = (async () => {
          const set = settings.toolPaths?.[name];
          if (set?.length) return set;
          if (toolDir) {
            for (const ext of process.platform === "win32" ? [".exe", ""] : [""]) {
              const p = join(toolDir, name + ext);
              if (await Bun.file(p).exists()) return [p];
            }
          }
          for (const c of [name, ...(KNOWN[name] ?? [])]) {
            const w = c.startsWith("/") ? ((await Bun.file(c).exists()) ? c : null) : Bun.which(c);
            if (w) return [w];
          }
          return null;
        })();
        cache.set(name, found);
      }
      return found;
    },
  };
}

/** Runs a command: killed on timeout or abort; at low priority when asked. Never parses output as options. */
export async function runCommand(cmd: string[], o: { signal: AbortSignal; timeoutMs: number; cwd?: string; lowPriority?: boolean }): Promise<RunResult> {
  if (o.signal.aborted) throw new Error("cancelled");
  const argv = o.lowPriority && process.platform !== "win32" && Bun.which("nice") ? ["nice", "-n", "10", ...cmd] : cmd;
  const proc = Bun.spawn(argv, { cwd: o.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", onAbort);
  }
}
