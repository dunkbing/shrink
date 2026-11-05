// Matroska / WebM with video: ffmpeg remux, then mkclean (not for WebM, not for Matroska v4 elements).
// Chapters and attachments (fonts) are kept. Audio-only .mka belongs to the audio formats.
import { toolStep } from "../step";
import type { Context, Format, Settings } from "../types";
import { packetsOracle, remuxStep } from "./video-common";
import { checkMatroskaWhole, detectMatroska, type EbmlInfo } from "./video-parse";

const info = (ctx: Context) => ctx.facts.ebml as EbmlInfo;

export const matroska: Format = {
  id: "matroska",
  extensions: ["mkv", "mk3d", "webm", "mks"],
  detect: detectMatroska,
  flags: (s: Settings) => ({ keepMetadata: s.video.keepMetadata }),
  steps: [
    remuxStep({ id: "matroska.ffmpeg", muxer: (ctx) => (info(ctx).docType === "webm" ? "webm" : "matroska") }),
    toolStep({
      id: "matroska.mkclean",
      tool: "mkclean",
      when: (ctx) => (info(ctx).docType === "webm" ? "WebM" : info(ctx).docTypeVersion >= 4 ? "Matroska v4 elements" : true),
      args: (input, output, ctx) => ["--quiet", ...(ctx.level >= 5 ? ["--optimize"] : []), input, output],
    }),
  ],
  oracle: packetsOracle({
    chaptersAlways: true,
    whole(path, size, ctx, original) {
      const e = checkMatroskaWhole(path, size);
      if (original) ctx.facts.ebml = e;
    },
  }),
};

export const formats: Format[] = [matroska];
