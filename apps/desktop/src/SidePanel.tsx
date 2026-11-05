import { Button, For, Scroll, Slider, Tabs, Text, Toggle, View, createSignal, onMount, type JSX } from "mantou-ui";
import { Labelled, Section, buttonText, caption, secondary, toggleRow } from "./controls";
import type { AppSettings } from "./settings";
import type { Store } from "./store";
import { c } from "./theme";
import { toolStatus, type ToolInfo } from "./toolstatus";

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
        <Labelled name="Workers" value={s().workers ? String(s().workers) : "Auto"}>
          <Slider value={s().workers} min={0} max={16} step={1} label="Workers" onChange={(workers) => set({ workers })} />
        </Labelled>
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

function Tools() {
  const [tools, setTools] = createSignal<ToolInfo[] | null>(null);
  const refresh = () => {
    setTools(null);
    void toolStatus().then(setTools);
  };
  onMount(refresh);
  const missing = () => tools()?.filter((t) => !t.found).length ?? 0;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "spaceBetween" }}>
        <Text style={{ fontSize: 12, color: c.dim }} role="status">{tools() ? `${tools()!.length - missing()} found, ${missing()} missing` : "Looking…"}</Text>
        <Button variant="secondary" onPress={refresh} style={secondary}>{buttonText("Check again")}</Button>
      </View>
      <Text style={{ fontSize: 11, color: c.faint }}>Formats whose tool is missing are skipped.</Text>
      <For each={tools() ?? []}>
        {(t) => (
          <View role="listItem" label={`${t.name}: ${t.found ? "found" : "missing"}`} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: t.found ? c.good : c.bad }} />
            <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 13, color: t.found ? c.text : c.dim }}>{t.name}</Text>
              <Text style={{ fontSize: 11, color: c.faint, maxLines: 1 }}>{t.formats.join(", ")}</Text>
            </View>
            <Text style={{ fontSize: 11, color: t.found ? c.faint : c.bad }}>{t.found ? "found" : "missing"}</Text>
          </View>
        )}
      </For>
    </View>
  );
}

export function SidePanel(props: { store: Store }) {
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
        {(id) => <Pane>{id === "settings" ? <Settings store={props.store} /> : <Tools />}</Pane>}
      </Tabs>
    </View>
  );
}

function Pane(props: { children: JSX.Element }) {
  return <Scroll style={{ flexGrow: 1, minHeight: 0 }} contentStyle={{ padding: 16 }}>{props.children}</Scroll>;
}
