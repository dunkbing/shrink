// Gets the external tools onto the machine by itself: downloads the pack a tool belongs to, checks its sha256 and
// unpacks it into the per-user tools folder. Safe to call from many workers and from several app instances at once.
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "./errors";
import { currentPlatform, exePath, manifest as bundled, type Manifest, type PackFile, type Platform } from "./manifest";
import { extractTarGz } from "./tar";

export type PackPhase = "waiting" | "downloading" | "verifying" | "extracting" | "ready" | "failed" | "offline";

export interface PackState {
  pack: string;
  phase: PackPhase;
  received: number;
  /** 0 while unknown. */
  total: number;
  tools: string[];
  error?: string;
}

export interface ProvisionOptions {
  manifest?: Manifest;
  /** Where the pack files are (`file://` works). Default: SHRINK_TOOLS_URL, then the manifest's. */
  baseUrl?: string;
  /** The tools folder (default SHRINK_TOOLS_DIR, then ~/.shrink/tools). */
  dir?: string;
  /** Never download (default: SHRINK_OFFLINE is set). */
  offline?: boolean;
  /** null: this platform has no packs. */
  platform?: Platform | null;
  onProgress?: (state: PackState) => void;
  /** Tries per pack (default 4). */
  attempts?: number;
  backoffMs?: number;
  /** A lock nobody refreshed for this long is taken over. */
  staleLockMs?: number;
  /** How long a failed pack is left alone before it is tried again (default 60 s). */
  cooldownMs?: number;
}

class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}
class Checksum extends Error {
  constructor(message: string, public resumed: boolean) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
};

export class ToolProvisioner {
  readonly manifest: Manifest;
  readonly dir: string;
  readonly platform: Platform | null;
  private offline: boolean;
  private opts: ProvisionOptions;
  private baseUrl: string;
  private inflight = new Map<string, Promise<boolean>>();
  private state = new Map<string, PackState>();
  private failedAt = new Map<string, number>();
  private ready = new Map<string, string>();
  private last = 0;
  private listeners = new Set<(s: PackState) => void>();

  constructor(opts: ProvisionOptions = {}) {
    this.opts = opts;
    this.manifest = opts.manifest ?? bundled;
    this.platform = opts.platform === undefined ? currentPlatform() : opts.platform;
    this.dir = opts.dir ?? process.env.SHRINK_TOOLS_DIR ?? join(homedir(), ".shrink", "tools");
    this.offline = opts.offline ?? !!process.env.SHRINK_OFFLINE;
    this.baseUrl = (opts.baseUrl ?? process.env.SHRINK_TOOLS_URL ?? this.manifest.baseUrl).replace("{version}", String(this.manifest.version)).replace(/\/+$/, "");
  }

  /** Stops (or allows) downloads. */
  setOffline(v: boolean) {
    this.offline = v;
  }

  /** The pack a tool is delivered in, or null for a tool that is not provisioned. */
  packOf(tool: string): string | null {
    return this.manifest.tools[tool]?.pack ?? null;
  }

  private file(pack: string): PackFile | null {
    const f = this.platform ? this.manifest.packs[pack]?.platforms[this.platform] : undefined;
    return f?.sha256 ? f : null;
  }

  private packDir(pack: string, f: PackFile): string {
    return join(this.dir, "packs", `${pack}-${f.sha256!.slice(0, 12)}`);
  }

  /** Where the tool is installed now, or null. */
  installed(tool: string): string | null {
    const pack = this.packOf(tool);
    const f = pack && this.file(pack);
    if (!pack || !f || !this.platform) return null;
    const dir = this.packDir(pack, f);
    if (!this.ready.has(pack)) {
      if (!existsSync(join(dir, ".ready"))) return null;
      this.ready.set(pack, dir);
    }
    const p = join(dir, exePath(this.manifest, tool, this.platform));
    return existsSync(p) ? p : null;
  }

  /** Could a download deliver this tool now? */
  canProvide(tool: string): boolean {
    const pack = this.packOf(tool);
    if (!pack || !this.file(pack) || !this.manifest.tools[tool].platforms[this.platform!]) return false;
    if (this.installed(tool)) return true;
    if (this.offline) return false;
    const failed = this.failedAt.get(pack);
    return failed === undefined || Date.now() - failed >= (this.opts.cooldownMs ?? 60000);
  }

  /** Why a tool is missing, for the notes of a skipped step. */
  why(tool: string): string | null {
    const pack = this.packOf(tool);
    if (!pack) return null;
    if (!this.file(pack)) return "no download for this platform";
    if (this.offline) return "offline";
    const s = this.state.get(pack);
    return s && (s.phase === "failed" || s.phase === "offline") ? (s.phase === "offline" ? "offline" : `download failed: ${s.error}`) : null;
  }

