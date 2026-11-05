import { Button, For, Scroll, Show, Slider, Tabs, Text, Toggle, View, createEffect, createSignal, type JSX } from "mantou-ui";
import { Labelled, Section, buttonText, caption, secondary, toggleRow } from "./controls";
import type { AppSettings } from "./settings";
import type { Store } from "./store";
import { c } from "./theme";
import { toolStatus, type ToolInfo, type ToolsState } from "./toolstatus";

function Settings(props: { store: Store }) {
  const s = props.store.settings;
  const set = props.store.setSettings;
  const flag = (key: keyof AppSettings, text: string, hint?: string) => (
    <Toggle checked={!!s()[key]} onChange={(v) => set({ [key]: v })} style={toggleRow}>{caption(text, hint)}</Toggle>
  );
  return (
    <View style={{ gap: 22 }}>
      <Section title="Optimize">
        <Labelled name="Level" value={`${s().level} ${s().level <= 3 ? "fast" : s().level >= 8 ? "extreme" : "balanced"}`}>
          <Slider value={s().level} min={1} max={9} step={1} label="Level" onChange={(level) => set({ level })} />
        </Labelled>
        {flag("lossy", "Allow lossy", "May change pixels slightly in images")}
        {flag("keepMetadata", "Keep metadata", "EXIF, comments, tags")}
        {flag("skipOptimized", "Skip optimized files", "Files done before are left alone")}
        {flag("dryRun", "Dry run", "Report the sizes, change nothing")}
        <Labelled name="Workers" value={s().workers ? String(s().workers) : "Auto"}>
          <Slider value={s().workers} min={0} max={16} step={1} label="Workers" onChange={(workers) => set({ workers })} />
        </Labelled>
      </Section>
      <Section title="App">
        {flag("notifications", "Notifications", "When a run ends")}
        {flag("closeToTray", "Close to tray", "Closing the window keeps Shrink running")}
        {flag("launchAtLogin", "Launch at login")}
      </Section>
      <Section title="Also optimize">
        {flag("html", "HTML")}
        {flag("css", "CSS")}
        {flag("js", "JavaScript")}
        {flag("exe", "Executables", "Programs and libraries")}
        {flag("lua", "Lua scripts", "Minify")}
      </Section>
    </View>
  );
}

const label = (t: ToolInfo) =>
  t.state === "ready" ? "ready" : t.state === "downloading" ? (t.progress !== undefined ? `downloading ${Math.round(t.progress * 100)}%` : "downloading") : t.state === "waiting" ? "waiting" : t.state === "on demand" ? "when needed" : t.state === "failed" ? "failed" : "unavailable";

function Tools(props: { tools?: ToolsState }) {
  const [tools, setTools] = createSignal<ToolInfo[] | null>(null);
  // looks again whenever a download moves on
  createEffect(() => {
    props.tools?.packs();
    void toolStatus({}, props.tools?.provisioner).then(setTools);
  });
  const missing = () => tools()?.filter((t) => t.state === "missing" || t.state === "failed").length ?? 0;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "spaceBetween" }}>
        <Text style={{ fontSize: 12, color: c.dim }} role="status">{tools() ? `${tools()!.filter((t) => t.found).length} of ${tools()!.length} ready` : "Looking…"}</Text>
        <Show when={props.tools?.failed()}>
          <Button variant="secondary" onPress={() => props.tools?.retry()} style={secondary}>{buttonText("Retry")}</Button>
        </Show>
      </View>
      <Text style={{ fontSize: 11, color: c.faint }}>{missing() ? "Formats whose tool is unavailable are skipped." : "Tools are prepared automatically."}</Text>
      <For each={tools() ?? []}>
        {(t) => (
          <View role="listItem" label={`${t.name}: ${label(t)}`} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: t.state === "ready" ? c.good : t.state === "failed" || t.state === "missing" ? c.bad : c.faint }} />
            <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 13, color: t.found ? c.text : c.dim }}>{t.name}</Text>
              <Text style={{ fontSize: 11, color: c.faint, maxLines: 1 }}>{t.formats.join(", ")}</Text>
            </View>
            <Text style={{ fontSize: 11, color: t.state === "failed" || t.state === "missing" ? c.bad : c.faint }}>{label(t)}</Text>
          </View>
        )}
      </For>
    </View>
  );
}

export function SidePanel(props: { store: Store; tools?: ToolsState }) {
  const [tab, setTab] = createSignal<"settings" | "tools">("settings");
  const name = (id: "settings" | "tools", text: string) => <Text style={{ fontSize: 13, fontWeight: 600, color: tab() === id ? c.text : c.dim }}>{text}</Text>;
  return (
    <View style={{ width: 290, flexShrink: 0, borderLeftWidth: 1, borderColor: c.line, backgroundColor: c.panel }}>
      <Tabs
        tabs={[{ id: "settings", label: name("settings", "Settings") }, { id: "tools", label: name("tools", "Tools") }]}
        value={tab()}
        onChange={setTab}
        style={{ flexGrow: 1, minHeight: 0, gap: 0, paddingTop: 8 }}
      >
        {(id) => <Pane>{id === "settings" ? <Settings store={props.store} /> : <Tools tools={props.tools} />}</Pane>}
      </Tabs>
    </View>
  );
}

function Pane(props: { children: JSX.Element }) {
  return <Scroll style={{ flexGrow: 1, minHeight: 0 }} contentStyle={{ padding: 16 }}>{props.children}</Scroll>;
}
