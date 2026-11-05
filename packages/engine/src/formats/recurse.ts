// Optimising the files inside an archive: each goes through its own format, and is checked by that format's oracle.
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { detect, HEAD } from "../detect";
import { Engine } from "../optimize";
import type { Context, Format } from "../types";
import { errorMessage } from "../errors";

export interface Member {
  name: string;
  data: Uint8Array;
  /** Set to leave this member alone. */
  skip?: string | null;
}

/** Formats that may appear inside an archive (archives themselves are not nested). */
async function inner(): Promise<Format[]> {
  const { allFormats } = await import("./index");
  return allFormats.filter((f) => !["zip", "gzip", "tar", "7z", "cfb", "swf"].includes(f.id));
}

let seq = 0;
/** Returns each member's new bytes (the same object when nothing changed). Inner files keep their EXIF/colour data. */
export async function recurseMembers(items: Member[], ctx: Context): Promise<Uint8Array[]> {
  const formats = await inner();
  const dir = join(ctx.dir, `rec${++seq}`);
  mkdirSync(dir, { recursive: true });
  const engine = new Engine({
    formats,
    // an archive holds the same files before and after: lossy steps stay off inside it, whatever the settings say
    settings: {
      ...ctx.settings,
      skipOptimized: false,
      archive: { ...ctx.settings.archive, recurse: false },
      jpeg: { ...ctx.settings.jpeg, keepMetadata: true, lossy: false },
      png: { ...ctx.settings.png, lossy: false },
      gif: { ...ctx.settings.gif, lossy: false },
      webp: { ...ctx.settings.webp, lossy: false },
      pdf: { ...ctx.settings.pdf, profile: "none" },
      audio: { ...ctx.settings.audio, trimSilence: false },
    },
    tempDir: dir,
    cacheDir: join(dir, "cache"),
    signal: ctx.signal,
  });
  const out: Uint8Array[] = [];
  let i = 0;
  for (const m of items) {
    out.push(m.data);
    if (m.skip || m.data.length < 16 || !detect(m.data.subarray(0, HEAD), basename(m.name), formats) || !("format" in (detect(m.data.subarray(0, HEAD), basename(m.name), formats) as object))) continue;
    const f = join(dir, `m${i++}${m.name.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? ""}`);
    await Bun.write(f, m.data);
    const r = await engine.optimizeFile(f);
    if (r.status === "optimized") {
      const b = new Uint8Array(await Bun.file(f).arrayBuffer());
      if (b.length < m.data.length) out[out.length - 1] = b;
    }
  }
  return out;
}

/** Same content for a member that was rewritten by recursion: equal bytes, or the member's own format says so. */
export async function sameMember(name: string, a: Uint8Array, b: Uint8Array, ctx: Context): Promise<true | string> {
  if (a.length === b.length && Buffer.compare(a, b) === 0) return true;
  const formats = await inner();
  const found = detect(a.subarray(0, HEAD), basename(name), formats);
  if (!found || !("format" in found)) return `${name}: content differs`;
  const dir = join(ctx.dir, `chk${++seq}`);
  mkdirSync(dir, { recursive: true });
  const ext = name.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
  const fa = join(dir, "a" + ext), fb = join(dir, "b" + ext);
  await Bun.write(fa, a);
  await Bun.write(fb, b);
  try {
    const prepared = await found.format.oracle.prepare?.(fa, ctx);
    const r = await found.format.oracle.same(prepared, fb, ctx);
    return r === true ? true : `${name}: ${r}`;
  } catch (e) {
    return `${name}: ${errorMessage(e)}`;
  }
}
