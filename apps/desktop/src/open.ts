import { onOpen } from "mantou-ui";
import type { Store } from "./store";

/** Adds the files this launch and later launches are given (onOpen resolves them against the right cwd); URLs are ignored. */
export function listenOpen(store: Store) {
  return onOpen(({ file }) => file && void store.add([file]));
}
