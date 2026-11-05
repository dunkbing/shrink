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
import { jpeg as jpegFormat } from "./formats/jpeg";
export { jpeg } from "./formats/jpeg";
export { parseJpeg } from "./formats/jpeg-parse";
/** Every format the engine can optimise. */
export const allFormats = [pngFormat, jpegFormat];
