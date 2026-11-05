// Writers for the text-format tests: SVG, SQLite, and a script that stands in for a minifier.
import { join } from "node:path";

/** An SVG as Inkscape writes it: editor namespaces, metadata, a gradient, layers and `n` shapes. */
export function inkscapeSvg(n = 30): string {
  const shapes = Array.from({ length: n }, (_, i) => `    <rect style="fill:#ff0000;fill-opacity:1;stroke:#000000;stroke-width:1.00" id="rect${i}" width="${10 + i}.0" height="8" x="${i * 6}" y="${(i * 7) % 150}" inkscape:label="r${i}" />`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:xlink="http://www.w3.org/1999/xlink"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   width="300" height="200" id="svg2" version="1.1"
   inkscape:version="0.92.4" sodipodi:docname="drawing.svg">
  <metadata id="metadata8">
    <rdf:RDF>
      <cc:Work rdf:about="">
        <dc:format>image/svg+xml</dc:format>
        <dc:title></dc:title>
      </cc:Work>
    </rdf:RDF>
  </metadata>
  <sodipodi:namedview id="base" pagecolor="#ffffff" bordercolor="#666666" inkscape:zoom="0.35" inkscape:cx="50" inkscape:cy="50" />
  <defs id="defs4">
    <linearGradient id="grad1">
      <stop offset="0" style="stop-color:#ffffff;stop-opacity:1" />
      <stop offset="1" style="stop-color:#0000ff;stop-opacity:1" />
    </linearGradient>
  </defs>
  <g id="layer1" inkscape:label="Layer 1" inkscape:groupmode="layer">
    <path id="p1" d="M 10,10 L 100,10 L 100,100 Z" style="fill:url(#grad1);stroke:none" />
${shapes}
  </g>
</svg>
`;
}

export const sqlite = (path: string, sql: string) => {
  const r = Bun.spawnSync(["sqlite3", path, sql]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

/** A database with a table, an index, a view and a trigger, then a lot of rows deleted so it has free pages. */
export function fragmentedDb(path: string, extra = "") {
  sqlite(
    path,
    `${extra}
PRAGMA user_version=7; PRAGMA application_id=1234;
CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, body BLOB);
CREATE TABLE loose(a, b);
CREATE INDEX t_name ON t(name);
CREATE VIEW v AS SELECT id, name FROM t WHERE id % 2 = 0;
CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO loose VALUES (new.id, 'x'); END;
WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 3000) INSERT INTO t SELECT i, 'name' || i, zeroblob(200) FROM c;
DELETE FROM t WHERE id % 3 != 0;
INSERT INTO loose VALUES (1,2),(3,'four');`,
  );
}

/**
 * A fake tool written as a bun script, so it runs the same on every OS. `body` is JavaScript with `args`, `IN` and `OUT`
 * (the last two arguments: minify's input and `-o` target), `run(cmd, args)` and `pass(cmd, args)` (run and relay output and exit code).
 */
export async function fakeTool(dir: string, name: string, body: string): Promise<string[]> {
  const p = join(dir, name + ".js");
  await Bun.write(
    p,
    `const { spawnSync } = require("node:child_process"), fs = require("node:fs");
const args = process.argv.slice(2), IN = args[args.length - 1], OUT = args[args.length - 2];
const run = (cmd, a) => spawnSync(cmd, a, { encoding: "utf8" });
const pass = (cmd, a) => { const r = run(cmd, a); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1); };
${body}\n`,
  );
  return [process.execPath, p];
}

/** A minify that runs the real one for `type` and then rewrites its output with `edit` (JavaScript: a function of the text). */
export const tamperedMinify = (dir: string, name: string, type: string, edit: string, extra = "") =>
  fakeTool(dir, name, `if (run(Bun.which("minify"), ["--type", "${type}", ${extra ? `"${extra}", ` : ""}"-o", OUT, IN]).status !== 0) process.exit(1);\nfs.writeFileSync(OUT, (${edit})(fs.readFileSync(OUT, "utf8")));`);
