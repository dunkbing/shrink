// Tier 3 video containers: AVI, FLV, MPEG program streams (.mpg .mpeg .vob). ffmpeg remux only; a result is
// kept only when the `packets` oracle proves every packet equal.
import type { Format, Settings } from "../types";
import { packetsOracle, remuxStep } from "./video-common";
import { checkAviWhole, checkFlvWhole, detectAvi, detectFlv, detectMpegPs } from "./video-parse";

const flags = (s: Settings) => ({ keepMetadata: s.video.keepMetadata });

export const avi: Format = {
  id: "avi",
  extensions: ["avi"],
  detect: detectAvi,
  flags,
  steps: [remuxStep({ id: "avi.ffmpeg", muxer: () => "avi" })],
  oracle: packetsOracle({ whole: (path) => checkAviWhole(path) }),
};

export const flv: Format = {
  id: "flv",
  extensions: ["flv"],
  detect: detectFlv,
  flags,
  steps: [remuxStep({ id: "flv.ffmpeg", muxer: () => "flv" })],
  oracle: packetsOracle({ whole: (path) => checkFlvWhole(path) }),
};

export const mpeg: Format = {
  id: "mpeg",
  extensions: ["mpg", "mpeg", "vob"],
  detect: detectMpegPs,
  flags,
  steps: [remuxStep({ id: "mpeg.ffmpeg", muxer: (ctx) => (/\.vob$/i.test(ctx.original) ? "vob" : "mpeg") })],
  oracle: packetsOracle(),
};

export const formats: Format[] = [avi, flv, mpeg];
