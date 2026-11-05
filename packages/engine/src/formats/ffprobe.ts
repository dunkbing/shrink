/** The parts of `ffprobe -of json` output the formats read. Every field may be missing. */
export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  sample_rate?: string;
  channels?: number;
  start_time?: string;
  duration?: string;
  extradata_size?: number;
  tags?: Record<string, unknown>;
  disposition?: Record<string, number>;
  side_data_list?: unknown;
  /** Any other property (the stream-property list is read by name). */
  [key: string]: unknown;
}

export interface FfprobeChapter {
  start_time?: string;
  end_time?: string;
  tags?: Record<string, unknown>;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  chapters?: FfprobeChapter[];
  format?: { format_name?: string; duration?: string; tags?: Record<string, unknown> };
}

/** Parses ffprobe's JSON (a trust boundary: the shape is ffprobe's, every field optional). */
export function parseFfprobe(text: string): FfprobeOutput {
  return JSON.parse(text);
}
