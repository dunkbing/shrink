// What a PDF holds besides its pixels: forms, annotations, links, outlines, destinations, labels, layers, fonts.
// Built from `qpdf --json=2` (object numbers, stream encodings and key order do not matter).
type J = any;

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

export function summarize(json: J): PdfSummary {
  const objs = new Map<string, J>();
  const list: J[] = json.qpdf;
  for (const [k, v] of Object.entries(list[1] ?? {})) if (k.startsWith("obj:")) objs.set(k.slice(4), v);
  const trailer = (list[1]?.trailer?.value ?? {}) as J;
  const pageIdx = new Map<string, number>();

  const get = (v: J): J => {
    let guard = 0;
    while (typeof v === "string" && REF.test(v) && guard++ < 32) {
      const o = objs.get(v);
      v = o ? (o.value !== undefined ? o.value : o.stream ? o.stream.dict : null) : null;
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
    if (v && typeof v === "object") {
      const o: J = {};
      for (const k of Object.keys(v).sort()) if (!SKIP.has(k)) o[k] = canon(v[k], depth, seen);
      return o;
    }
    return v;
  };

  const root = resolve(trailer["/Root"]) ?? {};
  // page tree, in order
  const pages: { ref: string; dict: J; res: J }[] = [];
  const walk = (ref: any, res: J, seen: Set<string>) => {
    if (typeof ref !== "string" || seen.has(ref)) return;
    seen.add(ref);
    const d = resolve(ref);
    if (!d || typeof d !== "object") return;
    const r = d["/Resources"] !== undefined ? d["/Resources"] : res;
    if (Array.isArray(d["/Kids"])) for (const k of resolve(d["/Kids"])) walk(k, r, seen);
    else {
      pageIdx.set(ref, pages.length);
      pages.push({ ref, dict: d, res: r });
    }
  };
  walk(root["/Pages"], null, new Set());

  const ANNOT_KEYS = ["/Subtype", "/Rect", "/Contents", "/A", "/Dest", "/FT", "/T", "/V", "/Ff", "/F", "/C", "/Border", "/NM", "/QuadPoints", "/Name", "/Popup"];
  const annots = pages.map((p, i) => {
    const arr = resolve(p.dict["/Annots"]);
    if (!Array.isArray(arr)) return [];
    return arr.map((a: J) => {
      const d = resolve(a) ?? {};
      const o: J = {};
      for (const k of ANNOT_KEYS) if (d[k] !== undefined) o[k] = canon(d[k], k === "/A" || k === "/Dest" ? 5 : 2, new Set());
      return o;
    });
  });

  const fieldsOut: J[] = [];
  const fieldWalk = (ref: J, prefix: string, depth: number) => {
    const d = resolve(ref);
    if (!d || typeof d !== "object" || depth > 16) return;
    const t = d["/T"] !== undefined ? String(canon(d["/T"], 0, new Set())) : "";
    const name = prefix && t ? `${prefix}.${t}` : prefix || t;
    if (Array.isArray(resolve(d["/Kids"]))) for (const k of resolve(d["/Kids"])) fieldWalk(k, name, depth + 1);
    if (d["/FT"] !== undefined || !Array.isArray(resolve(d["/Kids"])))
      fieldsOut.push({ name, ft: canon(d["/FT"], 0, new Set()), v: canon(d["/V"], 2, new Set()), ff: d["/Ff"] ?? 0, opt: canon(d["/Opt"], 2, new Set()) });
  };
  const af = resolve(root["/AcroForm"]);
  if (af && typeof af === "object") for (const f of resolve(af["/Fields"]) ?? []) fieldWalk(f, "", 0);
  const form = af ? { fields: fieldsOut.sort((a, b) => (a.name < b.name ? -1 : 1)), na: af["/NeedAppearances"] ?? false, sig: af["/SigFlags"] ?? 0 } : null;

  const outlineItems: J[] = [];
  const outWalk = (ref: J, depth: number) => {
    let cur = ref;
    let guard = 0;
    while (cur && guard++ < 100000) {
      const d = resolve(cur);
      if (!d || typeof d !== "object") return;
      outlineItems.push({ depth, title: canon(d["/Title"], 0, new Set()), dest: canon(d["/Dest"], 4, new Set()), a: canon(d["/A"], 5, new Set()), count: d["/Count"] ?? 0 });
      if (d["/First"] && depth < 32) outWalk(d["/First"], depth + 1);
      cur = d["/Next"];
    }
  };
  const ol = resolve(root["/Outlines"]);
  if (ol && ol["/First"]) outWalk(ol["/First"], 0);

  const tree = (ref: J, key: "/Names" | "/Kids", out: J[], depth: number, depthCanon: number) => {
    const d = resolve(ref);
    if (!d || typeof d !== "object" || depth > 16) return;
    const names = resolve(d["/Names"]);
    if (Array.isArray(names)) for (let i = 0; i + 1 < names.length; i += 2) out.push([canon(names[i], 0, new Set()), canon(names[i + 1], depthCanon, new Set())]);
    for (const k of resolve(d["/Kids"]) ?? []) tree(k, key, out, depth + 1, depthCanon);
  };
  const dests: J[] = [];
  const names = resolve(root["/Names"]) ?? {};
  tree(names["/Dests"], "/Names", dests, 0, 4);
  const oldDests = resolve(root["/Dests"]);
  const legacy = oldDests && typeof oldDests === "object" ? canon(oldDests, 4, new Set()) : null;
  const files: J[] = [];
  tree(names["/EmbeddedFiles"], "/Names", files, 0, 1);

  const fonts = new Set<string>();
  const fontOf = (ref: J) => {
    let f = resolve(ref);
    if (!f || typeof f !== "object") return;
    if (f["/Subtype"] === "/Type0") f = resolve(resolve(f["/DescendantFonts"])?.[0]) ?? f;
    const fd = resolve(f?.["/FontDescriptor"]);
    const emb = fd && (fd["/FontFile"] || fd["/FontFile2"] || fd["/FontFile3"]) ? "embedded" : "plain";
    fonts.add(`${f["/Subtype"]}|${f["/BaseFont"]}|${emb}`);
  };
  const seenRes = new Set<string>();
  const resFonts = (res: J, depth: number) => {
    const r = resolve(res);
    if (!r || typeof r !== "object" || depth > 4) return;
    const fs = resolve(r["/Font"]);
    if (fs && typeof fs === "object") for (const v of Object.values(fs)) fontOf(v);
    const xo = resolve(r["/XObject"]);
    if (xo && typeof xo === "object")
      for (const v of Object.values(xo)) {
        const key = String(v);
        if (seenRes.has(key)) continue;
        seenRes.add(key);
        const x = resolve(v);
        if (x && x["/Subtype"] === "/Form") resFonts(x["/Resources"], depth + 1);
      }
  };
  for (const p of pages) resFonts(p.res, 0);

  const oc = resolve(root["/OCProperties"]);
  const ocgs = oc ? (resolve(oc["/OCGs"]) ?? []).map((g: J) => canon(resolve(g)?.["/Name"], 0, new Set())) : null;
  const j = (x: J) => JSON.stringify(x ?? null);
  return {
    pages: pages.length,
    annots: j(annots),
    form: j(form),
    outlines: j(outlineItems),
    names: j({ dests, legacy, files }),
    labels: j(canon(root["/PageLabels"], 4, new Set())),
    layers: j({ ocgs: ocgs?.sort(), d: oc ? canon(oc["/D"], 1, new Set()) : null }),
    fonts: j([...fonts].sort()),
  };
}
