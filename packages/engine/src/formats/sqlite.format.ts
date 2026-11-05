// SQLite (docs/FORMATS.md section 13). VACUUM INTO a new file; the oracle compares integrity, pragmas, rows and the dump.
import { copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { toolStep } from "../step";
import { SkipFile, type Context, type Format } from "../types";

const MAGIC = "SQLite format 3\0";
const sql = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Runs sqlite3 read-only and returns the SHA-256 of its output, streamed (a dump can be huge). */
async function hashQuery(db: string, args: string[], ctx: Context): Promise<string> {
  const cmd = await ctx.tools.locate("sqlite3");
  if (!cmd) throw new SkipFile("cannot verify: sqlite3 not available");
  const proc = Bun.spawn([...cmd, "-readonly", db, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const onAbort = () => proc.kill("SIGKILL");
  ctx.signal.addEventListener("abort", onAbort);
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    const err = new Response(proc.stderr).text();
    for await (const chunk of proc.stdout) hasher.update(chunk);
    const [code, stderr] = [await proc.exited, await err];
    if (code !== 0) throw new Error(stderr.trim().split("\n")[0] || `sqlite3 exited with ${code}`);
    return hasher.digest("hex");
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

async function one(db: string, query: string, ctx: Context): Promise<string> {
  const cmd = await ctx.tools.locate("sqlite3");
  if (!cmd) throw new SkipFile("cannot verify: sqlite3 not available");
  const r = await ctx.run("sqlite3", ["-readonly", db, query]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `sqlite3 exited with ${r.code}`);
  return r.stdout.trim();
}

const PRAGMAS = ["user_version", "application_id", "auto_vacuum", "encoding", "journal_mode"];

/** Everything about the content: integrity, pragmas, schema/data dump and every rowid table with its rowids. */
async function fingerprint(db: string, ctx: Context): Promise<string> {
  const ok = await one(db, "PRAGMA integrity_check", ctx);
  if (ok !== "ok") throw new Error(`integrity check failed: ${ok.split("\n")[0]}`);
  const pragmas = await one(db, PRAGMAS.map((p) => `PRAGMA ${p};`).join(" "), ctx);
  const dump = await hashQuery(db, [".dump"], ctx);
  const tables = (await one(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' AND sql NOT LIKE '%WITHOUT ROWID%'", ctx)).split("\n").filter(Boolean);
  const rows = tables.length ? await hashQuery(db, [".mode quote", ...tables.map((t) => `SELECT rowid, * FROM "${t.replace(/"/g, '""')}" ORDER BY rowid;`)], ctx) : "";
  return [pragmas, dump, rows].join("|");
}

export const sqlite: Format = {
  id: "sqlite",
  extensions: ["sqlite", "sqlite3", "db", "db3", "s3db"],
  detect: (h) => new TextDecoder("latin1").decode(h.subarray(0, 16)) === MAGIC,
  async skip(path, head) {
    for (const s of ["-wal", "-shm", "-journal"]) if (existsSync(path + s)) return `database in use (${path.split("/").pop()}${s} exists)`;
    if (head[18] === 2 || head[19] === 2) return "WAL-mode database (not rewritten)";
    return statSync(path).size < 512 ? "too small to optimise" : null;
  },
  steps: [
    toolStep({
      id: "sqlite.vacuum",
      tool: "sqlite3",
      args: (input, output) => ["-readonly", input, `VACUUM INTO ${sql(output)}`],
    }),
    {
      id: "sqlite.page-size",
      tool: "sqlite3",
      minLevel: 7,
      async run(input, output, ctx) {
        let best = "";
        let bestSize = Infinity;
        for (const size of [1024, 2048, 4096, 8192, 16384, 32768, 65536]) {
          const tmp = join(ctx.dir, `ps${size}.db`);
          copyFileSync(input, tmp);
          const r = await ctx.run("sqlite3", [tmp, `PRAGMA page_size=${size}; VACUUM;`]);
          if (r.code !== 0) continue;
          const s = statSync(tmp).size;
          if (s < bestSize) [best, bestSize] = [tmp, s];
        }
        if (!best) throw new Error("no page size worked");
        copyFileSync(best, output);
      },
    },
  ],
  oracle: {
    async prepare(path, ctx) {
      try {
        return await fingerprint(path, ctx);
      } catch (e: any) {
        if (e instanceof SkipFile) throw e;
        throw new Error(`damaged: ${e?.message ?? e}`);
      }
    },
    async same(original, candidate, ctx) {
      try {
        const f = await fingerprint(candidate, ctx);
        if (f === original) return true;
        const [a, b] = [String(original).split("|"), f.split("|")];
        return a[0] !== b[0] ? "pragmas (user_version, application_id, auto_vacuum...) differ" : a[1] !== b[1] ? "the dump differs" : "row ids differ";
      } catch (e: any) {
        return `the result fails verification: ${e?.message ?? e}`;
      }
    },
  },
};

export const formats: Format[] = [sqlite];
