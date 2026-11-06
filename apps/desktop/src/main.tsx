import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Engine, allFormats } from "@shrink/engine";
import { onMenu, paths, run, setMenu, setTheme, singleInstance } from "mantou-ui";
import trayAsset from "../assets/tray.svg" with { type: "file" };
import { App } from "./App";
import { listenOpen } from "./open";
import { pickFiles, pickFolders } from "./pick";
import { attachShell, realShell } from "./shell";
import { createStore } from "./store";
import { shrinkTheme } from "./theme";
import { createToolsState } from "./toolstatus";

paths.setApp("Shrink");
setTheme(shrinkTheme);
// a second launch hands its files to the first copy and quits
if (!(await singleInstance())) process.exit(0);

// tools (oxipng, ffmpeg...) come by themselves: the core pack is fetched now, the others when a file needs them
const tools = createToolsState();
void tools.provisioner.prefetch();
const store = createStore({
  dir: paths.data,
  makeRunner: (settings) => new Engine({ formats: allFormats, settings, provisioner: tools.provisioner }),
});

const core = run(() => <App store={store} tools={tools} />, { title: "Shrink", width: 1000, height: 640, minWidth: 760, minHeight: 440, restoreState: true, quitOnClose: false });
// the native side reads the icon from disk, but in a compiled app the asset lives inside the executable: copy it out
mkdirSync(paths.data, { recursive: true });
const trayIcon = join(paths.data, "tray.svg");
await Bun.write(trayIcon, Bun.file(trayAsset));
const shell = attachShell(store, realShell, { icon: trayIcon });
core.onEvent = (e) => {
  if (e.type === "closeRequested" && shell.closeRequested() === "quit") core.quit(0);
};
// files from the launch arguments, "Open with" and later launches
listenOpen(store);
void setMenu([
  { label: "Shrink", items: [{ role: "about" }, { separator: true }, { role: "hide" }, { role: "hideOthers" }, { separator: true }, { role: "quit" }] },
  { label: "File", items: [{ id: "add", label: "Add Files…" }, { id: "folder", label: "Add Folders…" }, { separator: true }, { id: "start", label: "Start", accelerator: "cmd+return" }, { id: "stop", label: "Stop", accelerator: "cmd+." }] },
  { label: "Edit", items: [{ role: "copy" }] },
  { label: "Window", items: [{ role: "minimize" }, { role: "zoom" }] },
]);
onMenu((id) => {
  if (shell.menu(id)) return;
  if (id === "add") void pickFiles(store);
  else if (id === "folder") void pickFolders(store);
  else if (id === "start") void store.start();
  else if (id === "stop") store.stop();
});
