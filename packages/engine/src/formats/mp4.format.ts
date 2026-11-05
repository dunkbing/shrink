// MP4 / MOV / M4V / 3GP / 3G2 with video: ffmpeg remux, then box-level cleanup with mp4file or MP4Box.
// Audio-only files (.m4a, .m4b) belong to the audio formats. Fragmented files are remuxed fragmented and
// never go through mp4file / MP4Box.
import { inPlaceStep, toolStep } from "../step";
import type { Context, Format, Settings } from "../types";
import { packetsOracle, remuxStep } from "./video-common";
import { detectMp4, parseMp4, type Mp4Info } from "./video-parse";

const info = (ctx: Context) => ctx.facts.mp4 as Mp4Info;
const notFragmented = (ctx: Context) => (info(ctx).fragmented ? "fragmented MP4" : true);

function muxer(ctx: Context): string {
  const b = info(ctx).brand;
  if (b === "qt  ") return "mov";
  if (b.startsWith("3gp")) return "3gp";
  if (b.startsWith("3g2")) return "3g2";
  return "mp4";
}

export const mp4: Format = {
  id: "mp4",
  extensions: ["mp4", "m4v", "mov", "qt", "3gp", "3g2", "3gg"],
  detect: detectMp4,
  flags: (s: Settings) => ({ keepMetadata: s.video.keepMetadata }),
  steps: [
    remuxStep({
      id: "mp4.ffmpeg",
      muxer,
      chaptersAreMetadata: true,
      dropCoverArt: true,
      extra: (ctx) => ["-movflags", info(ctx).fragmented ? "+frag_keyframe+empty_moov+default_base_moof" : "+faststart"],
    }),
    inPlaceStep({ id: "mp4.mp4file", tool: "mp4file", when: notFragmented, args: (f) => ["--optimize", "-q", f] }),
    toolStep({ id: "mp4.mp4box", tool: "MP4Box", when: notFragmented, minLevel: 4, args: (input, output) => ["-quiet", "-inter", "0", "-out", output, input] }),
  ],
  oracle: packetsOracle({
    whole(path, _size, ctx, original) {
      const m = parseMp4(path);
      if (original) ctx.facts.mp4 = m;
    },
  }),
};

export const formats: Format[] = [mp4];
