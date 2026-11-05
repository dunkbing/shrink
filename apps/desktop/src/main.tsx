import { fileURLToPath } from "node:url";
import { Engine, allFormats } from "@shrink/engine";
import { onMenu, onOpen, paths, run, setMenu, singleInstance } from "mantou-ui";
import { App } from "./App";
import { openArgs } from "./open";
import { pickFiles, pickFolders } from "./pick";
import { attachShell, realShell } from "./shell";
import { createStore } from "./store";

paths.setApp("Shrink");
// a second launch hands its files to the first copy and quits
let onLaunch = (_args: string[], _cwd: string) => {};
if (!(await singleInstance((args, cwd) => onLaunch(args, cwd)))) process.exit(0);

const store = createStore({
  dir: paths.data,
  makeRunner: (settings) => new Engine({ formats: allFormats, settings }),
});

const core = run(() => <App store={store} />, { title: "Shrink", width: 1000, height: 640, minWidth: 760, minHeight: 440, restoreState: true, quitOnClose: false });
const shell = attachShell(store, realShell, { icon: fileURLToPath(new URL("../assets/tray.svg", import.meta.url)) });
core.onEvent = (e) => {
  if (e.type === "closeRequested" && shell.closeRequested() === "quit") core.quit(0);
};
// files from the launch arguments and from later launches (onOpen resolves them against the cwd: dunkbing/mantou#77)
onLaunch = (args, cwd) => openArgs(store, args, cwd);
openArgs(store, process.argv.slice(2), process.cwd());
onOpen(({ file }) => file && void store.add([file]));
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
