# Formats: pipelines, oracles and test cases

Every supported format is here, grouped into families. **Tier 1** is common and built first, **tier 2** follows, **tier 3** is the long tail (mostly formats ImageMagick or Leanify happen to handle). Steps run in order; each works on the best result so far and a result is kept only if smaller **and** the family's oracle passes ([SPEC.md](SPEC.md)). *(strip)* means the step runs only when metadata is not kept; *(lossy)* only when the format's `lossy` setting is on; *(level n)* only at that level or above. "Native" means done in Bun with no external tool.

Case IDs are `<FAMILY>-<nn>` and are what tests reference (`// covers PNG-04`). Every family also runs the COMMON cases from the spec.

Tools named here (with how to get them): oxipng, ECT, Leanify, zopflipng, pngquant, jpegtran, mozjpeg (cjpeg/jpegtran), jpegoptim, jpegli, gifsicle, libwebp (cwebp, webpmux), ImageMagick, qpdf, mutool (MuPDF), Ghostscript, cpdf, ffmpeg, flac, mkclean, mp4v2/`MP4Box`, OptiVorbis, mp3packer, AdvanceCOMP (advzip, advdef, advpng), libdeflate, zRecompress, 7zz, sqlite3, minify (tdewolff), UPX, strip. Windows-only and optional: pngout, TruePNG, PngOptimizer, DeflOpt, defluff, m7zRepacker, flacout, rehuff, PETrim, mp3packer (Windows build), guetzli. Not bundled by licence: pingo.

---

## 1. JPEG (tier 1)

Extensions: .jpg .jpeg .jpe .jfif .jfi .jif (also .jps, .mpo and .jpt, by header).
Detect: `FF D8 FF`.
Oracle: `pixels`.

Steps: jpegoptim *(progressive, strip)*, jpegtran (optimize, progressive, `-copy all`), mozjpeg's jpegtran, then `cjpeg` re-encode *(lossy)*: decodes and re-encodes at the lowest quality (30 to 95) whose result keeps SSIM >= `lossy.ssim` (0.98) and is at least `lossy.minSaving` (5%) smaller, carrying ICC and (when needed) EXIF over; jpegli, guetzli, jpeg-recompress, Leanify and ECT are not implemented. Arithmetic coding only with `jpeg.arithmetic`.
Skip/guards: CMYK/YCCK files are skipped (header check, no tool sees them); **EXIF Orientation != 1, non-sRGB ICC profile, or MPF/gain-map JPEGs (Ultra HDR, ISO 21496-1, Apple) are handled as keepMetadata** (gain maps: skipped, every tool drops them); damaged streams skipped.

| ID | Case |
|---|---|
| JPEG-01 | Baseline photo (generated 640x480) becomes progressive/optimized Huffman and is smaller; decoded pixels identical. |
| JPEG-02 | Already progressive and optimized: unchanged. |
| JPEG-03 | EXIF/XMP/comment/thumbnail present: stripped by default, kept with `keepMetadata`; pixels identical either way. |
| JPEG-04 | EXIF Orientation 6: metadata kept (rotation preserved), pixels identical. |
| JPEG-05 | Non-sRGB ICC (Display P3, Adobe RGB): profile kept, colours identical. |
| JPEG-06 | CMYK / Adobe YCCK JPEG: handled without corruption, or skipped. |
| JPEG-07 | Grayscale JPEG; 12-bit and lossless-JPEG files are skipped with "unsupported". |
| JPEG-08 | Restart markers, 4:2:0 / 4:2:2 / 4:4:4 / 4:1:1 subsampling all keep pixels identical. |
| JPEG-09 | Truncated JPEG (cut inside the scan) is untouched. |
| JPEG-10 | JPEG with trailing garbage / appended data: either preserved or the result rejected; never silently dropped if the app needs it. |
| JPEG-11 | Ultra HDR / gain-map JPEG: skipped with a reason. |
| JPEG-12 | MPO (two JPEGs concatenated): skipped or both frames preserved. |
| JPEG-13 | `lossy` on: smaller result, SSIM above a floor, flagged lossy in the report; `lossy` off never runs these steps. |
| JPEG-14 | `arithmetic` on: smaller; off: never emits arithmetic coding. |
| JPEG-15 | Level 1 vs 9: level 9 never larger. |

