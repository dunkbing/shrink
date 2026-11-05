import { env } from "../packages/engine/test/fake";
import { exe } from "../packages/engine/src/formats/exe.format";
import { makePe } from "../packages/engine/test/lib/exe";
import { pdf } from "../packages/engine/src/formats/pdf.format";
import { makePdf } from "../packages/engine/test/lib/pdf";
for (const [f, name, bytes, settings] of [[exe, "a.exe", makePe({ symbols: 40, debugSection: true, checksum: true }), { exe: { enabled: true } }], [pdf, "a.pdf", makePdf({ pages: 3, image: 20000 }), {}]] as const) {
  const e = env({ formats: [f], settings: settings as any });
  const p = await e.file(name, bytes);
  const t = performance.now();
  const r = await e.engine.optimizeFile(p);
  console.log(name, Math.round(performance.now() - t), "ms", JSON.stringify(r, null, 1));
  e.cleanup();
}
process.exit(0);
