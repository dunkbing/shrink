# Adding a format

A format family is one file, `packages/engine/src/formats/<family>.format.ts`, that exports `formats: Format[]` (see `types.ts`). `bun run gen` rebuilds the registry (`formats/index.ts`, generated, never edited by hand) from every `*.format.ts` file. Helper modules for a family (parsers, decoders) sit beside it with other names (`png-decode.ts`).

A format has:

- `detect(head, name)`: by content (magic bytes), not extension.
- `extensions`: the extensions that normally hold it (a content/extension mismatch skips the file).
- `flags(settings)`: its `lossy` and `keepMetadata` settings.
- `skip?(path, head, ctx)`: a reason to leave the file alone before any step runs (signed, encrypted, unsupported variant).
- `steps`: ordered; each reads `input`, writes `output`. `toolStep` runs a tool that writes a separate output; `inPlaceStep` copies first for tools that rewrite their file. A step names its `tool`; a missing tool skips the step with a note. Mark steps `lossy` or `strip`, and set `minLevel` for slow ones.
- `oracle`: **proves a candidate holds the same content as the original** (`prepare` reads the original once and throws if it is damaged, or `SkipFile` for a variant that is not supported; `same` returns `true` or the reason it differs). Prefer an independent check over trusting the tool that made the result: decode both and compare (see `png-decode.ts`, `gif-decode.ts`, `bun-pixels.ts`). `ctx.facts` carries what `prepare` learned (such as "keep EXIF") to the steps.

Rules:

1. Lossless by default. A step that can change decoded content is `lossy: true` and runs only with the format's `lossy` setting (do these last; they need a similarity check instead of equality).
2. Metadata is stripped by default, except what changes how the content looks or behaves (colour profiles, orientation, signatures, DRM).
3. Never leave a file worse: the engine keeps a result only if smaller and the oracle passes.
4. Tools run as separate processes; locate them by name (`ctx.run("tool", args)`); add alternative install paths to `KNOWN` in `tools.ts` only when a package manager keeps a tool off PATH.
5. Arguments are never parsed as options: pass paths after the tool's own flags, and the engine's internal paths never start with `-`.
6. Be strict about damaged input: truncated or corrupt files are skipped (`prepare` throws), never crashed on or "optimised".

Tests (`packages/engine/test/<family>.test.ts`): one test per case ID in `docs/FORMATS.md` for the family (`// covers JPEG-03` or the ID in the test name), plus the real files for it. Generate fixtures at test time where practical (`test/lib/` has writers for PNG, GIF, JPEG, WebP); real-world files go in `fixtures/manifest.d/<group>.json` (file, url, format, licence) and are fetched with `bun run fixtures:fetch` (`bun scripts/fetch-fixtures.ts <group> --update` records checksums in `fixtures/locks/`). `corpus.test.ts` runs every fetched real file of every registered format through the engine and requires that nothing fails or grows. Tests that need a tool use `test.skipIf(!tool)` so they skip rather than fail where the tool is absent.

Before finishing: `bun run typecheck && bun test`.
