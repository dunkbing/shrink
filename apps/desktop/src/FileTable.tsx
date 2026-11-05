import { List, Text, View, reveal } from "mantou-ui";
import { percent, size } from "./files";
import type { Item, ItemStatus } from "./store";
import { c } from "./theme";

const W = { format: 64, before: 82, after: 82, saved: 66, status: 200 };
const ROW = 34;

const label: Record<ItemStatus, string> = { queued: "Queued", working: "Working…", optimized: "Optimized", unchanged: "Unchanged", skipped: "Skipped", failed: "Failed" };
const color: Record<ItemStatus, string> = { queued: c.dim, working: c.accent, optimized: c.good, unchanged: c.dim, skipped: c.warn, failed: c.bad };

export const statusText = (i: Item) => (i.reason && (i.status === "skipped" || i.status === "failed") ? `${label[i.status]}: ${i.reason}` : label[i.status]);

const cell = (width: number, align: "start" | "end" = "start") => ({ width, flexShrink: 0, paddingLeft: 8, paddingRight: 8, justifyContent: "center", alignItems: align } as const);
const num = { fontSize: 12, color: c.dim, whiteSpace: "nowrap" } as const;

export function FileTable(props: { items: Item[] }) {
  return (
    <View role="list" label="Files" style={{ flexGrow: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", height: 28, alignItems: "center", borderBottomWidth: 1, borderColor: c.line, flexShrink: 0 }}>
        <View style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, paddingLeft: 16 }}><Text style={head}>Name</Text></View>
        <View style={cell(W.format)}><Text style={head}>Format</Text></View>
        <View style={cell(W.before, "end")}><Text style={head}>Before</Text></View>
        <View style={cell(W.after, "end")}><Text style={head}>After</Text></View>
        <View style={cell(W.saved, "end")}><Text style={head}>Saved</Text></View>
        <View style={cell(W.status)}><Text style={head}>Status</Text></View>
      </View>
      <List each={props.items} itemHeight={ROW} style={{ flexGrow: 1, minHeight: 0 }}>
        {(item, i) => (
          <View
            role="listItem"
            label={`${item().name}: ${statusText(item())}`}
            onPress={() => void reveal(item().path)}
            style={{ flexDirection: "row", alignItems: "center", height: ROW, backgroundColor: i % 2 ? c.rowAlt : c.row, cursor: "pointer" }}
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
        )}
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
