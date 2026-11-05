import type { Context, Step } from "./types";

/** A step that runs an external tool: `args` builds its command line; a non-zero exit fails the step. */
export function toolStep(s: Omit<Step, "run" | "tool"> & { tool: string; args(input: string, output: string, ctx: Context): string[]; ok?: number[] }): Step {
  const { args, ok = [0], ...rest } = s;
  return {
    ...rest,
    async run(input, output, ctx) {
      const r = await ctx.run(s.tool, args(input, output, ctx));
      if (!ok.includes(r.code)) throw new Error(`${s.tool} exited with ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`.trim());
    },
  };
}

/** A step for a tool that rewrites its file in place: the input is copied to the output first, and the tool runs on that. */
export function inPlaceStep(s: Omit<Step, "run" | "tool"> & { tool: string; args(file: string, ctx: Context): string[] }): Step {
  const { args, ...rest } = s;
  return {
    ...rest,
    async run(input, output, ctx) {
      await Bun.write(output, Bun.file(input));
      const r = await ctx.run(s.tool, args(output, ctx));
      if (r.code !== 0) throw new Error(`${s.tool} exited with ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`.trim());
    },
  };
}
