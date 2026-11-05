import { Engine, allFormats } from "@shrink/engine";
import { onMenu, paths, run, setMenu, win } from "mantou-ui";
import { App } from "./App";
import { pickFiles, pickFolders } from "./pick";
import { createStore } from "./store";
import { loadWindow, rememberWindow } from "./window";

paths.setApp("Shrink");
const store = createStore({
  dir: paths.data,
  makeRunner: (settings) => new Engine({ formats: allFormats, settings }),
});

run(() => <App store={store} />, { title: "Shrink", ...loadWindow(), minWidth: 760, minHeight: 440 });
void setMenu([
  { label: "Shrink", items: [{ role: "about" }, { separator: true }, { role: "hide" }, { role: "hideOthers" }, { separator: true }, { role: "quit" }] },
  { label: "File", items: [{ id: "add", label: "Add Files…", accelerator: "cmd+o" }, { id: "folder", label: "Add Folder…", accelerator: "cmd+shift+o" }, { separator: true }, { id: "start", label: "Start", accelerator: "cmd+return" }, { id: "stop", label: "Stop", accelerator: "cmd+." }] },
  { label: "Edit", items: [{ role: "copy" }, { role: "selectAll" }] },
  { label: "Window", items: [{ role: "minimize" }, { role: "zoom" }] },
]);
win.onState(rememberWindow);
onMenu((id) => {
  if (id === "add") void pickFiles(store);
  else if (id === "folder") void pickFolders(store);
  else if (id === "start") void store.start();
  else if (id === "stop") store.stop();
});