  /** The tool's command once it is installed; downloads its pack first if needed. null when that is not possible. */
  async ensure(tool: string): Promise<string[] | null> {
    const have = this.installed(tool);
    if (have) return [have];
    const pack = this.packOf(tool);
    if (!pack || !(await this.ensurePack(pack))) return null;
    const p = this.installed(tool);
    return p ? [p] : null;
  }

  /** Downloads and installs a pack (once, however many ask); false when it can't be had. */
  ensurePack(pack: string): Promise<boolean> {
    const f = this.file(pack);
    if (!f) return Promise.resolve(false);
    if (existsSync(join(this.packDir(pack, f), ".ready"))) return Promise.resolve(true);
    if (this.offline) return Promise.resolve(false);
    const failed = this.failedAt.get(pack);
    if (failed !== undefined && Date.now() - failed < (this.opts.cooldownMs ?? 60000)) return Promise.resolve(false);
    let p = this.inflight.get(pack);
    if (!p) {
      p = this.install(pack, f).finally(() => this.inflight.delete(pack));
      this.inflight.set(pack, p);
    }
    return p;
  }

  /** Starts the packs in the background (default `core`); resolves when they are done. */
  async prefetch(packs: string[] = ["core"]): Promise<void> {
    await Promise.all(packs.map((p) => this.ensurePack(p)));
  }

  /** Forgets failures so the next request tries again. */
  retry() {
    this.failedAt.clear();
    for (const [k, s] of this.state) if (s.phase === "failed" || s.phase === "offline") this.state.delete(k);
  }

