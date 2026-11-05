export { Engine } from "./optimize";
export { defaults, resolve } from "./settings";
export { Cache, hashFile } from "./cache";
export { createTools, runCommand, MissingTool } from "./tools";
export { detect } from "./detect";
export type * from "./types";
export { toolStep } from "./step";
export { png } from "./formats/png";
export { decodePng, samePixels } from "./formats/png-decode";

import { png as pngFormat } from "./formats/png";
/** Every format the engine can optimise. */
export const allFormats = [pngFormat];
