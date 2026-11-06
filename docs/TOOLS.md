# Tools

Shrink runs external programs (oxipng, ffmpeg, qpdf, ...). Users never install them: the engine downloads what a
file needs, once, into a per-user folder. This file describes how that works and what the maintainer has to do.

## Which tool is used

For a tool name, `createTools` (packages/engine/src/tools.ts) tries, in order:

1. `settings.toolPaths` (a command the user set) and `options.toolDir`;
2. a tool on `PATH` (and the known aliases), but only if its version is at least `minVersion` in the manifest (tools
   without a `minVersion` are accepted as they are);
3. the provisioned copy in the tools folder;
4. otherwise the pack is downloaded, then step 3 applies;
5. if no download is possible (offline, no pack for the platform, failed), an older tool on `PATH` is still used.

If nothing works the step is skipped with a note, exactly as before (`oxipng not available (offline)`); a missing
tool is never an error.

## Manifest

`packages/engine/tools/manifest.json` (version, `baseUrl`, `packs`, `tools`):

- `tools.<name>`: `pack`, `licence`, `homepage`, `minVersion`, `versionArgs`, and `platforms.<platform>` = where the
  pack builder gets it (`url` + `sha256` + `member` of an upstream release archive, a package manager name
  `brew`/`apt`/`choco`, or a `build` script). Platforms: `darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64`.
- `packs.<pack>.platforms.<platform>`: `file`, `sha256`, `size` of the published archive. **A pack whose `sha256`
  is `null` is not published and is never downloaded** (this is the state until the first release).
- Inside a pack: `bin/<tool>[.exe]`, `lib/` (bundled libraries, relocatable), `licenses/`, `THIRD_PARTY.md`.

| Pack | Tools |
| --- | --- |
| `core` (prefetched at first launch) | oxipng, jpegtran (also `mozjpegtran`), cwebp, gifsicle, sqlite3, xz, zopfli, advzip, ffmpeg, ffprobe |
| `media` | flac, metaflac, mkclean, MP4Box |
| `docs` | qpdf, mutool |
| `archive` | 7zz, cabextract |
| `web` | minify, resvg |
| `exe` | upx |
| `images` (experimental, not built by default) | magick, tiffcp, jpegoptim |

Not provisioned (still found on `PATH`): pngquant, cjpeg, optivorbis, mp3packer, mp4file, leanify, cpdf, gnu-strip.

`ffmpeg` and `ffprobe` are our own minimal static build (`scripts/tools/ffmpeg-min.sh`, version in the script):
stream copy between containers, audio decoders for the hash check, the `hash`/`streamhash` muxers, no video codecs,
no network, no external libraries. Measured on macOS arm64: 3.8 MB + 3.6 MB uncompressed, 3.9 MB together as
`.tar.gz`; the whole `core` pack for the six small tools measured so far is 2.6 MB. Linux and Windows sizes are
expected to be similar but are not measured yet (the workflow prints them).

## Where packs live

`baseUrl` defaults to `https://github.com/dunkbing/shrink/releases/download/tools-{version}` (`{version}` = the
manifest version). Override with `SHRINK_TOOLS_URL` (a `file://` folder works, the tests use it) or
`ProvisionOptions.baseUrl`. `SHRINK_TOOLS_DIR` moves the install folder (default `~/.shrink/tools`);
`SHRINK_OFFLINE=1` (CLI: `--offline`) disables downloads.

**Prerequisite: anonymous downloads from GitHub Releases only work when the repository is public.** While
`dunkbing/shrink` is private, host the packs elsewhere (any static HTTPS host or bucket serving the same file
names, with `Range` support if possible) and point `baseUrl` / `SHRINK_TOOLS_URL` at it. The sha256 in the
manifest is what makes any host safe: a file that does not match is deleted and never installed.

## Building and publishing packs