  /** Hears every progress event; returns the function that stops it. */
  listen(fn: (s: PackState) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** The state of every pack that has been asked for. */
  states(): PackState[] {
    return [...this.state.values()];
  }

  stateOf(tool: string): PackState | null {
    const pack = this.packOf(tool);
    return (pack && this.state.get(pack)) || null;
  }

  private emit(pack: string, patch: Partial<PackState>, force = true) {
    const prev = this.state.get(pack) ?? { pack, phase: "waiting" as PackPhase, received: 0, total: 0, tools: this.manifest.packs[pack]?.tools ?? [] };
    const next = { ...prev, ...patch };
    if (patch.phase !== "failed" && patch.phase !== "offline") delete next.error;
    this.state.set(pack, next);
    const now = Date.now();
    if (!force && now - this.last < 100) return;
    this.last = now;
    this.opts.onProgress?.(next);
    for (const l of this.listeners) l(next);
  }

  private async install(pack: string, f: PackFile): Promise<boolean> {
    const final = this.packDir(pack, f);
    this.emit(pack, { phase: "waiting", received: 0, total: f.size ?? 0 });
    const tmp = join(this.dir, "tmp");
    mkdirSync(tmp, { recursive: true });
    mkdirSync(join(this.dir, "locks"), { recursive: true });
    const lock = join(this.dir, "locks", `${pack}.lock`);
    const stale = this.opts.staleLockMs ?? 30000;
    // another process may be installing the same pack: wait for it, or take over a lock nobody refreshes
    for (let waited = 0; ; waited += 200) {
      if (existsSync(join(final, ".ready"))) {
        this.emit(pack, { phase: "ready" });
        return true;
      }
      try {
        mkdirSync(lock);
        break;
      } catch {
        try {
          const age = Date.now() - statSync(lock).mtimeMs;
          const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
          if (age > stale || (pid && !alive(pid) && age > 1000)) rmSync(lock, { recursive: true, force: true });
        } catch {} // released meanwhile
        if (waited > 20 * 60000) {
          this.fail(pack, "timed out waiting for another instance");
          return false;
        }
        await sleep(200);
      }
    }
    const beat = setInterval(() => {
      try {
        utimesSync(lock, new Date(), new Date());
      } catch {}
    }, Math.max(100, stale / 4));
    try {
      writeFileSync(join(lock, "pid"), String(process.pid));
      this.sweep(tmp);
      const attempts = this.opts.attempts ?? 4;
      let err: unknown = null;
      for (let n = 1; n <= attempts; n++) {
        try {
          const part = join(tmp, `${f.file}.${f.sha256!.slice(0, 8)}.part`);
          const resumed = await this.download(pack, f, part);
          this.emit(pack, { phase: "verifying" });
          if ((await sha256(part)) !== f.sha256!.toLowerCase()) {
            rmSync(part, { force: true });
            throw new Checksum("checksum mismatch", resumed);
          }
          this.emit(pack, { phase: "extracting" });
          const x = join(tmp, `x-${pack}-${process.pid}-${Date.now()}`);
          try {
            await extractTarGz(part, x);
            this.finishPack(pack, x);
            writeFileSync(join(x, ".ready"), f.sha256!);
            mkdirSync(join(this.dir, "packs"), { recursive: true });
            try {
              renameSync(x, final);
            } catch (e) {
              if (!existsSync(join(final, ".ready"))) throw e; // another process finished first
            }
          } finally {
            rmSync(x, { recursive: true, force: true });
          }
          rmSync(part, { force: true });
          this.failedAt.delete(pack);
          this.gc(pack, final);
          this.emit(pack, { phase: "ready", received: f.size ?? 0 });
          return true;
        } catch (e) {
          err = e;
          if (!(e instanceof Checksum ? e.resumed : isNetwork(e))) break; // a bad pack or a refusal will not change
          if (n < attempts) await sleep((this.opts.backoffMs ?? 500) * 2 ** (n - 1));
        }
      }
      this.fail(pack, errorMessage(err), isNetwork(err) && !(err instanceof HttpError));
      return false;
    } finally {
      clearInterval(beat);
      rmSync(lock, { recursive: true, force: true });
    }
  }

  private fail(pack: string, error: string, offline = false) {
    this.failedAt.set(pack, Date.now());
    this.emit(pack, { phase: offline ? "offline" : "failed", error });
  }

  /** Makes the tools runnable: +x, and no macOS quarantine flag. */
  private finishPack(pack: string, dir: string) {
    const bin = join(dir, "bin");
    if (!existsSync(bin)) throw new Error("pack has no bin folder");
    if (process.platform !== "win32") for (const e of readdirSync(bin)) chmodSync(join(bin, e), 0o755);
    if (process.platform === "darwin") Bun.spawnSync(["xattr", "-dr", "com.apple.quarantine", dir], { stdout: "ignore", stderr: "ignore" });
    for (const t of this.manifest.packs[pack]?.tools ?? []) {
      if (!this.manifest.tools[t]?.platforms[this.platform!]) continue; // not built for this platform
      if (!existsSync(join(dir, exePath(this.manifest, t, this.platform!)))) throw new Error(`pack is missing ${t}`);
    }
  }

  /** Streams the pack to `part` (continuing a partial file when the server allows). Returns true if it resumed. */
  private async download(pack: string, f: PackFile, part: string): Promise<boolean> {
    const url = `${this.baseUrl}/${f.file}`;
    let have = existsSync(part) ? statSync(part).size : 0;
    let body: AsyncIterable<Uint8Array>;
    let total = f.size ?? 0;
    if (url.startsWith("file:")) {
      const path = fileURLToPath(url);
      const size = statSync(path).size;
      if (have > size) (rmSync(part), (have = 0));
      body = createReadStream(path, { start: have });
      total = size;
    } else {
      let res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
      if (res.status === 416 && have) {
        rmSync(part, { force: true });
        have = 0;
        res = await fetch(url);
      }
      if (!res.ok || !res.body) throw new HttpError(res.status, url);
      if (res.status !== 206) have = 0; // the server sent it all
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len) total = have + len;
      body = res.body;
    }
    this.emit(pack, { phase: "downloading", received: have, total });
    const out = createWriteStream(part, { flags: have ? "a" : "w" });
    let received = have;
    try {
      for await (const chunk of body) {
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        received += chunk.length;
        this.emit(pack, { phase: "downloading", received, total }, false);
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    return have > 0;
  }

  /** Removes what interrupted installs left: old partial files and half-unpacked folders. */
  private sweep(tmp: string) {
    for (const e of readdirSync(tmp)) {
      const p = join(tmp, e);
      try {
        const age = Date.now() - statSync(p).mtimeMs;
        if ((e.startsWith("x-") && age > 60000) || (e.endsWith(".part") && age > 7 * 86400000)) rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }

  /** Removes older versions of the same pack. */
  private gc(pack: string, keep: string) {
    const root = join(this.dir, "packs");
    for (const e of readdirSync(root)) if (e.startsWith(`${pack}-`) && join(root, e) !== keep) rmSync(join(root, e), { recursive: true, force: true });
  }
}

/** A failure of the connection itself (no network, DNS, reset, timeout), as opposed to a server answer. */
function isNetwork(e: unknown): boolean {
  if (e instanceof HttpError) return e.status >= 500 || e.status === 408 || e.status === 429;
  if (e instanceof Checksum) return false;
  if (e instanceof TypeError) return true; // fetch failed
  const code = e instanceof Error && "code" in e ? String(e.code) : "";
  return /^(ECONN|ENOTFOUND|EAI_|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR|ConnectionRefused|ConnectionClosed|FailedToOpenSocket)/.test(code) || /unable to connect|network|socket|fetch failed|ECONNRESET/i.test(errorMessage(e));
}

async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const c of createReadStream(path)) h.update(c);
  return h.digest("hex");
}
