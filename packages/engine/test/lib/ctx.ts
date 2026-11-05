// A Context for calling a format's oracle or step directly, without an Engine.
import { resolve, type Context, type DeepPartial, type RunResult, type Settings } from "../../src";

/** Runs the real tool; `fix` post-processes its output (e.g. CRLF to LF, as runCommand does on Windows). */
export const spawnRun = (fix: (s: string) => string = (s) => s) => async (tool: string, args: string[]): Promise<RunResult> => {
  const r = Bun.spawnSync([tool, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: fix(r.stdout.toString()), stderr: fix(r.stderr.toString()) };
};

type Overrides = Omit<Partial<Context>, "settings"> & { settings?: DeepPartial<Settings> };

/** Defaults: default settings, no tools located, `run` rejects. */
export function testCtx(over: Overrides = {}): Context {
  const { settings, ...rest } = over;
  return {
    settings: resolve(settings),
    level: 5,
    original: "",
    format: "",
    dir: "",
    signal: new AbortController().signal,
    tools: { locate: async () => null },
    run: async (tool) => {
      throw new Error(`testCtx: no run() for ${tool}`);
    },
    note: () => {},
    facts: {},
    ...rest,
  };
}
