import { List, Text, View, clipboard, reveal, showMenu } from "mantou-ui";
import { percent, size } from "./files";
import type { Item, ItemStatus, SortKey, Store } from "./store";
import { c } from "./theme";

const W = { format: 64, before: 82, after: 82, saved: 66, status: 200 };
const ROW = 34;

const label: Record<ItemStatus, string> = { queued: "Queued", working: "Working…", optimized: "Optimized", unchanged: "Unchanged", skipped: "Skipped", failed: "Failed" };
const color: Record<ItemStatus, string> = { queued: c.dim, working: c.accent, optimized: c.good, unchanged: c.dim, skipped: c.warn, failed: c.bad };

export const statusText = (i: Item) => (i.dry && i.status === "optimized" ? "Dry run" : i.reason && (i.status === "skipped" || i.status === "failed") ? `${label[i.status]}: ${i.reason}` : label[i.status]);

const cell = (width: number, align: "start" | "end" = "start") => ({ width, flexShrink: 0, paddingLeft: 8, paddingRight: 8, justifyContent: "center", alignItems: align } as const);
const num = { fontSize: 12, color: c.dim, whiteSpace: "nowrap" } as const;

/** Runs a row's context-menu choice on the selected files. */
export async function rowAction(store: Store, id: string | null) {
  const paths = [...store.selected()];
  if (id === "reveal") await reveal(paths[0]);
  else if (id === "copy") await clipboard.writeText(paths.join("\n"));
  else if (id === "remove") store.remove(paths);
  else if (id === "again") await store.again(paths);
}

export function FileTable(props: { store: Store }) {
  const { store } = props;
  const col = (key: SortKey, text: string) => {
    const mark = () => (store.sort()?.key === key ? (store.sort()!.dir === 1 ? " ▲" : " ▼") : "");
    return <Text style={head}>{text + mark()}</Text>;
  };
  const sortable = (key: SortKey, text: string, extra: object) => (
    <View role="button" label={`Sort by ${text}`} onPress={() => store.sortBy(key)} style={{ ...extra, cursor: "pointer" }}>{col(key, text)}</View>
  );
  return (
    <View role="list" label="Files" style={{ flexGrow: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", height: 28, alignItems: "center", borderBottomWidth: 1, borderColor: c.line, flexShrink: 0 }}>
        {sortable("name", "Name", { flexGrow: 1, flexBasis: 0, minWidth: 0, paddingLeft: 16, height: 28, justifyContent: "center" })}
        {sortable("format", "Format", { ...cell(W.format), height: 28 })}
        {sortable("before", "Before", { ...cell(W.before, "end"), height: 28 })}
        {sortable("after", "After", { ...cell(W.after, "end"), height: 28 })}
        {sortable("saved", "Saved", { ...cell(W.saved, "end"), height: 28 })}
        {sortable("status", "Status", { ...cell(W.status), height: 28 })}
      </View>
      <List each={store.sorted()} itemHeight={ROW} style={{ flexGrow: 1, minHeight: 0 }}>
        {(row, i) => {
          // a row can be read once more after its item is gone (dunkbing/mantou#78): keep the last one (or a blank)
          let last = row() ?? blank;
          const item = () => (last = row() ?? last);
          return (
          <View
            role="listItem"
            label={`${item().name}: ${statusText(item())}`}
            selected={store.selected().has(item().path)}
            onPointerDown={(e) => e.button === 0 && store.select(item().path, e.shift ? "range" : e.ctrl || e.meta ? "toggle" : "one")}
            onDoubleClick={() => void reveal(item().path)}
            onContextMenu={async (e) => {
              if (!store.selected().has(item().path)) store.select(item().path);
              const n = store.selected().size;
              const id = await showMenu(
                [
                  { id: "reveal", label: "Reveal in folder", enabled: n === 1 },
                  { id: "copy", label: n > 1 ? "Copy paths" : "Copy path" },
                  { separator: true },
                  { id: "again", label: n > 1 ? "Optimize these files again" : "Optimize this file again" },
                  { id: "remove", label: "Remove from list" },
                ],
                { x: e.x, y: e.y },
              );
              await rowAction(store, id);
            }}
            style={{ flexDirection: "row", alignItems: "center", height: ROW, backgroundColor: store.selected().has(item().path) ? c.selected : i % 2 ? c.rowAlt : c.row }}
          >
            <View style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, paddingLeft: 16, paddingRight: 8 }}>
              <Text style={{ fontSize: 13, color: c.text, whiteSpace: "nowrap", maxLines: 1 }}>{item().name}</Text>
            </View>
            <View style={cell(W.format)}><Text style={num}>{item().format || "–"}</Text></View>
            <View style={cell(W.before, "end")}><Text style={num}>{item().before ? size(item().before) : "–"}</Text></View>
            <View style={cell(W.after, "end")}><Text style={num}>{item().status === "optimized" ? size(item().after) : "–"}</Text></View>
            <View style={cell(W.saved, "end")}>
              <Text style={{ ...num, color: item().status === "optimized" ? c.good : c.dim }}>{item().status === "optimized" ? percent(item().before, item().after) : "–"}</Text>
            </View>
            <View style={cell(W.status)}>
              <Text style={{ fontSize: 12, color: color[item().status], whiteSpace: "nowrap", maxLines: 1 }}>{statusText(item())}</Text>
            </View>
          </View>
          );
        }}
      </List>
    </View>
  );
}

const head = { fontSize: 11, fontWeight: 600, color: c.faint, whiteSpace: "nowrap" } as const;

export function EmptyState(props: { over: boolean }) {
  return (
    <View style={{ flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 6 }}>
      <View style={{ width: 360, height: 180, borderRadius: 4, borderWidth: 1, borderColor: props.over ? c.accent : c.line, backgroundColor: props.over ? "#74ade81a" : "transparent", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <Text style={{ fontSize: 17, fontWeight: 600, color: c.text }}>Drop files or folders here</Text>
        <Text style={{ fontSize: 13, color: c.dim }}>or use Add Files and Add Folder</Text>
      </View>
    </View>
  );
}

const blank: Item = { path: "", name: "", format: "", before: 0, after: 0, status: "queued" };