1. `bun run tools:pack -- --platform <p> --packs core` builds `dist/tools/<pack>-<platform>.tar.gz` (+ a `.json` with
   its sha256) for the machine it runs on. Release sources are checked against the sha256 in the manifest (`--pin`
   fills in a missing one on first use; GitHub shows the digest of each asset). `system` sources are installed
   with the package manager and their dependencies bundled: macOS dylibs are copied to `lib/`, rewritten to
   `@executable_path/../lib` and ad-hoc re-signed (Apple silicon needs it); Linux libraries other than glibc are
   copied and given an `$ORIGIN/../lib` rpath (build on the oldest Ubuntu you support); Windows DLLs are copied
   next to the exe. Every program is run once from the unpacked pack before the archive is accepted.
   Options: `--tools a,b` (subset), `--out`, `--work`.
2. The manually triggered workflow `.github/workflows/tools.yml` (workflow_dispatch only) does this on every OS
   runner, merges the checksums (`--merge`) and uploads an artifact `manifest`. With `publish` checked it also
   uploads the packs to the release `tools-<manifest version>`.
3. Commit the `manifest.json` from that artifact (it carries the pack checksums) and ship an app/CLI version with it.
   Changing a pack means changing the manifest `version` (a new release tag) or at least the checksums; installed
   copies of older packs are removed after the new one is in place.

Published: release `tools-1` (https://github.com/dunkbing/shrink/releases/tag/tools-1), built by the workflow on all
five platforms. `core` is 6.8 to 9.4 MB per platform. Tools the builder could not make relocatable are left out per
platform (`tools.<name>.dropped` in the manifest has the reason, the engine skips them without an error): `MP4Box` on
Linux (gpac pulls ~80 MB of libraries), macOS arm64 (gpac module folder) and Windows (no usable choco package), `mkclean`
on Linux (no apt package). Windows takes xz, jpegtran and 7-Zip from their official release archives (Chocolatey
installs those as installers). The `images` pack is not built.

## Provisioner (packages/engine/src/provision.ts)

`new Engine({ provision: true })` (the CLI and the app do) or `new Engine({ provisioner })`. A download goes to
`<tools>/tmp/<file>.part` (continued with `Range` after an interruption, `file://` too), is hashed, unpacked with
the engine's own tar reader into `tmp/x-*`, marked `.ready`, and renamed to `packs/<pack>-<sha12>` (atomic).
`chmod +x`, and the macOS quarantine flag is cleared. A lock directory per pack (`locks/<pack>.lock`, refreshed while
downloading, taken over when stale or its owner is dead) keeps several workers and app instances to one download.
Failures are retried with backoff (default 4 tries); a bad checksum is not retried (after a resumed partial file it
is, from scratch). A failed or offline pack is left alone for 60 s (`retry()` clears it). Progress is reported by
`onProgress` / `listen` as `PackState` (`waiting, downloading, verifying, extracting, ready, failed, offline`).

`Engine.optimizeMany` starts the download of the tools a file needs at once and processes the files whose tools
are ready first. The CLI prints `preparing tools (oxipng, cwebp, gifsicle and 3 more 2.6 MB)…` on stderr and
has `shrink tools` (status). The desktop app prefetches `core` at launch, shows "Preparing tools…" with a
progress bar in the footer, per-tool states on the Tools tab, and Retry only after a failure.

## Licences

The full table is generated from the manifest: `bun run tools:third-party` writes `docs/THIRD_PARTY.md`, and each
pack carries the part for its tools plus the licence files found in the upstream archives. Shrink starts these
programs as separate processes and does not link them. GPL-family tools (gifsicle, advzip, flac tools, cabextract,
jpegoptim) and AGPL mutool (MuPDF) stay separate programs; the written source offer in
THIRD_PARTY.md and the homepages in the table are how the source is provided. UPX has its exception for packing,
7-Zip's unRAR code must not be used to recreate RAR compression (we only extract). Check the licence of any
tool you add before it goes in a pack.
