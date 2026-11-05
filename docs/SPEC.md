# Shrink: specification

Shrink makes files smaller **without changing what they contain**. It is an engine (a TypeScript library on Bun), a CLI and a desktop app (built on [Mantou](https://github.com/dunkbing/mantou)). A web API and a web app on the same engine come later; the engine, CLI and desktop app are open source, the web app is not.

For each file it runs a chain of established optimizers and **keeps a result only if it is smaller and proven to hold the same content**. Per-format pipelines and test cases are in [FORMATS.md](FORMATS.md).

## Principles

1. **Lossless by default.** Decoded content never changes (images decode to the same pixels, audio to the same samples, video to the same packets, archives to the same files, documents to the same pages). A step that can change it is *lossy* and runs only when the user turns it on for that format.
2. **Verify, don't trust.** Every candidate result passes the format's *oracle* (see below) against the original before it can replace it. A tool that crashes, times out, produces garbage or a different picture loses its output, nothing else.
3. **Never worse.** A result is kept only if strictly smaller. If every step fails or gains nothing, the file is untouched.
4. **The original is touched once.** All work is on private copies in a temp folder. The original is overwritten only with a verified, smaller result, and only if it did not change meanwhile (size, mtime and a hash of the first and last blocks are rechecked right before the write).
5. **Tools are plugins.** A step names a tool, how to run it and what it needs. Missing tools are skipped (and reported), never fatal. Any step can later be replaced by a native or WASM implementation behind the same interface.
6. **Metadata is stripped by default, except where stripping changes how the content looks or behaves** (EXIF orientation, non-sRGB colour profiles, signatures, gain maps...). Those files are handled as if "keep metadata" were on.

## Architecture

```
packages/engine   the library: detect, plan, run steps, verify, write
packages/cli      `shrink [flags] files...`, progress, exit codes
apps/desktop      Mantou app: drop files, watch progress, totals, settings
(later) web API   same engine behind HTTP; separate private repo for the web app
```

### Engine pipeline (per file)

1. **Detect** the format by content (magic bytes and light parsing), not just the extension. A file whose content contradicts its extension is skipped with a reason. A renamed PNG still gets PNG tools.
2. **Plan**: the format's ordered steps, filtered by settings (level, lossy, keep-metadata, disabled tools) and by guards (e.g. "not CMYK", "not fragmented MP4").
3. **Run** each step on the best result so far, in a private job folder. Each step gets a timeout, a memory/CPU niceness and cancellation.
4. **Verify** each candidate with the oracle. Reject on any difference.
5. **Keep** the smaller of (best so far, candidate).
6. **Commit**: write over the original (in place, preserving permissions, timestamps if configured, hard links and ACLs), re-checking that the original is unchanged.
7. **Report**: before/after size, steps tried with sizes and verdicts, notes (skip reasons, tool missing, "oracle failed").

### Plugin interface (sketch)

```ts
interface Tool { name: string; locate(): Promise<string | null>; version?(): Promise<string>; }
interface Step {
  id: string;                    // "png.oxipng"
  tool: string;
  when?: (ctx: Context) => boolean | string;   // false or a skip reason
  run(input: string, output: string, ctx: Context): Promise<void>;
}
interface Format { id: string; detect(head: Uint8Array, name: string): boolean; steps: Step[]; oracle: Oracle; }
type Oracle = (original: string, candidate: string, ctx: Context) => Promise<true | string>;  // true, or why not
```

### Oracles

| Oracle | Used for | Proof of "same content" |
|---|---|---|
| `pixels` | JPEG, PNG, WebP, (HEIC/AVIF to verify only) | Both decode with `Bun.Image` to the same width, height and canonical PNG bytes (same decoder, so JPEG decodes are bit-exact). Alpha is compared too, except fully transparent pixels' colour values. Animated images: every frame and delay (ImageMagick/ffmpeg `framehash`). |
| `pixels-tool` | GIF, BMP, TIFF, ICO frames, other raster | ImageMagick `compare -metric AE` is 0, or `identify -format %#` pixel signature is equal per frame. |
| `audio` | FLAC, WAV, MP3, Ogg Vorbis/Opus, M4A | ffmpeg decodes both to the same sample hash (`-map 0:a -f hash -hash sha256`) and the same duration/sample count. |
| `packets` | MP4/MOV, MKV/WebM, Ogg video | ffmpeg `-map 0 -c copy -f streamhash` is equal for every stream (identical packets), plus stream count, codec, language/title tags kept. |
| `archive` | ZIP-based, GZip, TAR, 7z | Same member names, same uncompressed bytes (CRC/SHA-256), same order unless order is irrelevant; stored attributes per setting. Nested archives are compared recursively when `archive.recurse`. |
| `document` | PDF | `qpdf --check` passes; same page count; each page renders to the same pixels (`mutool draw -r 72`); same extracted text. |
| `text-structure` | HTML, CSS, JS, JSON, XML, SVG minification | Parse both to a structure and compare: JSON `JSON.parse` deep-equal (numbers keep spelling), JS token streams ignoring whitespace/comments, CSS rule lists, HTML/XML DOM ignoring insignificant whitespace, SVG DOM and a rendered-pixel compare. |
| `database` | SQLite | `PRAGMA integrity_check` is ok and `.dump` output is equal (same schema, same rows). |
| `bytes-subset` | executables | Section contents the loader maps are equal; only metadata/debug/slack removed; the file still parses as PE/ELF/Mach-O. |

If a format's oracle tool is missing the step is skipped (a result that cannot be verified is never kept), with the note "cannot verify".

### Tool discovery and distribution

Order: configured path (`toolPaths`), the app's tool folder (`~/.shrink/tools/<platform>`), `PATH` under the usual names. The CLI/app can download pinned, hash-checked builds of freely redistributable tools into the tool folder. Tools whose licence forbids redistribution (e.g. pingo) are never downloaded or bundled: used only if the user installs them. Windows-only tools run natively on Windows and are skipped elsewhere (Wine via `toolPaths` is possible, not required). Tools run as **separate processes**, so their licences (GPL, AGPL, proprietary freeware) do not affect Shrink's own.

### Settings (defaults)

```json
{
  "level": 5, "workers": 0, "preserveTimestamps": true, "lowPriority": true, "skipOptimized": true,
  "include": null, "exclude": null, "disabledTools": null, "toolPaths": null,
  "jpeg": { "lossy": false, "keepMetadata": false, "arithmetic": false },
  "png":  { "lossy": false, "keepMetadata": false },
  "gif":  { "lossy": false, "keepMetadata": false },
  "webp": { "lossy": false, "keepMetadata": false },
  "tiff": { "keepMetadata": false }, "bmp": { "keepMetadata": false },
  "pdf":  { "profile": "none", "dpi": 150, "skipLayered": false },
  "audio": { "keepMetadata": false, "trimSilence": false },
  "video": { "keepMetadata": false },
  "archive": { "keepMetadata": false, "recurse": false },
  "web": { "html": false, "css": false, "js": false, "svg": true, "jsExtensions": null },
  "exe": { "enabled": false, "upx": false }
}
```

`level` 1 (fast) to 9 (extreme) scales iteration counts and which slow steps run. `skipOptimized` keeps a cache of (content hash, settings hash) of files already processed.

## Invariants every format must satisfy (COMMON cases)

Each is a test that runs against every supported format's fixtures.

| ID | Case | Expectation |
|---|---|---|
| COMMON-01 | Optimizable fixture | Result is smaller, and the oracle passes. |
| COMMON-02 | Already-optimal fixture (run twice) | Second run leaves the file byte-identical and reports "unchanged"; the cache skips it. |
| COMMON-03 | Idempotence | Optimizing the output again never makes it larger and gains less than 1%. |
| COMMON-04 | Never larger | For every fixture, size(after) <= size(before). |
| COMMON-05 | Corrupt / truncated file | File untouched, a clear "damaged" note, exit code reflects failure, no crash. |
| COMMON-06 | Empty file and tiny file (1 to 16 bytes) | Skipped with a reason. |
| COMMON-07 | Wrong extension | Detected by content; extension/content mismatch is skipped with a reason. |
| COMMON-08 | A tool produces a different result (fake tool that changes content) | Oracle rejects it; original untouched. |
| COMMON-09 | A tool crashes, hangs (timeout), or writes nothing | Step is skipped; later steps still run; original untouched. |
| COMMON-10 | Tool missing | Step skipped with a note; engine still works with the tools that exist. |
| COMMON-11 | Read-only file | Skipped with "read-only". |
| COMMON-12 | File changes while being optimized | Result discarded, original untouched. |
| COMMON-13 | Timestamps | mtime preserved when `preserveTimestamps`; permissions, hard links, symlink target (the target is optimized, the link stays) preserved. |
| COMMON-14 | Unicode and space-heavy paths, very long paths, leading `-` in names | Work (arguments are never parsed as options). |
| COMMON-15 | Cancellation | Cancelling kills child processes, removes job folders, leaves the original untouched. |
| COMMON-16 | Concurrency | N files at once give the same results as one at a time; no shared temp-file collisions. |
| COMMON-17 | Disk full / unwritable folder | Original untouched, error reported. |
| COMMON-18 | Metadata default | Stripped unless keepMetadata, except the protected cases listed per format. |
| COMMON-19 | Lossy off | With default settings no step flagged `lossy` ever runs (asserted by the oracle on every format). |
| COMMON-20 | Dry run | Reports what would be done and the estimated sizes without writing. |
| COMMON-21 | Large file (hundreds of MB) | Streams; memory stays bounded; progress and cancellation still work. |
| COMMON-22 | Level monotonic | Higher level never produces a larger result than a lower level on the same file (modulo time). |

## Fixture strategy

- **Generated at test time** where possible (JPEG/PNG/WebP with `Bun.Image`; ZIP, gzip, TAR with Bun and the system; SQLite with `sqlite3`; WAV by writing samples), so the repo stays small and the cases are explicit.
- **Committed corpora** of small files (a few KB each, licence noted in `fixtures/README.md`): PNG test suite (PngSuite), a JPEG set with EXIF orientation, ICC profiles, progressive, CMYK, arithmetic and gain maps; animated GIF/APNG/WebP; BMP variants; multi-page and layered TIFF; sample PDFs (signed, PDF/A, layered, encrypted, forms, scanned); Office, ODF and EPUB documents; MP3/FLAC/Ogg/M4A with tags; MP4 (fragmented and not), MKV, WebM; PE/ELF/Mach-O samples.
- **Large corpora** (Kodak, Wikimedia, real-world mixed bags) are downloaded by `bun run fixtures:fetch` into `fixtures/large` (git-ignored) for benchmark and regression runs, with expected-savings floors recorded per file.
- **Fuzz/corrupt set**: each fixture truncated at several points and with random byte flips, to prove COMMON-05/09.
- Every fixture has a manifest line: `id, format, why it exists, expected: optimized|unchanged|skipped:<reason>|damaged`.

## Implementation order

1. Engine core: detect, job folders, tool locating and running (timeouts, cancel), oracle plumbing, in-place commit with recheck, settings, cache, report; COMMON cases against a fake format.
2. PNG, JPEG, WebP (oracle `pixels` via `Bun.Image`).
3. GZip/ZIP family, TAR, 7z (oracle `archive`), SQLite.
4. GIF, BMP, TIFF, ICO, SVG (oracle `pixels-tool` / `text-structure`).
5. PDF.
6. Audio, then video.
7. Web text (HTML/CSS/JS/JSON/XML), executables, Office/ODF/EPUB inner recursion.
8. The long tail of rare formats ([FORMATS.md](FORMATS.md), tier 3).
9. CLI (starts in step 1, grows with each format), desktop app (starts after step 2 so there is something to show), web API.
