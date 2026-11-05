// WebP fixtures made with libwebp's own tools.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePng } from "./png";

const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });

/** A lossless (default) or lossy WebP of a generated picture, fast and so not optimal. */
export function makeWebp(o: { lossy?: boolean; alpha?: boolean; width?: number; height?: number } = {}): Uint8Array {
  const w = o.width ?? 96, h = o.height ?? 64, ch = o.alpha ? 4 : 3;
  const data = new Uint8Array(w * h * ch);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    data.set(o.alpha ? [x * 2, y * 3, (x + y) & 255, x > w / 2 ? 255 : 100] : [x * 2, y * 3, (x ^ y) & 255], i * ch);
  }
  const dir = mkdtempSync(join(tmpdir(), "shrink-webp-"));
  try {
    const png = join(dir, "in.png"), out = join(dir, "out.webp");
    Bun.write(png, makePng({ width: w, height: h, colorType: o.alpha ? 6 : 2, bitDepth: 8, data }));
    run(["cwebp", "-quiet", ...(o.lossy ? ["-q", "90"] : ["-lossless", "-z", "0"]), "-metadata", "none", png, "-o", out]);
    return new Uint8Array(require("node:fs").readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Adds an EXIF and/or ICC chunk with webpmux. */
export function withChunks(webp: Uint8Array, chunks: { exif?: Uint8Array; icc?: Uint8Array }): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "shrink-webp-"));
  try {
    const fs = require("node:fs");
    fs.writeFileSync(join(dir, "in.webp"), webp);
    let cur = join(dir, "in.webp");
    for (const [kind, data] of Object.entries(chunks)) {
      if (!data) continue;
      fs.writeFileSync(join(dir, kind), data);
      const next = join(dir, `${kind}.webp`);
      const r = run(["webpmux", "-set", kind, join(dir, kind), cur, "-o", next]);
      if (r.exitCode !== 0) throw new Error("webpmux: " + r.stderr.toString());
      cur = next;
    }
    return new Uint8Array(fs.readFileSync(cur));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
