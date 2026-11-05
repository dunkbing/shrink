import type { Format, Step } from "../types";
import { SkipFile } from "../types";
import { describe, looksLikeCfb, readCfb, signed, writeCfb, type Cfb } from "./cfb-parse";

const MAX = 2 ** 30;

const compact: Step = {
  id: "cfb.compact",
  async run(input, output) {
    const c = readCfb(new Uint8Array(await Bun.file(input).arrayBuffer()));
    await Bun.write(output, writeCfb(c));
  },
};

interface Facts {
  c: Cfb;
  d: Map<string, string>;
  major: number;
}

export const cfb: Format = {
  id: "cfb",
  extensions: "doc dot xls xla xlc xlm xlw xlt ppt pps pot pub vsd vss vst vsx vtx mpp mpt mpd wps msg msi msp mst ole ole2 opt max sldprt sldasm slddrw rvt rfa rte rft rfg".split(" "),
  detect: (h) => looksLikeCfb(h),
  steps: [compact],
  oracle: {
    async prepare(path) {
      if (Bun.file(path).size > MAX) throw new SkipFile("larger than 1 GiB");
      const b = new Uint8Array(await Bun.file(path).arrayBuffer());
      const c = readCfb(b);
      if (signed(c)) throw new SkipFile("digitally signed");
      return { c, d: describe(c), major: c.major } satisfies Facts;
    },
    async same(original, candidate) {
      const a = original as Facts;
      let c: Cfb;
      try {
        c = readCfb(new Uint8Array(await Bun.file(candidate).arrayBuffer()));
      } catch (e: any) {
        return `the result is not a valid compound file: ${e?.message ?? e}`;
      }
      if (c.major !== a.major) return "version changed";
      const d = describe(c);
      if (d.size !== a.d.size) return `entry count ${a.d.size} became ${d.size}`;
      for (const [p, v] of a.d) if (d.get(p) !== v) return `${p || "/"}: differs`;
      return true;
    },
  },
};

export const formats: Format[] = [cfb];
