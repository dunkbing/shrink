// The app's Zed-like dark theme for the library widgets (setTheme in main.tsx), and the few colours views use directly.
import type { Theme } from "mantou-ui";

export const shrinkTheme: Theme = {
  background: "#282c33", surface: "#2f343e", surfaceAlt: "#2c3039", control: "#2f343e", controlHover: "#363c46", controlPressed: "#454a56", selected: "#3a4a63",
  border: "#464b57", borderHover: "#5c6270", divider: "#3b414d", track: "#3b414d", text: "#dce0e5", dimText: "#a9afbc", placeholder: "#878a98",
  accent: "#74ade8", accentHover: "#8bbcee", accentPressed: "#5f98d3", accentText: "#1b1f27", accentSoft: "#3a4a63", knob: "#dce0e5", inverse: "#dce0e5", inverseText: "#1b1f27",
};

export const c = {
  bg: shrinkTheme.background,
  panel: shrinkTheme.surface,
  row: shrinkTheme.surface,
  rowAlt: shrinkTheme.surfaceAlt,
  line: shrinkTheme.divider,
  text: shrinkTheme.text,
  dim: shrinkTheme.dimText,
  faint: shrinkTheme.placeholder,
  selected: shrinkTheme.selected,
  accent: shrinkTheme.accent,
  good: "#4ade80",
  warn: "#e5b84b",
  bad: "#f2706b",
};
