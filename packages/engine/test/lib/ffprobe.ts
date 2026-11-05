import { parseFfprobe, type FfprobeOutput } from "../../src/formats/ffprobe";

/** ffprobe's JSON with the three top-level keys always present, so tests can index them. */
export type Probe = Required<FfprobeOutput>;

export function parseProbe(text: string): Probe {
  return { streams: [], chapters: [], format: {}, ...parseFfprobe(text) };
}
