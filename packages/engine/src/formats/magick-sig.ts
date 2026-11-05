// Pixel proof through ImageMagick: one line per frame with the geometry, colour model and a SHA-256 of the pixel data.
import { MissingTool } from "../tools";
import { SkipFile, type Context } from "../types";
import { errorMessage } from "../errors";

export async function frameSignatures(ctx: Context, prefix: string, path: string): Promise<string[]> {
  const r = await ctx.run("magick", ["identify", "-regard-warnings", "-format", "%w|%h|%[colorspace]|%[channels]|%[depth]|%[type]|%#\n", `${prefix}:${path}`]);
  if (r.code !== 0) throw new Error(`ImageMagick: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? "failed"}`);
  const lines = r.stdout.split("\n").filter(Boolean);
  if (!lines.length) throw new Error("ImageMagick found no image");
  return lines;
}

/** For `prepare`: the signatures of the original; a missing ImageMagick or a file it cannot read means we cannot prove anything. */
export async function originalSignatures(ctx: Context, prefix: string, path: string): Promise<string[]> {
  try {
    return await frameSignatures(ctx, prefix, path);
  } catch (e) {
    if (e instanceof MissingTool) throw new SkipFile("cannot verify: ImageMagick (magick) not found");
    if (errorMessage(e).includes("cancelled") || errorMessage(e).includes("timed out")) throw e;
    throw new Error(`${errorMessage(e)}`);
  }
}

export function sameSignatures(a: string[], b: string[]): true | string {
  if (a.length !== b.length) return `frame count ${a.length} became ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `frame ${i} differs (${a[i].split("|").slice(0, 6).join(" ")} vs ${b[i].split("|").slice(0, 6).join(" ")})`;
  return true;
}
