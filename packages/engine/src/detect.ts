import { extname } from "node:path";
import type { Format } from "./types";

/** How many leading bytes detection sees. */
export const HEAD = 4096;

export type Detected = { format: Format } | { skip: string } | null;

/** Finds the format by content; a file whose content contradicts its extension is skipped. */
export function detect(head: Uint8Array, name: string, formats: Format[]): Detected {
  const ext = extname(name).slice(1).toLowerCase();
  const byContent = formats.find((f) => f.detect(head, name));
  if (!byContent) {
    const claimed = formats.find((f) => f.extensions?.includes(ext));
    return claimed ? { skip: `not a valid ${claimed.id} file (content does not match .${ext})` } : null;
  }
  if (ext && byContent.extensions && !byContent.extensions.includes(ext)) {
    const other = formats.find((f) => f.extensions?.includes(ext));
    if (other) return { skip: `content is ${byContent.id} but the extension says ${other.id}` };
  }
  return { format: byContent };
}
