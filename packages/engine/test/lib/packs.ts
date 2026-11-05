// A local "release": pack archives with fake tools in a folder, and a manifest that points at them.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { currentPlatform, type Manifest, type Platform } from "../../src";

export const platform = currentPlatform();

function tarEntry(name: string, data: Uint8Array, mode: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number) => h.set(new TextEncoder().encode(s), at);
  put(name, 0);
  put(mode.toString(8).padStart(7, "0"), 100);
  put("0000000", 108);
  put("0000000", 116);
  put(data.length.toString(8).padStart(11, "0"), 124);
  put("00000000000", 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const pad = new Uint8Array((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

export function tarGz(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const parts = Object.entries(files).map(([n, d]) => tarEntry(n, new TextEncoder().encode(d), 0o644));
  return Bun.gzipSync(Buffer.concat([...parts, new Uint8Array(1024)]));
}

export const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

export interface FakePacks {
  dir: string;
  url: string;
  manifest: Manifest;
  /** Replaces what is served for a pack (to break it). */
  write(file: string, data: Uint8Array): void;
  files: Record<string, Uint8Array<ArrayBuffer>>;
}

/** Packs `{ core: ["ftool"], extra: ["gtool"] }`; each tool is a script that prints "<name> <version>". */
export function fakePacks(packs: Record<string, string[]>, o: { version?: string; minVersion?: Record<string, string> } = {}): FakePacks {
  const p = platform as Platform;
  const dir = mkdtempSync(join(tmpdir(), "shrink-packs-"));
  mkdirSync(dir, { recursive: true });
  const m: Manifest = { version: 1, baseUrl: pathToFileURL(dir).href, packs: {}, tools: {} };
  const files: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const [pack, tools] of Object.entries(packs)) {
    const content: Record<string, string> = { "bin/": "" };
    delete content["bin/"];
    for (const t of tools) {
      content[`bin/${t}${p.startsWith("win32") ? ".exe" : ""}`] = `#!/bin/sh\necho "${t} version ${o.version ?? "2.0.0"}"\n`;
      m.tools[t] = { pack, licence: "MIT", homepage: "", minVersion: o.minVersion?.[t], platforms: { [p]: { version: o.version ?? "2.0.0" } } };
    }
    const data = tarGz(content);
    const file = `${pack}-${p}.tar.gz`;
    files[file] = data;
    writeFileSync(join(dir, file), data);
    m.packs[pack] = { description: pack, tools, platforms: { [p]: { file, sha256: sha(data), size: data.length } } };
  }
  return { dir, url: m.baseUrl, manifest: m, files, write: (f, d) => writeFileSync(join(dir, f), d) };
}
