// Writers for the text-format tests: SVG, SQLite, and a script that stands in for a minifier.
import { chmodSync } from "node:fs";
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

/** An executable script that stands in for a tool: `body` is shell; `$IN` and `$OUT` are the last two arguments (minify's input and `-o` target). */
export async function fakeTool(dir: string, name: string, body: string): Promise<string[]> {
  const p = join(dir, name);
  await Bun.write(p, `#!/bin/sh\nIN=; OUT=; for a in "$@"; do OUT=$IN; IN=$a; done\n${body}\n`);
  chmodSync(p, 0o755);
  return [p];
}
