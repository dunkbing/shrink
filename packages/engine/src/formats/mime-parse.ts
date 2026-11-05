// A lossless MIME reader: every byte of the message is kept in the tree, so it can be rebuilt exactly.
// Text is handled as latin1 so one character is one byte.
export interface Entity {
  /** Header lines including the blank line that ends them. */
  head: string;
  headers: [string, string][];
  /** Leaf body (the raw, still-encoded text). */
  body?: string;
  multi?: { preamble: string; parts: { delim: string; entity: Entity }[]; close: string; epilogue: string };
}

export const header = (e: Entity, name: string) => e.headers.find(([n]) => n.toLowerCase() === name)?.[1];

function parseHeaders(head: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of head.split(/\r?\n/)) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1][1] += " " + line.trim();
    else {
      const i = line.indexOf(":");
      if (i <= 0 || /[\s]/.test(line.slice(0, i))) throw new Error("bad header line");
      out.push([line.slice(0, i), line.slice(i + 1).trim()]);
    }
  }
  return out;
}

export function contentType(e: Entity): { type: string; boundary?: string } {
  const v = header(e, "content-type") ?? "text/plain";
  const type = v.split(";")[0].trim().toLowerCase();
  const m = /boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(v);
  return { type, boundary: m ? (m[1] ?? m[2]) : undefined };
}

export const transferEncoding = (e: Entity) => (header(e, "content-transfer-encoding") ?? "7bit").trim().toLowerCase();

export function parseEntity(text: string, depth = 0): Entity {
  if (depth > 20) throw new Error("MIME nesting too deep");
  const m = /\r?\n\r?\n/.exec(text);
  let head: string, rest: string;
  if (text.startsWith("\r\n") || text.startsWith("\n")) {
    head = text.startsWith("\r\n") ? "\r\n" : "\n";
    rest = text.slice(head.length);
  } else if (m) {
    head = text.slice(0, m.index + m[0].length);
    rest = text.slice(head.length);
  } else {
    head = text;
    rest = "";
  }
  const e: Entity = { head, headers: parseHeaders(head) };
  const ct = contentType(e);
  if (ct.type.startsWith("multipart/")) {
    if (!ct.boundary) throw new Error("multipart without a boundary");
    const open = "--" + ct.boundary;
    const lines = rest.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let preamble = "";
    let epilogue = "";
    let close = "";
    const parts: { delim: string; entity: Entity }[] = [];
    let cur: string | null = null;
    let delim = "";
    let state: "pre" | "part" | "post" = "pre";
    for (const line of lines) {
      const t = line.replace(/[ \t]*\r?\n?$/, "");
      if (state !== "post" && t === open) {
        if (cur !== null) parts.push({ delim, entity: parseEntity(cur, depth + 1) });
        delim = line;
        cur = "";
        state = "part";
      } else if (state === "part" && t === open + "--") {
        parts.push({ delim, entity: parseEntity(cur!, depth + 1) });
        close = line;
        cur = null;
        state = "post";
      } else if (state === "pre") preamble += line;
      else if (state === "part") cur += line;
      else epilogue += line;
    }
    if (state !== "post") throw new Error("multipart is not closed (truncated)");
    e.multi = { preamble, parts, close, epilogue };
  } else e.body = rest;
  return e;
}

export function build(e: Entity): string {
  if (e.multi) return e.head + e.multi.preamble + e.multi.parts.map((p) => p.delim + build(p.entity)).join("") + e.multi.close + e.multi.epilogue;
  return e.head + (e.body ?? "");
}

export interface Leaf {
  entity: Entity;
  path: string;
}

/** Leaves in order, and the text that must stay byte-identical (everything but leaf bodies). */
export function flatten(e: Entity, path = "0", fixed: string[] = [], leaves: Leaf[] = []): { fixed: string[]; leaves: Leaf[] } {
  fixed.push(e.head);
  if (e.multi) {
    fixed.push(e.multi.preamble);
    e.multi.parts.forEach((p, i) => {
      fixed.push(p.delim);
      flatten(p.entity, `${path}.${i}`, fixed, leaves);
    });
    fixed.push(e.multi.close, e.multi.epilogue);
  } else leaves.push({ entity: e, path });
  return { fixed, leaves };
}

export function decodeBase64(body: string): Uint8Array | null {
  const t = body.replace(/\s+/g, "");
  if (!t || t.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return null;
  return new Uint8Array(Buffer.from(t, "base64"));
}

/** Base64 laid out like `like` (line length, line ending, final line break). */
export function encodeBase64Like(data: Uint8Array, like: string): string {
  const eol = like.includes("\r\n") ? "\r\n" : "\n";
  const first = like.split(/\r?\n/)[0].length;
  const width = first >= 4 && first % 4 === 0 ? first : 76;
  const b64 = Buffer.from(data).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return lines.join(eol) + (/\r?\n$/.test(like) ? eol : "");
}
