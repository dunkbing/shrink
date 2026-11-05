import { Button, Progress, Show, Text, View, createSignal, message, onKey, type DropEvent } from "mantou-ui";
import { buttonText, primary, secondary } from "./controls";
import { EmptyState, FileTable } from "./FileTable";
import { percent, size } from "./files";
import { pickFiles, pickFolders } from "./pick";
import { SidePanel } from "./SidePanel";
import type { ToolsState } from "./toolstatus";
import type { Store } from "./store";
import { c } from "./theme";

export function App(props: { store: Store; tools?: ToolsState }) {
  const { store } = props;
  const [over, setOver] = createSignal(false);
  // Delete removes the selected rows; Cmd/Ctrl+A selects all, +O adds files
  onKey((e) => {
    if (e.type !== "keyDown") return;
    const mod = e.meta || e.ctrl;
    if (e.key === "Delete" || e.key === "Backspace") store.removeSelected();
    else if (mod && e.key.toLowerCase() === "a") store.selectAll();
    else if (mod && e.key.toLowerCase() === "o") void (e.shift ? pickFolders(store) : pickFiles(store));
  });
  const addFiles = () => pickFiles(store);
  const addFolder = () => pickFolders(store);
  const queued = () => store.items().filter((i) => i.status === "queued").length;
  const fraction = () => (store.runTotal() ? store.runDone() / store.runTotal() : 0);
  const confirmedClear = async () => {
    if (store.items().length > 20 && (await message({ title: "Clear the list?", message: "The results are removed from the list. The files are not touched.", buttons: ["Clear", "Cancel"] })) !== 0) return;
    store.clear();
  };

  return (
    <View
      onDragOver={(e: DropEvent | null) => setOver(e !== null)}
      onDrop={(e) => {
        setOver(false);
        if (e.files.length) void store.add(e.files);
      }}
      style={{ flexGrow: 1, minHeight: 0, flexDirection: "row", backgroundColor: c.bg }}
    >
      <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, paddingLeft: 16, borderBottomWidth: 1, borderColor: c.line, flexShrink: 0 }}>
          <Button variant="secondary" style={secondary} onPress={addFiles}>{buttonText("Add Files")}</Button>
          <Button variant="secondary" style={secondary} onPress={addFolder}>{buttonText("Add Folder")}</Button>
          <Button variant="secondary" style={secondary} onPress={confirmedClear} disabled={store.items().every((i) => i.status === "working")}>{buttonText("Clear")}</Button>
          <View style={{ flexGrow: 1 }} />
          <Show when={store.running()} fallback={<Button style={primary} onPress={() => void store.start()} disabled={queued() === 0}>{buttonText("Start", true)}</Button>}>
            <Button style={primary} onPress={store.stop}>{buttonText("Stop", true)}</Button>
          </Show>
        </View>
        <Show when={store.items().length > 0} fallback={<EmptyState over={over()} />}>
          <FileTable store={store} />
        </Show>
        <View style={{ flexShrink: 0, gap: 8, padding: 12, paddingLeft: 16, paddingRight: 16, borderTopWidth: 1, borderColor: c.line }}>
          <Progress value={fraction()} label={`${Math.round(fraction() * 100)}%`} style={{ height: 3, borderRadius: 1, backgroundColor: c.control, opacity: store.running() ? 1 : 0.5 }} />
          <View style={{ flexDirection: "row", justifyContent: "spaceBetween", alignItems: "center", gap: 12 }}>
            <Text style={{ fontSize: 12, color: c.dim }} role="status">
              {store.running() ? `${store.runDone()} of ${store.runTotal()} files` : `${store.items().length} ${store.items().length === 1 ? "file" : "files"}`}
            </Text>
            <Show when={props.tools?.busy()} fallback={<Show when={props.tools?.failed()}><Text style={{ fontSize: 12, color: c.faint }} role="status">Some tools could not be downloaded</Text></Show>}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 12, color: c.faint }} role="status">Preparing tools…</Text>
                <Progress value={props.tools!.fraction()} label="Preparing tools" style={{ width: 70, height: 3, borderRadius: 1, backgroundColor: c.control }} />
              </View>
            </Show>
            <View style={{ flexGrow: 1 }} />
            <Text style={{ fontSize: 12, color: store.totals().saved > 0 ? c.good : c.dim }} role="status">
              {store.totals().saved === 0 && store.drySaved() > 0 ? `Could save ${size(store.drySaved())}` : store.totals().saved > 0 ? `Saved ${size(store.totals().saved)} (${percent(store.totals().before, store.totals().before - store.totals().saved)})` : "Nothing saved yet"}
            </Text>
          </View>
        </View>
      </View>
      <SidePanel store={store} tools={props.tools} />
      <Show when={over() && store.items().length > 0}>
        <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderWidth: 2, borderColor: c.accent, backgroundColor: "#4c8dff1a", alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 18, fontWeight: 600, color: c.text }}>Drop to add</Text>
        </View>
      </Show>
    </View>
  );
}
