// A made-up format for testing the engine itself: "FAKE\n" + lines + "\nEND". Its content is the lines without
// trailing spaces, so trimming them is a lossless optimisation.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src";
import type { DeepPartial, Format, Settings, Step } from "../src";

const norm = (text: string) => text.replace(/^FAKE\n/, "").replace(/\nEND$/, "").split("\n").map((l) => l.replace(/ +$/, "")).join("\n");

export const trim: Step = {
  id: "fake.trim",
  async run(input, output) {
    const text = await Bun.file(input).text();
    await Bun.write(output, "FAKE\n" + norm(text) + "\nEND");
  },
};

export function fakeFormat(steps: Step[] = [trim], extra: Partial<Format> = {}): Format {
  return {
    id: "fake",
    extensions: ["fake"],
    detect: (head) => new TextDecoder().decode(head.subarray(0, 5)) === "FAKE\n",
    flags: (s) => ({ lossy: (s as any).fakeLossy === true, keepMetadata: s.png.keepMetadata }),
    steps,
    oracle: {
      async prepare(path) {
        const t = await Bun.file(path).text();
        if (!t.endsWith("\nEND")) throw new Error("no END marker");
        return norm(t);
      },
      async same(original, candidate) {
        const t = await Bun.file(candidate).text();
        return t.endsWith("\nEND") && norm(t) === original ? true : "content differs";
      },
    },
    ...extra,
  };
}

/** A file's text with trailing spaces on every line: `n` lines. */
export const sample = (n = 50) => "FAKE\n" + Array.from({ length: n }, (_, i) => `line ${i}   `).join("\n") + "\nEND";

export interface Env {
  dir: string;
  engine: Engine;
  file(name: string, content: string | Uint8Array): Promise<string>;
  leftovers(): string[];
  cleanup(): void;
}

export function env(opts: { steps?: Step[]; settings?: DeepPartial<Settings>; format?: Format; formats?: Format[] } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "shrink-test-"));
  const tempDir = join(dir, "tmp");
  Bun.spawnSync(["mkdir", "-p", tempDir]);
  const engine = new Engine({
    formats: opts.formats ?? [opts.format ?? fakeFormat(opts.steps)],
    settings: { workers: 4, ...opts.settings },
    cacheDir: join(dir, "cache"),
    tempDir,
  });
  return {
    dir,
    engine,
    async file(name, content) {
      const p = join(dir, name);
      await Bun.write(p, content);
      return p;
    },
    leftovers: () => readdirSync(tempDir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
