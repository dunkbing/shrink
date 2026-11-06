// App-specific pieces; the controls themselves are the library's (Button, Toggle, Slider, Tabs, Progress).
import { Show, Text, View, type JSX, type WidgetState } from "mantou-ui";
import { c } from "./theme";

/** A switch's label with an optional caption under it. */
export const caption = (title: string, hint?: string) => (
  <View style={{ flexGrow: 1, flexShrink: 1, gap: 2 }}>
    <Text style={{ fontSize: 13, color: c.text }}>{title}</Text>
    <Show when={hint}>
      <Text style={{ fontSize: 11, color: c.dim }}>{hint}</Text>
    </Show>
  </View>
);

/** Toggles put the label first and the switch at the end. */
export const toggleRow = { flexDirection: "rowReverse", justifyContent: "spaceBetween" } as const;

export function Labelled(props: { name: string; value: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "spaceBetween" }}>
        <Text style={{ fontSize: 13, color: c.text }}>{props.name}</Text>
        <Text style={{ fontSize: 13, color: c.dim }} role="status" label={`${props.name}: ${props.value}`}>{props.value}</Text>
      </View>
      {props.children}
    </View>
  );
}

export function Section(props: { title: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: c.faint }}>{props.title.toUpperCase()}</Text>
      {props.children}
    </View>
  );
}
