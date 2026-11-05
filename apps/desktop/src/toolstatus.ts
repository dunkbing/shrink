import { ToolProvisioner, allFormats, createTools, resolve, type DeepPartial, type PackState, type Settings } from "@shrink/engine";
import { createMemo, createSignal } from "mantou-ui";

export type ToolState = "ready" | "downloading" | "waiting" | "on demand" | "failed" | "missing";

export interface ToolInfo {
  name: string;
  /** The formats whose steps use it. */
  formats: string[];
  found: boolean;
  state: ToolState;
  /** Download progress, 0 to 1. */
  progress?: number;
  error?: string;
}

/** The tools the app downloads by itself, and what that is doing right now. */
export function createToolsState(provisioner = new ToolProvisioner()) {
  const [packs, setPacks] = createSignal<PackState[]>([]);
  provisioner.listen(() => setPacks(provisioner.states()));
  const active = createMemo(() => packs().filter((p) => p.phase === "waiting" || p.phase === "downloading" || p.phase === "verifying" || p.phase === "extracting"));
  const failed = createMemo(() => packs().filter((p) => p.phase === "failed" || p.phase === "offline"));
  /** 0 to 1 over everything being downloaded. */
  const fraction = createMemo(() => {
    const total = active().reduce((n, p) => n + p.total, 0);
    return total ? active().reduce((n, p) => n + p.received, 0) / total : 0;
  });
  return {
    provisioner,
    packs,
    busy: () => active().length > 0,
    failed: () => failed().length > 0,
    fraction,
    retry() {
      provisioner.retry();
      setPacks(provisioner.states());
      void provisioner.prefetch();
    },
  };
}

export type ToolsState = ReturnType<typeof createToolsState>;

/** Every external tool the formats can use, and where it is. */
export async function toolStatus(settings: DeepPartial<Settings> = {}, provisioner?: ToolProvisioner): Promise<ToolInfo[]> {
  const tools = createTools(resolve(settings), undefined, provisioner);
  const used = new Map<string, Set<string>>();
  for (const f of allFormats) for (const s of f.steps) if (s.tool) used.set(s.tool, (used.get(s.tool) ?? new Set()).add(f.id));
  const list = await Promise.all(
    [...used].map(async ([name, formats]): Promise<ToolInfo> => {
      const found = !!(await tools.locate(name));
      const base = { name, formats: [...formats].sort(), found };
      if (found) return { ...base, state: "ready" };
      const s = provisioner?.stateOf(name);
      if (s?.phase === "failed" || s?.phase === "offline") return { ...base, state: "failed", error: s.error };
      if (s && s.phase !== "ready") return { ...base, state: s.phase === "waiting" ? "waiting" : "downloading", progress: s.total ? s.received / s.total : undefined };
      return { ...base, state: provisioner?.canProvide(name) ? "on demand" : "missing" };
    }),
  );
  const rank: Record<ToolState, number> = { failed: 0, missing: 1, downloading: 2, waiting: 3, "on demand": 4, ready: 5 };
  return list.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}
