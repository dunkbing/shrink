// What a PDF holds besides its pixels: forms, annotations, links, outlines, destinations, labels, layers, fonts.
// Built from `qpdf --json=2` (object numbers, stream encodings and key order do not matter).
/** A PDF value as `qpdf --json=2` writes it (undefined: a key that is not there). */
type J = undefined | null | boolean | number | string | J[] | { [key: string]: J };
type Dict = { [key: string]: J };

const isDict = (v: J): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
/** `v[k]` when v is a dictionary, else undefined. */
const at = (v: J, k: string): J => (isDict(v) ? v[k] : undefined);
const asArray = (v: J): J[] => (Array.isArray(v) ? v : []);

const SKIP = new Set(["/Parent", "/Prev", "/Next", "/First", "/Last", "/Length", "/Filter", "/DecodeParms", "/DL", "/StructParent", "/StructParents", "/Length1", "/Length2", "/Length3"]);
const REF = /^(\d+) (\d+) R$/;

export interface PdfSummary {
  pages: number;
  annots: string;
  form: string;
  outlines: string;
  names: string;
  labels: string;
  layers: string;
  fonts: string;
}

export function summarize(json: unknown): PdfSummary {
  const objs = new Map<string, J>();
  const list = typeof json === "object" && json !== null && "qpdf" in json ? (json.qpdf as J) : undefined;
  if (!Array.isArray(list)) throw new Error("not qpdf JSON");
  const body = list[1];
  if (isDict(body)) for (const [k, v] of Object.entries(body)) if (k.startsWith("obj:")) objs.set(k.slice(4), v);
  const trailer = at(at(body, "trailer"), "value") ?? {};
  const pageIdx = new Map<string, number>();

  const get = (v: J): J => {
    let guard = 0;
    while (typeof v === "string" && REF.test(v) && guard++ < 32) {
      const o = objs.get(v);
      v = o ? (at(o, "value") !== undefined ? at(o, "value") : at(o, "stream") ? at(at(o, "stream"), "dict") : null) : null;
    }
    return v;
  };
  const resolve = get;

  const canon = (v: J, depth: number, seen: Set<string>): J => {
    if (typeof v === "string") {
      if (REF.test(v)) {
        const p = pageIdx.get(v);
        if (p !== undefined) return `page:${p}`;
        if (depth <= 0 || seen.has(v)) return "ref";
        seen.add(v);
        const r = canon(resolve(v), depth - 1, seen);
        seen.delete(v);
        return r;
      }
      return v;
    }
    if (typeof v === "number") return Math.round(v * 1000) / 1000;
    if (Array.isArray(v)) return v.map((x) => canon(x, depth, seen));
    if (isDict(v)) {
      const o: Dict = {};
      for (const k of Object.keys(v).sort()) if (!SKIP.has(k)) o[k] = canon(v[k], depth, seen);
      return o;
    }
    return v;
  };

  const root = resolve(at(trailer, "/Root")) ?? {};
  // page tree, in order
  const pages: { ref: string; dict: J; res: J }[] = [];
  const walk = (ref: J, res: J, seen: Set<string>) => {
    if (typeof ref !== "string" || seen.has(ref)) return;
    seen.add(ref);
    const d = resolve(ref);
    if (!d || typeof d !== "object") return;
    const r = at(d, "/Resources") !== undefined ? at(d, "/Resources") : res;
    if (Array.isArray(at(d, "/Kids"))) for (const k of asArray(resolve(at(d, "/Kids")))) walk(k, r, seen);
    else {
      pageIdx.set(ref, pages.length);
      pages.push({ ref, dict: d, res: r });
    }
  };
  walk(at(root, "/Pages"), null, new Set());

  const ANNOT_KEYS = ["/Subtype", "/Rect", "/Contents", "/A", "/Dest", "/FT", "/T", "/V", "/Ff", "/F", "/C", "/Border", "/NM", "/QuadPoints", "/Name", "/Popup"];
  const annots = pages.map((p) => {
    const arr = resolve(at(p.dict, "/Annots"));
    if (!Array.isArray(arr)) return [];
    return arr.map((a) => {
      const d = resolve(a) ?? {};
      const o: Dict = {};
      for (const k of ANNOT_KEYS) if (at(d, k) !== undefined) o[k] = canon(at(d, k), k === "/A" || k === "/Dest" ? 5 : 2, new Set());
      return o;
    });
  });

  const fieldsOut: { name: string; ft: J; v: J; ff: J; opt: J }[] = [];
  const fieldWalk = (ref: J, prefix: string, depth: number) => {
    const d = resolve(ref);
    if (!d || typeof d !== "object" || depth > 16) return;
    const t = at(d, "/T") !== undefined ? String(canon(at(d, "/T"), 0, new Set())) : "";
    const name = prefix && t ? `${prefix}.${t}` : prefix || t;
    const kids = resolve(at(d, "/Kids"));
    if (Array.isArray(kids)) for (const k of kids) fieldWalk(k, name, depth + 1);
    if (at(d, "/FT") !== undefined || !Array.isArray(kids))
      fieldsOut.push({ name, ft: canon(at(d, "/FT"), 0, new Set()), v: canon(at(d, "/V"), 2, new Set()), ff: at(d, "/Ff") ?? 0, opt: canon(at(d, "/Opt"), 2, new Set()) });
  };
  const af = resolve(at(root, "/AcroForm"));
  if (af && typeof af === "object") for (const f of asArray(resolve(at(af, "/Fields")))) fieldWalk(f, "", 0);
  const form = af ? { fields: fieldsOut.sort((a, b) => (a.name < b.name ? -1 : 1)), na: at(af, "/NeedAppearances") ?? false, sig: at(af, "/SigFlags") ?? 0 } : null;

  const outlineItems: Dict[] = [];
  const outWalk = (ref: J, depth: number) => {
    let cur = ref;
    let guard = 0;
    while (cur && guard++ < 100000) {
      const d = resolve(cur);
      if (!d || typeof d !== "object") return;
      outlineItems.push({ depth, title: canon(at(d, "/Title"), 0, new Set()), dest: canon(at(d, "/Dest"), 4, new Set()), a: canon(at(d, "/A"), 5, new Set()), count: at(d, "/Count") ?? 0 });
      if (at(d, "/First") && depth < 32) outWalk(at(d, "/First"), depth + 1);
      cur = at(d, "/Next");
    }
  };
  const ol = resolve(at(root, "/Outlines"));
  if (at(ol, "/First")) outWalk(at(ol, "/First"), 0);

  const tree = (ref: J, key: "/Names" | "/Kids", out: J[], depth: number, depthCanon: number) => {
    const d = resolve(ref);
    if (!d || typeof d !== "object" || depth > 16) return;
    const names = resolve(at(d, "/Names"));
    if (Array.isArray(names)) for (let i = 0; i + 1 < names.length; i += 2) out.push([canon(names[i], 0, new Set()), canon(names[i + 1], depthCanon, new Set())]);
    for (const k of asArray(resolve(at(d, "/Kids")))) tree(k, key, out, depth + 1, depthCanon);
  };
  const dests: J[] = [];
  const names = resolve(at(root, "/Names")) ?? {};
  tree(at(names, "/Dests"), "/Names", dests, 0, 4);
  const oldDests = resolve(at(root, "/Dests"));
  const legacy = oldDests && typeof oldDests === "object" ? canon(oldDests, 4, new Set()) : null;
  const files: J[] = [];
  tree(at(names, "/EmbeddedFiles"), "/Names", files, 0, 1);

  const fonts = new Set<string>();
  const fontOf = (ref: J) => {
    let f = resolve(ref);
    if (!f || typeof f !== "object") return;
    if (at(f, "/Subtype") === "/Type0") f = resolve(asArray(resolve(at(f, "/DescendantFonts")))[0]) ?? f;
    const fd = resolve(at(f, "/FontDescriptor"));
    const emb = fd && (at(fd, "/FontFile") || at(fd, "/FontFile2") || at(fd, "/FontFile3")) ? "embedded" : "plain";
    fonts.add(`${at(f, "/Subtype")}|${at(f, "/BaseFont")}|${emb}`);
  };
  const seenRes = new Set<string>();
  const resFonts = (res: J, depth: number) => {
    const r = resolve(res);
    if (!r || typeof r !== "object" || depth > 4) return;
    const fs = resolve(at(r, "/Font"));
    if (isDict(fs)) for (const v of Object.values(fs)) fontOf(v);
    const xo = resolve(at(r, "/XObject"));
    if (isDict(xo))
      for (const v of Object.values(xo)) {
        const key = String(v);
        if (seenRes.has(key)) continue;
        seenRes.add(key);
        const x = resolve(v);
        if (at(x, "/Subtype") === "/Form") resFonts(at(x, "/Resources"), depth + 1);
      }
  };
  for (const p of pages) resFonts(p.res, 0);

  const oc = resolve(at(root, "/OCProperties"));
  const ocgs = oc ? asArray(resolve(at(oc, "/OCGs"))).map((g) => canon(at(resolve(g), "/Name"), 0, new Set())) : null;
  const j = (x: J) => JSON.stringify(x ?? null);
  return {
    pages: pages.length,
    annots: j(annots),
    form: j(form),
    outlines: j(outlineItems),
    names: j({ dests, legacy, files }),
    labels: j(canon(at(root, "/PageLabels"), 4, new Set())),
    layers: j({ ocgs: ocgs?.sort(), d: oc ? canon(at(oc, "/D"), 1, new Set()) : null }),
    fonts: j([...fonts].sort()),
  };
}
