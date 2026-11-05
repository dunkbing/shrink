// THIRD_PARTY.md, generated from the tool manifest (bun run tools:third-party writes docs/THIRD_PARTY.md).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { manifest, type Manifest } from "../../packages/engine/src/manifest";

const REPO = "https://github.com/dunkbing/shrink";

/** The notice for all tools, or for one pack. */
export function thirdParty(m: Manifest, o: { pack?: string } = {}): string {
  const names = Object.keys(m.tools).filter((n) => !o.pack || m.tools[n].pack === o.pack).sort();
  const copyleft = (l: string) => /GPL/.test(l);
  const rows = names.map((n) => {
    const t = m.tools[n];
    const v = Object.values(t.platforms).find((p) => p?.version)?.version ?? "see the package";
    return `| ${n} | ${t.pack} | ${v} | ${t.licence} | ${t.homepage} |`;
  });
  return `# Third-party tools${o.pack ? ` (pack: ${o.pack})` : ""}

Shrink runs these programs as separate processes; it does not link them. They are distributed unmodified
unless noted, with their own licences. Generated from \`packages/engine/tools/manifest.json\`.

| Tool | Pack | Version | Licence | Home |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Source code

${names.filter((n) => copyleft(m.tools[n].licence)).map((n) => `- ${n} (${m.tools[n].licence}): ${m.tools[n].homepage}`).join("\n") || "- none of these tools is copyleft"}

For the GPL / LGPL / AGPL programs above, the complete corresponding source code is available from the home
pages listed, at the versions in the table. We will also provide it on request for three years after the pack was
published: open an issue at ${REPO}/issues. The build script of the stripped ffmpeg is in the repository
(\`scripts/tools/ffmpeg-min.sh\`); the licence texts shipped by each upstream are in \`licenses/\` where the
upstream archive had them.
`;
}

if (import.meta.main) writeFileSync(resolve(import.meta.dir, "../../docs/THIRD_PARTY.md"), thirdParty(manifest));
