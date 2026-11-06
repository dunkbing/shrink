// Runs `xz` over bytes or files without holding the decompressed data in memory (streams into a hash or a file).
import { createHash } from "node:crypto";
import { SkipFile, type Context } from "../types";

export const XZ_LIMIT = 2 ** 31;

/** The xz command, or a SkipFile when no xz is installed (a result that cannot be verified is never kept). */
export async function needXz(ctx: Pick<Context, "tools">): Promise<string[]> {
  const cmd = (await ctx.tools?.locate("xz")) ?? (Bun.which("xz") ? [Bun.which("xz")!] : null);
  if (!cmd) throw new SkipFile("xz is not installed, so the result cannot be verified");
  return cmd;
}

type Source = Bun.BunFile | Uint8Array;

/** Runs xz with `args` (flags only) reading `stdin`; stdout goes to a file, or is hashed (and counted). */
export async function xzRun(cmd: string[], args: string[], stdin: Source, out: { file: string } | { hash: true }, signal?: AbortSignal): Promise<{ sha: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const proc = Bun.spawn([...cmd, ...args], { stdin, stdout: "file" in out ? Bun.file(out.file) : "pipe", stderr: "pipe", signal, windowsHide: true });
  const stderr = new Response(proc.stderr).text();
  if (!("file" in out)) {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      size += chunk.length;
      if (size > XZ_LIMIT) {
        proc.kill();
        throw new SkipFile("expands to more than 2 GiB (decompression bomb guard)");
      }
      hash.update(chunk);
    }
  }
  const code = await proc.exited;
  if (code !== 0) throw new Error(`xz exited with ${code}: ${(await stderr).trim().split("\n")[0] ?? ""}`);
  return { sha: hash.digest("hex"), size };
}

/** Decompressed SHA-256 and length of an .xz / .lzma payload. */
export const xzDigest = (cmd: string[], src: Source, signal?: AbortSignal) => xzRun(cmd, ["-dc", "-q"], src, { hash: true }, signal);

/** Recompresses xz/lzma bytes: decompress to a scratch file, compress that with the strongest preset into `output`. */
export async function xzRecompress(cmd: string[], input: Source, scratch: string, output: string, o: { lzma?: boolean; check?: string; signal?: AbortSignal }): Promise<void> {
  await xzRun(cmd, ["-dc", "-q"], input, { file: scratch }, o.signal);
  const args = o.lzma ? ["--format=lzma"] : ["--format=xz", `--check=${o.check ?? "crc64"}`];
  await xzRun(cmd, [...args, "-9e", "-T1", "-c", "-q"], Bun.file(scratch), { file: output }, o.signal);
}

/** Stream flags of the first xz stream: the integrity check it uses. */
export function xzCheck(b: Uint8Array): string {
  return ({ 0: "none", 1: "crc32", 4: "crc64", 10: "sha256" } as Record<number, string>)[b[7] & 15] ?? "crc64";
}