## 2. PNG / APNG (tier 1)

Extensions: .png .apng (also .pns).
Detect: 8-byte PNG signature; `acTL` chunk means APNG.
Oracle: `pixels`; for APNG the composed picture after every frame (blend and dispose applied), delays as ratios, loop count, hidden/visible default image and its pixels.

Steps: native APNG pass (each frame's data recompressed with oxipng, no colour changes; layout, delays, blend/dispose untouched), pngquant *(lossy, strip; `--quality=0-q` with the lowest q (30 to 100) that keeps SSIM >= `lossy.ssim`, alpha classes kept; skipped for animated PNGs and files with a colour profile)*, native recompress (`Bun.Image` `png({compressionLevel: 9})` as a baseline only when it keeps pixels equal), PngOptimizer *(strip, Windows)*, TruePNG *(Windows)*, PNGOUT *(Windows)*, oxipng (levels by `level`, `--strip safe`), Leanify *(strip)*, zopflipng, pngwolf, pngrewrite *(strip)*, advpng *(strip)*, ECT, DeflOpt, defluff.
Guards: a 9-patch (`*.9.png`) has no special case: its border markers are ordinary pixels, so any change is rejected by the oracle. `cICP`, non-sRGB `cHRM`/`gAMA` without `sRGB`, ICC non-sRGB, `eXIf` orientation != 1 are kept (keepMetadata behaviour). Fully transparent pixels' RGB may change (invisible) and the oracle ignores them.

| ID | Case |
|---|---|
| PNG-01 | RGBA screenshot (generated) shrinks; pixels equal. |
| PNG-02 | Already optimal (oxipng -o max output): unchanged. |
| PNG-03 | 8/16-bit, gray, gray+alpha, palette, RGB, RGBA, 1/2/4-bit: every colour type and depth keeps pixels equal (PngSuite). |
| PNG-04 | Interlaced (Adam7) and non-interlaced; interlace is kept or removed with pixels equal. |
| PNG-05 | Text/time/EXIF chunks: stripped by default, kept with `keepMetadata`. |
| PNG-06 | ICC non-sRGB profile, `cICP`, `gAMA`+`cHRM` without sRGB: kept and colours equal. |
| PNG-07 | Fully transparent pixels with colour data: may be zeroed, oracle still passes. |
| PNG-08 | APNG: frames, delays, loop count, blend/dispose ops equal; default image handling (`IDAT` not part of animation) equal. |
| PNG-09 | 9-patch `.9.png`: border pixels intact. |
| PNG-10 | `lossy` on: palette-quantised, much smaller, flagged lossy; off: never. |
| PNG-11 | Truncated / CRC-broken PNG: untouched. |
| PNG-12 | Large (8000x8000) PNG stays within the memory bound and honours cancel. Above 16 megapixels the oracle reads the picture as a stream (a hash of the canonical pixels, memory near the file size); interlaced or animated pictures that large are skipped. |
| PNG-13 | PNG inside ICO/CUR/ZIP goes through the parent family's rules. |

## 3. GIF (tier 1)

Detect: `GIF87a` / `GIF89a`. Oracle: `pixels-tool` (every frame composited, delays, loop count, disposal).
Steps: ImageMagick *(lossy)*, gifsicle (`-O3`, `--no-comments --no-extensions` when stripping), gifsicle lossy mode *(lossy)*.

| ID | Case |
|---|---|
| GIF-01 | Static GIF: smaller, same pixels. |
| GIF-02 | Animated, many frames: frames/delays/loops equal; frame-differencing gains. |
| GIF-03 | Transparency and disposal methods 0-3 preserved. |
| GIF-04 | Comment and application extensions (NETSCAPE loop) : comments stripped, loop count kept. |
| GIF-05 | Interlaced GIF. |
| GIF-06 | Local colour tables and global table with unused entries. |
| GIF-07 | Truncated GIF untouched. |
| GIF-08 | `lossy` on: smaller, flagged lossy; off: never. |

## 4. WebP (tier 1)

Detect: `RIFF....WEBP`. Oracle: `pixels` (static); animated WebP is skipped (cwebp cannot read it).
Steps: cwebp lossless re-encode (`-lossless -z 9 -metadata none|all`), pingo only if installed by the user *(not bundled)*. Lossy WebP is never recompressed without `webp.lossy`; with it, `cwebp -q` runs at the lowest quality (20 to 95) that keeps SSIM >= `lossy.ssim` (alpha at full quality, ICC and needed EXIF kept).

| ID | Case |
|---|---|
| WEBP-01 | Lossless WebP: smaller, pixels equal. |
| WEBP-02 | Lossy WebP: unchanged by default; `lossy` on recompresses with SSIM floor. |
| WEBP-03 | Alpha preserved. |
| WEBP-04 | EXIF/XMP/ICC: stripped by default, kept with keepMetadata; EXIF orientation != 1 or non-sRGB ICC kept. |
| WEBP-05 | Animated WebP: skipped "animated". |
| WEBP-06 | Truncated: untouched. |

## 5. BMP / DIB (tier 2)

Oracle: a strict TypeScript reader (all depths, RLE4/RLE8, bitfields, OS/2 headers, top-down), pixel for pixel. Steps: native repack (palette of 2/16/256 colours raw or RLE when the picture has that few colours; 32-bit with an unused alpha byte to 24-bit). Left alone: real alpha, 16-bit and other non-8-bit bitfields, colour space or profile headers, OS/2 2.x, JPEG/PNG-in-BMP.
Cases: BMP-01 24-bit with few colours shrinks via palette; BMP-02 32-bit with alpha; BMP-03 RLE4/RLE8; BMP-04 top-down vs bottom-up; BMP-05 OS/2 headers; BMP-06 ICC/colour space headers kept; BMP-07 truncated untouched.

## 6. TIFF (tier 2)

Detect: `II*\0` / `MM\0*`. Oracle `pixels-tool` per page (ImageMagick pixel signature per frame) plus a tag check (every tag that is not layout survives; descriptive tags may go when not keeping metadata). Steps: tiffcp (Zip with predictor, Zip, LZW, CCITT G4 for black and white): a lossless copy of the samples, so tiling, planar layout, ICC and all pages stay. Tags are not stripped.
Skip: BigTIFF, GeoTIFF, TIFF with Photoshop layers/extra tags ImageMagick would drop ("unsupported TIFF").
Cases: TIFF-01 uncompressed → deflate smaller; TIFF-02 multi-page keeps every page; TIFF-03 16-bit and float samples; TIFF-04 CMYK and Lab; TIFF-05 tiled vs striped; TIFF-06 GeoTIFF skipped; TIFF-07 BigTIFF skipped; TIFF-08 EXIF/ICC kept when keepMetadata or non-sRGB ICC; TIFF-09 truncated untouched. (.fax, .ptif and .dng via TidyDNG are tier 3.)

## 7. ICO / CUR (tier 2)

Steps: oxipng on every PNG entry (`--strip safe`, follows `png.keepMetadata`), directory rebuilt. Oracle: every contained image (BMP or PNG) decodes to the same pixels; directory entries unchanged.
Cases: ICO-01 PNG-compressed icon sizes; ICO-02 BMP-based 32-bit; ICO-03 multi-resolution count preserved; ICO-04 cursor hotspot kept; ICO-05 colour-managed PNG inside: skipped; ICO-06 truncated untouched.

## 8. SVG / SVGZ (tier 1)

Detect: XML root `<svg`. Oracle: `text-structure` plus a rendered-pixel compare (resvg or ImageMagick).
Steps: minify (SVG). SVGZ: unpack, minify, gzip at level 9. Editor data (Inkscape/Sodipodi/RDF metadata) is dropped; the oracle compares structure with names resolved through namespaces, and the rendered pictures (resvg, 2x) must be byte-identical.
Skip: SVG with `<text>` (minification removes whitespace between `<tspan>`s) unless the oracle proves equal.
Cases: SVG-01 Inkscape output with metadata shrinks a lot; SVG-02 `<style>`/CSS, IDs referenced by `use`/`url(#x)` still resolve; SVG-03 embedded base64 images kept; SVG-04 SVG with text skipped; SVG-05 `xml:space="preserve"` respected; SVG-06 SVGZ roundtrip; SVG-07 malformed XML untouched; SVG-08 DOCTYPE/entities do not enable external entity loading (security).

## 9. PDF (tier 1)

Extensions: .pdf .ai .epdf .fdf. Detect: `%PDF-`. Oracle: `document`.
Lossless steps: mutool clean (garbage collect, compress streams), cpdf (squeeze), qpdf (`--object-streams=generate --recompress-flate --compression-level=9`; `--stream-data=compress`). Lossy *(pdf.profile != none)*: Ghostscript (`screen` | `ebook` | `printer` | `prepress` | `custom` dpi). A lossy result must keep the page count and the text (white space collapsed) and render alike: SSIM >= `lossy.pdfSsim` (0.9) on up to 12 pages sampled across the document (mutool, 50 dpi). qpdf image recompression is not implemented.
Skip: signed PDFs (`/ByteRange`, `/DocMDP`), PDF/A, encrypted without a password, layered PDFs when `skipLayered` and a profile is used; `.ai` never goes through Ghostscript, nor do PDFs with form fields.

| ID | Case |
|---|---|
| PDF-01 | Office-exported PDF with uncompressed objects shrinks; pages render equal. |
| PDF-02 | Already optimized: unchanged. |
| PDF-03 | Signed PDF: skipped "signed". |
| PDF-04 | PDF/A: skipped "PDF/A". |
| PDF-05 | Encrypted (owner password only): handled or skipped; user-password: skipped. |
| PDF-06 | Forms (AcroForm) and annotations preserved; bookmarks, links, named destinations, page labels preserved. |
| PDF-07 | Embedded fonts (TrueType/Type1/CFF) preserved; text extracts equal. |
| PDF-08 | Layered (OCG) PDF behaviour follows `skipLayered`. |
| PDF-09 | Linearized input: result valid (linearization may be dropped or kept, per setting). |
| PDF-10 | Broken xref / truncated: untouched or repaired only if the oracle then passes. |
| PDF-11 | `profile` ebook on a scanned PDF: much smaller, flagged lossy; `none`: never. |
| PDF-12 | `.ai` file: lossless steps only. |
| PDF-13 | Very large (1000+ pages) honours cancel and memory bound. |

## 10. HTML / CSS / JavaScript / JSON / XML (tier 2; off by default except SVG)

Detect by extension plus content sniffing. Oracle: `text-structure`.
HTML (`web.html`): minify (whitespace between tags, comments, optional attributes); skip documents with whitespace-sensitive content (`pre`, `textarea`, `white-space: pre*`, `xmp`, `listing`, `plaintext`, inline SVG `<text>`). CSS (`web.css`): minify. JS/JSON (`web.js`): JS uses a native whitespace/comment step (the minifier's rewrites cannot be proven equal by tokens); JSON keeps number spellings (`--json-keep-numbers`); `jsExtensions` for extra extensions (the engine asks the format for its form under the settings; `ts`, `tsx`, `jsx`, `mts`, `cts` are ignored); never JSX/TypeScript. XML-family (.xml .xhtml .xsl .xslt .kml .smil .fb2; `.sgml` is not XML and is not handled; setting `web.html`) : whitespace/comment removal only where the DOM compare proves equal.
Cases: WEB-01 HTML with comments; WEB-02 `<pre>` preserved byte-exact; WEB-03 inline `<script>`/`<style>` handled; WEB-04 conditional comments kept; WEB-05 CSS `calc()` spacing, `@media` queries, `!important`, custom properties; WEB-06 JS ASI hazards, regex literals vs division, template literals, strict-mode strings; WEB-07 JSON big numbers/`-0`/exponent spelling unchanged, duplicate keys left alone; WEB-08 BOM and CRLF handling; WEB-09 invalid input untouched; WEB-10 setting off: untouched (except SVG); WEB-11 XML entity expansion limits (billion-laughs file is rejected, never expanded).

## 11. ZIP-based containers (tier 1)

Extensions: .zip .zipx .jar .war .ear .epub .cbz .kmz .xps .oxps .ora .vsdx .3mf, Office (.docx .docm .dotx .dotm .xlsx .xlsm .xlsb .xltx .xltm .pptx .pptm .potx .potm .ppsx .ppsm .sldx .sldm), OpenDocument (.odt .ods .odp .odg .odf .odb), plus tier 3: .air .gallery* .lxf .nbk .notebook .pk3 .puz .wsz .wmz .bar .itz .mmip .s3z .stz .xap .zx01...
Detect: `PK\x03\x04` with end-of-central-directory.
Oracle: `archive` (names, bytes, order; mimetype first and stored for EPUB/ODF/OOXML as required; for recursion each inner file passes its own oracle).
Steps: Leanify *(strip)*, ECT *(strip)*, advzip, zopfli recompress per member (native `Bun.deflateSync` baseline), DeflOpt, defluff, zRecompress.
Skip: signed packages (.apk .aab .ipa .appx .msix .xpi .crx .vsix .nupkg), signed JARs and signed Office documents when recursion would alter signed parts, ZIPs with Unicode name extra fields tools would drop, encrypted entries.

| ID | Case |
|---|---|
| ZIP-01 | Plain ZIP of text files shrinks via better deflate; extracted bytes equal. |
| ZIP-02 | Already zopfli-compressed: unchanged. |
| ZIP-03 | Stored (uncompressed) members: compressed when smaller, kept stored when not. |
| ZIP-04 | Zip64, data descriptors, and large entry counts. |
| ZIP-05 | Member order, names (UTF-8 flag, CP437), directory entries, timestamps (`keepMetadata`), comments and extra fields. |
| ZIP-06 | Encrypted entries: file skipped. |
| ZIP-07 | Self-extracting stub or prepended data: skipped or preserved byte-exact. |
| ZIP-08 | EPUB: `mimetype` first and stored; OOXML `[Content_Types].xml` first; ODF `mimetype` stored. |
| ZIP-09 | DOCX/XLSX/PPTX open and render equal after (inner XML recompress only; with `recurse` also embedded images). |
| ZIP-10 | JAR with signature: skipped or recursion off for signed parts. |
| ZIP-11 | `archive.recurse`: inner PNG/JPEG/SVG optimised, each passing its own oracle; JPEG EXIF always kept inside archives. |
| ZIP-12 | Zip bomb (huge expansion ratio) is rejected before extraction; path traversal names (`../x`) never written outside the job folder. |
| ZIP-13 | Truncated/corrupt central directory: untouched. |
| ZIP-14 | Multi-part (.z01...) archives are skipped. |

## 12. GZip / TGZ / TAR / 7z / other archives (tier 1-2)

GZip (.gz .tgz .svgz): single-member only. Steps: libdeflate gzip level 12 *(strip name/time unless kept)*, Leanify, advdef, zRecompress, ECT, DeflOpt, defluff. Oracle: decompressed bytes equal (and header fields per keepMetadata). Skip multi-member/BGZF/damaged.
TAR (.tar): Leanify only with `archive.recurse`. Oracle: archive.
7z (.7z): m7zRepacker (Windows) or `7zz a -mx=9` repack, level 8-9; keeps empty folders, attributes, timestamps.
Others (tier 3): .lzma, .cab, .deb (ar + tar), .a, .lib (ar), .tgz.
Cases: GZ-01 text file shrinks; GZ-02 name/mtime/comment/extra field kept with keepMetadata, stripped by default; GZ-03 multi-member skipped; GZ-04 trailing garbage after member; GZ-05 `.tgz` outer gzip only (inner tar untouched unless recurse); GZ-06 truncated untouched. TAR-01 recurse off: untouched; TAR-02 recurse on: members optimised, headers (mode, uid, mtime) intact; TAR-03 long names/PAX headers; TAR-04 sparse and special files untouched. 7Z-01 repack smaller, listing equal; 7Z-02 solid vs non-solid; 7Z-03 encrypted skipped; 7Z-04 multi-volume skipped; 7Z-05 filters (BCJ/delta) retained when beneficial. DEB-01 control/data members preserved; AR-01 static library members preserved.

## 13. SQLite (tier 2)

Extensions: .sqlite .sqlite2 .sqlite3 .db (and app-specific .mdb is NOT SQLite: Access databases are tier 3, skipped). Detect: `SQLite format 3\0`. Oracle: `database`.
Steps: `sqlite3 in "VACUUM INTO out"` (and `PRAGMA page_size` tuning at higher levels). Skip when `-wal`, `-shm` or `-journal` exists next to the file ("database in use").
Cases: SQL-01 fragmented DB with free pages shrinks; SQL-02 schema, triggers, views, indices and `user_version`/`application_id` preserved (`.dump` equal); SQL-03 WAL-mode DB with a `-wal` file skipped; SQL-04 encrypted (SQLCipher) skipped as "not a database"; SQL-05 `auto_vacuum` mode kept; SQL-06 truncated/corrupt untouched.

## 14. Audio (tier 1-2)

Oracle: `audio`.
FLAC (.flac): trim *(`audio.trimSilence`, lossy: changes the samples at the ends; native: `flac -d` finds frames within one step of silence at both ends, `flac --skip --until` re-encodes, tags and pictures carried over; the oracle compares the samples between the silent ends)*, `flac -8 -e -p` re-encode, flacout *(level 9, Windows)*; metadata stripped unless kept.
WAV (.wav): strip non-audio chunks (native); trimming silence from WAV is not implemented (only FLAC has `audio.trimSilence`).
MP3 (.mp3): mp3packer (verified by ffmpeg decode equality; skipped if gapless info would be lost). Tags: ID3v1/v2/APE stripped unless kept.
Ogg Vorbis (.ogg .oga .opus .spx): OptiVorbis (Vorbis only, verified by decode equality); Opus/Speex/FLAC-in-Ogg skipped.
M4A/M4B/M4P/M4R (.m4a ...): ffmpeg remux + mp4 box cleanup; `audio.keepMetadata` applies.
Others (tier 3): .wma, .ra, .ram, .rm, .mpc, .ac, .adp, .acc, .weba, .mka.
Cases: FLAC-01 high-level re-encode smaller, sample hash equal; FLAC-02 tags, cuesheet, embedded art stripped/kept; FLAC-03 trimSilence changes samples only when enabled; FLAC-04 24-bit, multichannel, 192 kHz; FLAC-05 truncated untouched. WAV-01 LIST/INFO/bext/junk chunks removed, `fmt`/`data` intact; WAV-02 extensible format; WAV-03 odd-length chunk padding; WAV-04 RF64/BWF; WAV-05 float samples. MP3-01 VBR/CBR packing shrinks, decode hash equal; MP3-02 gapless (LAME/Xing header) preserved or step rejected; MP3-03 ID3 tags and cover art stripped/kept; MP3-04 free-format/MPEG-2/2.5; MP3-05 junk before first frame; MP3-06 truncated tail. OGG-01 Vorbis repack equal; OGG-02 chained/multiplexed streams; OGG-03 Opus skipped with reason; OGG-04 Theora video named .ogg routed to video; OGG-05 very short file where OptiVorbis changes sample count is rejected. M4A-01 tags kept with keepMetadata; M4A-02 `moov` at end moved to front only if allowed (faststart keeps stream identical); M4A-03 DRM (`drms`/`sinf`) skipped.

## 15. Video (tier 2)

Oracle: `packets`. Steps: ffmpeg remux (`-c copy -map 0`, drop global tags unless kept; track language/title kept), then mp4v2/mp4file box optimise (not fragmented MP4), mkclean (not WebM, not Matroska v4 elements), rehuff_theora (Windows). Ogg Skeleton streams (not copyable by ffmpeg) are dropped; extradata size is not compared for Ogg, where the comment header lives in it. mp4file/MP4Box/mkclean results go through the same oracle. A remux result smaller than half the original is rejected; any demux error rejects the result (no truncated outputs).
Extensions: .mp4 .m4v .mov .qt .3gp .3g2 .3gg .mkv .mk3d .mka .mks .webm .ogv .ogm .ogx .avi .flv .mpg .mpeg .vob .wmv .rm .rmvb (the legacy ones are tier 3).
Cases: MP4-01 faststart/`moov` placement and free-space removal shrink, packets equal; MP4-02 fragmented MP4 skipped by mp4file; MP4-03 multiple audio/subtitle tracks and languages kept; MP4-04 chapters and cover art kept per keepMetadata; MP4-05 HEVC/AV1/VP9 pass-through; MP4-06 edit lists preserved; MP4-07 truncated (no `moov`) untouched. MKV-01 mkclean shrinks, streams equal; MKV-02 WebM untouched by mkclean; MKV-03 attachments (fonts) and chapters kept; MKV-04 Matroska v4 elements skipped; MKV-05 SeekHead/Cues rebuilt, seeking works. AVI-01 index and junk chunks; FLV-01; MPG-01 (tier 3: remux only when packets equal).

## 16. Executables and libraries (tier 3; off by default)

Extensions: .exe .dll .ocx .cpl .scr .sys .drv .msi (compound file, see 17) .o .a .lib. Setting `exe.enabled` required.
Steps: Leanify (PE without ASLR), PETrim, `strip` (ELF/Mach-O, GNU strip or `strip -x`), UPX only with `exe.upx` (changes runtime behaviour: AV false positives, startup cost; never default).
Skip: Authenticode-signed, installers/self-extractors (appended data, PyInstaller, .NET single-file), notarised macOS binaries (stripping breaks the signature).
Implemented steps: a native PE step that drops a trailing COFF symbol table (checksum fixed), `gnu-strip` (GNU/LLVM strip: ELF, PE debug sections, `ar` of ELF objects; objects and archives only lose debug data), Apple `strip -x` for Mach-O (ad hoc/linker signatures are re-made by strip and checked with `codesign --verify`), Leanify when installed (not in Homebrew), UPX with `exe.upx` (verified by unpacking). Oracle: `bytes-subset`: parses both files and compares segments/sections, relocations and symbol names. Cases: EXE-01 PE with debug symbols and slack shrinks and still runs (smoke test); EXE-02 signed skipped; EXE-03 appended overlay data preserved or skipped; EXE-04 ELF `strip` keeps loadability (`readelf`/run); EXE-05 Mach-O fat binaries and code signature (skipped when signed); EXE-06 .NET assemblies skipped; EXE-07 `exe.upx` off never runs UPX.

## 17. Office legacy / compound documents (tier 3)

Extensions: .doc .dot .xls .xla .xlc .xlm .xlw .xlt .ppt .pps .pot .pub .vsd .vss .vst .vsx .vtx .mpp .mpt .mpd .wps .msg .msi .msp .mst .ole .ole2 .opt .max .sldprt .sldasm .slddrw (SolidWorks) .rvt .rfa .rte .rft .rfg (Revit) .dwf .cdr .cdt .fla.
Steps: Best CFBF Optimizer (Windows) or an in-engine CFBF rewrite (defragment, drop free sectors, reorder); for the container-over-zip ones (.dwfx .vsdx .fla .cdr) use family 11; Leanify for embedded streams.
Oracle: `archive`-like over the compound file: same storages/streams (names, bytes), directory tree and CLSIDs; Office files must open (smoke tests where an app exists).
Cases: CFB-01 .doc with free sectors shrinks, streams equal; CFB-02 .xls with VBA macros intact; CFB-03 .msi with signature skipped; CFB-04 .msg attachments intact; CFB-05 mini-stream/v4 (4 KB sectors); CFB-06 damaged FAT untouched.

## 18. Flash, Lua, misc scripts (tier 3)

.swf: Flasm/zlib recompress of the compressed container (`CWS` to better deflate; `ZWS` LZMA kept), oracle: tag stream equal. .luac/.lua: Leanify for bytecode where safe; sources untouched. .js is family 10. .jar/.war are family 11. Cases: SWF-01 CWS recompress, tags equal; SWF-02 FWS uncompressed → compress only if the Flash version allows; LUA-01 bytecode untouched when not provably equal.

## 19. Long tail: rare formats (tier 3)

Rare raster, vector and data formats. Strategy per format: **re-encode into the same format with lossless settings only if the oracle `pixels-tool` is exactly equal**, else skip with "no lossless gain". Do these only after tiers 1-2 are solid.

- **Raster (ImageMagick delegates):** .aai .art .avs .bpg (needs bpgenc) .cin .cmyk .cmyka .dcx .dds .dpx .fits .fpx .gray .grs .hdr .hrz .icb .jng .jp2 .j2c .j2k .jpc .jxl (skipped: unsupported) .mng .mono .msl .mtv .otb .palm .pbm .pcd .pcds .pcx .pfm .pgm .pict .picon .pnm .ppm .psb .psd (layers: skipped) .rgb .rgba .sgi .sun .tga .vda .vicar .viff .wbmp .wal .xbm .xpm .xwd .ycbr .ycbra .uyvy .heic/.heif/.avif (skipped: unsupported; verify-only decode via `Bun.Image` on macOS).
- **Vector / print:** .ai (family 9), .eps/.ps via Ghostscript only with a PDF profile, .cdr (family 11 if zip), .dwf/.dwfx, .kml/.kmz (XML + zip).
- **Documents/text:** .eml .emlx .mht .mhtml (MIME: base64 PNG/JPEG/GIF parts recompressed, every other byte kept; DKIM/S/MIME/PGP-signed messages skipped), .fb2 (XML, section 10), .vcf .vcard, .chm/.chi/.chq/.chs/.chw (CHM: no safe rewriter, skipped), .lit, .ink/.lnk (skipped). Skipped ones report `unsupported: <reason>` (`known-unsupported.format.ts`).
- **Games/apps:** .pk3 (zip), .wsz/.wmz/.stz (zip skins), .r2skin/.rmskin (zip), .s3z, .itz, .xap, .air, .ipk (ar+tar), .ipsw (zip, signed: skipped), .cbt (tar), .cbz (zip).
- **DBs/other:** .mdb/.mdt/.mdz (Access: skipped), .odb (zip), .rdb, .onenote (`.one`: skipped), .bsz, .gft, .ksf, .lzl, .nbk.

Cases per format are one fixture set each, generated with ImageMagick (`magick convert`) plus the standard invariants: LONG-xx "decodes equal after", "unsupported variant skipped", "truncated untouched".

---

## Settings coverage matrix

Each setting has a test that proves its effect and its absence: `level` (COMMON-22), `lossy` per format (JPEG-13, PNG-10, GIF-08, WEBP-02), `keepMetadata` per family (JPEG-03, PNG-05, WEBP-04, TIFF-08, GZ-02, ZIP-05, M4A-01, MP4-04), `jpeg.arithmetic` (JPEG-14), `pdf.profile/dpi/skipLayered` (PDF-08, PDF-11), `audio.trimSilence` (FLAC-03), `archive.recurse` (ZIP-11, TAR-02), `web.*` (WEB-10), `exe.*` (EXE-07), `disabledTools`, `toolPaths`, `include/exclude` globs, `skipOptimized` (COMMON-02), `preserveTimestamps` (COMMON-13), `workers` (COMMON-16), `lowPriority`.

## Not in scope (skipped with a clear reason, never touched)

Signed packages (.apk .aab .ipa .appx .appxbundle .msix .msixbundle .xpi .crx .ipsw .vsix .nupkg), AVIF / HEIC / JPEG XL (no lossless gain tooling yet), PDFs with signatures or PDF/A, executables that are signed or self-extracting, SQLite databases in use, animated WebP, multi-part archives, DRM-protected media, encrypted files.
