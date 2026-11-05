import { openFile } from "mantou-ui";
import type { Store } from "./store";

export async function pickFiles(store: Store) {
  const picked = await openFile({ multiple: true, title: "Add files" });
  if (picked?.length) await store.add(picked);
}

export async function pickFolders(store: Store) {
  const picked = await openFile({ multiple: true, pickFolders: true, title: "Add folders" });
  if (picked?.length) await store.add(picked);
}
