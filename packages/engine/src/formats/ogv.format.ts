// Ogg with a Theora video stream (.ogv, and .ogg/.ogm/.ogx that carry Theora): ffmpeg remux.
// Audio-only Ogg belongs to the audio formats.
import type { Format, Settings } from "../types";
import { packetsOracle, remuxStep } from "./video-common";
import { checkOggWhole, oggHasTheora } from "./video-parse";

export const ogv: Format = {
  id: "ogv",
  extensions: ["ogv", "ogg", "ogm", "ogx"],
  detect: (h) => oggHasTheora(h),
  flags: (s: Settings) => ({ keepMetadata: s.video.keepMetadata }),
  steps: [remuxStep({ id: "ogv.ffmpeg", muxer: () => "ogg", stripStreamTags: true })],
  oracle: packetsOracle({ whole: (path) => checkOggWhole(path) }),
};

export const formats: Format[] = [ogv];
