import { allFormats, createTools, resolve, type DeepPartial, type Settings } from "@shrink/engine";

export interface ToolInfo {
  name: string;
  /** The formats whose steps use it. */
  formats: string[];
  found: boolean;
}

/** Every external tool the formats can use, and whether it is installed. */
export async function toolStatus(settings: DeepPartial<Settings> = {}): Promise<ToolInfo[]> {
  const tools = createTools(resolve(settings));
  const used = new Map<string, Set<string>>();
  for (const f of allFormats) for (const s of f.steps) if (s.tool) used.set(s.tool, (used.get(s.tool) ?? new Set()).add(f.id));
  const list = await Promise.all([...used].map(async ([name, formats]) => ({ name, formats: [...formats].sort(), found: !!(await tools.locate(name)) })));
  return list.sort((a, b) => Number(a.found) - Number(b.found) || a.name.localeCompare(b.name));
}
