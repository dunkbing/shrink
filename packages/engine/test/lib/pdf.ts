// A small PDF writer for fixtures: classic xref, uncompressed streams, optional forms, annotations, outlines, layers.
export interface PdfSpec {
  pages?: number;
  /** Lines of text per page (repeated so the content stream is compressible). */
  lines?: number;
  annots?: boolean;
  form?: boolean;
  outlines?: boolean;
  labels?: boolean;
  layers?: boolean;
  /** Adds a signature-looking field with a /ByteRange. */
  signed?: boolean;
  /** Adds XMP metadata marking the file as PDF/A-1b. */
  pdfa?: boolean;
  /** An embedded TrueType-like font program (random bytes: only its presence matters for the checks). */
  embeddedFont?: boolean;
  /** Bytes of an uncompressed image per page (0 = none). */
  image?: number;
}

const enc = new TextEncoder();

export function makePdf(spec: PdfSpec = {}): Uint8Array {
  const n = spec.pages ?? 1;
  const objs: (string | Uint8Array)[] = []; // index = object number - 1
  const add = (body: string | Uint8Array) => (objs.push(body), objs.length);
  const stream = (dict: string, data: string | Uint8Array) => {
    const d = typeof data === "string" ? enc.encode(data) : data;
    const head = enc.encode(`<< ${dict} /Length ${d.length} >>\nstream\n`);
    const out = new Uint8Array(head.length + d.length + 10);
    out.set(head);
    out.set(d, head.length);
    out.set(enc.encode("\nendstream"), head.length + d.length);
    return out;
  };

  const catalogId = add(""); // 1
  const pagesId = add(""); // 2
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // 3
  let fontRes = `/F1 ${fontId} 0 R`;
  if (spec.embeddedFont) {
    const prog = new Uint8Array(3000);
    let s = 12345;
    for (let i = 0; i < prog.length; i++) (s = (s * 1103515245 + 12345) & 0x7fffffff), (prog[i] = i % 7 === 0 ? s >> 16 : 65);
    const ff = add(stream("/Length1 3000", prog));
    const fd = add(`<< /Type /FontDescriptor /FontName /ABCDEF+Fake /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${ff} 0 R >>`);
    const f2 = add(`<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Fake /FirstChar 32 /LastChar 33 /Widths [300 400] /FontDescriptor ${fd} 0 R >>`);
    fontRes += ` /F2 ${f2} 0 R`;
  }
  let ocgId = 0;
  if (spec.layers) ocgId = add("<< /Type /OCG /Name (Layer A) >>");
  const pageIds: number[] = [];
  const annotIds: number[][] = [];
  const widgetIds: number[] = [];
  const reserved: number[] = [];
  for (let i = 0; i < n; i++) reserved.push(add("")); // page objects, filled below
  for (let i = 0; i < n; i++) {
    let text = "BT /F1 12 Tf 14 TL 50 740 Td\n";
    for (let l = 0; l < (spec.lines ?? 30); l++) text += `(Page ${i + 1} line ${l}: the quick brown fox jumps over the lazy dog) Tj T*\n`;
    text += "ET\n";
    if (spec.layers) text = `/OC /MC0 BDC ${text} EMC\n`;
    const cid = add(stream("", text));
    let xobj = "";
    if (spec.image) {
      const img = new Uint8Array(spec.image);
      for (let p = 0; p < img.length; p++) img[p] = (p >> 5) & 255;
      const w = 100, h = Math.max(1, Math.floor(spec.image / 300));
      const iid = add(stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8`, img.subarray(0, w * h * 3)));
      xobj = `/XObject << /Im1 ${iid} 0 R >>`;
    }
    const annots: number[] = [];
    if (spec.annots) {
      annots.push(add(`<< /Type /Annot /Subtype /Link /Rect [50 700 200 720] /Border [0 0 0] /A << /S /URI /URI (https://example.com/p${i + 1}) >> >>`));
      annots.push(add(`<< /Type /Annot /Subtype /Text /Rect [300 700 320 720] /Contents (note ${i + 1}) /Open false >>`));
    }
    if (spec.form && i === 0) {
      const w = add(`<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Alice) /Rect [50 600 250 620] /DA (/F1 10 Tf 0 g) /F 4 /P ${reserved[0]} 0 R >>`);
      widgetIds.push(w);
      annots.push(w);
    }
    if (spec.signed && i === 0) {
      const w = add(`<< /Type /Annot /Subtype /Widget /FT /Sig /T (Sig1) /Rect [0 0 0 0] /F 132 /V << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 300] /Contents <00> >> >>`);
      widgetIds.push(w);
      annots.push(w);
    }
    annotIds.push(annots);
    const props = spec.layers ? `/Properties << /MC0 ${ocgId} 0 R >>` : "";
    const page = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${cid} 0 R /Resources << /Font << ${fontRes} >> ${xobj} ${props} >>${annots.length ? ` /Annots [${annots.map((a) => a + " 0 R").join(" ")}]` : ""} >>`;
    objs[reserved[i] - 1] = page;
    pageIds.push(reserved[i]);
  }
  objs[pagesId - 1] = `<< /Type /Pages /Count ${n} /Kids [${pageIds.map((p) => p + " 0 R").join(" ")}] >>`;
  let extra = "";
  if (widgetIds.length) extra += ` /AcroForm << /Fields [${widgetIds.map((p) => p + " 0 R").join(" ")}] /DA (/F1 10 Tf 0 g) /DR << /Font << /F1 ${fontId} 0 R >> >>${spec.signed ? " /SigFlags 3" : ""} >>`;
  if (spec.outlines) {
    const outId = add("");
    const items = pageIds.slice(0, 3).map((p, i) => add(`<< /Title (Chapter ${i + 1}) /Parent ${outId} 0 R /Dest [${p} 0 R /XYZ 0 792 0] >>`));
    items.forEach((it, i) => {
      if (i > 0) objs[it - 1] = (objs[it - 1] as string).replace(">>", `/Prev ${items[i - 1]} 0 R >>`);
      if (i < items.length - 1) objs[it - 1] = (objs[it - 1] as string).replace(/>>$/, `/Next ${items[i + 1]} 0 R >>`);
    });
    objs[outId - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`;
    extra += ` /Outlines ${outId} 0 R /PageMode /UseOutlines`;
    extra += ` /Names << /Dests << /Names [(intro) [${pageIds[0]} 0 R /Fit]] >> >>`;
  }
  if (spec.labels) extra += ` /PageLabels << /Nums [0 << /S /r >> ${Math.min(2, n - 1)} << /S /D /P (A-) >>] >>`;
  if (spec.layers) extra += ` /OCProperties << /OCGs [${ocgId} 0 R] /D << /Order [${ocgId} 0 R] /ON [${ocgId} 0 R] >> >>`;
  if (spec.pdfa) {
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    extra += ` /Metadata ${add(stream("/Type /Metadata /Subtype /XML", xmp))} 0 R`;
  }
  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${extra} >>`;

  const parts: Uint8Array[] = [new Uint8Array([...enc.encode("%PDF-1.4\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 10])];
  let off = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(off);
    const body = typeof o === "string" ? enc.encode(o) : o;
    const a = enc.encode(`${i + 1} 0 obj\n`);
    const b = enc.encode("\nendobj\n");
    parts.push(a, body, b);
    off += a.length + body.length + b.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += String(o).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  return Buffer.concat(parts);
}
