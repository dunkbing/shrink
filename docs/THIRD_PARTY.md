# Third-party tools

Shrink runs these programs as separate processes; it does not link them. They are distributed unmodified
unless noted, with their own licences. Generated from `packages/engine/tools/manifest.json`.

| Tool | Pack | Version | Licence | Home |
| --- | --- | --- | --- | --- |
| 7zz | archive | 26.05 | LGPL-2.1-or-later with unRAR restriction | https://www.7-zip.org |
| MP4Box | media | see the package | LGPL-2.1-or-later | https://gpac.io |
| advzip | core | 2.6 | GPL-2.0-or-later | https://www.advancemame.it/comp-readme |
| cabextract | archive | see the package | GPL-2.0-or-later | https://www.cabextract.org.uk |
| cwebp | core | 1.6.0 | BSD-3-Clause | https://developers.google.com/speed/webp |
| ffmpeg | core | 8.1 | LGPL-2.1-or-later (built without GPL parts) | https://ffmpeg.org |
| ffprobe | core | 8.1 | LGPL-2.1-or-later | https://ffmpeg.org |
| flac | media | see the package | BSD-3-Clause / GPL-2.0 (tools) | https://xiph.org/flac/ |
| gifsicle | core | see the package | GPL-2.0-only | https://www.lcdf.org/gifsicle/ |
| jpegoptim | images | see the package | GPL-2.0-or-later | https://github.com/tjko/jpegoptim |
| jpegtran | core | see the package | BSD-3-Clause / IJG / Zlib | https://github.com/mozilla/mozjpeg |
| magick | images | see the package | ImageMagick License | https://imagemagick.org |
| metaflac | media | see the package | GPL-2.0-or-later | https://xiph.org/flac/ |
| minify | web | 2.24.25 | MIT | https://github.com/tdewolff/minify |
| mkclean | media | see the package | BSD-3-Clause | https://www.matroska.org/downloads/mkclean.html |
| mozjpegtran | core | see the package | BSD-3-Clause / IJG / Zlib | https://github.com/mozilla/mozjpeg |
| mutool | docs | see the package | AGPL-3.0-or-later (separate process) | https://mupdf.com |
| oxipng | core | 10.2.1 | MIT | https://github.com/shssoichiro/oxipng |
| qpdf | docs | see the package | Apache-2.0 | https://qpdf.sourceforge.io |
| resvg | web | 0.49.0 | MPL-2.0 | https://github.com/linebender/resvg |
| sqlite3 | core | see the package | Public domain | https://sqlite.org |
| tiffcp | images | see the package | libtiff License | https://libtiff.gitlab.io/libtiff/ |
| upx | exe | 5.3.0 | GPL-2.0-or-later with UPX exception | https://upx.github.io |
| xz | core | see the package | 0BSD / GPL-2.0-or-later (tool) | https://tukaani.org/xz/ |
| zopfli | core | see the package | Apache-2.0 | https://github.com/google/zopfli |

## Source code

- 7zz (LGPL-2.1-or-later with unRAR restriction): https://www.7-zip.org
- MP4Box (LGPL-2.1-or-later): https://gpac.io
- advzip (GPL-2.0-or-later): https://www.advancemame.it/comp-readme
- cabextract (GPL-2.0-or-later): https://www.cabextract.org.uk
- ffmpeg (LGPL-2.1-or-later (built without GPL parts)): https://ffmpeg.org
- ffprobe (LGPL-2.1-or-later): https://ffmpeg.org
- flac (BSD-3-Clause / GPL-2.0 (tools)): https://xiph.org/flac/
- gifsicle (GPL-2.0-only): https://www.lcdf.org/gifsicle/
- jpegoptim (GPL-2.0-or-later): https://github.com/tjko/jpegoptim
- metaflac (GPL-2.0-or-later): https://xiph.org/flac/
- mutool (AGPL-3.0-or-later (separate process)): https://mupdf.com
- upx (GPL-2.0-or-later with UPX exception): https://upx.github.io
- xz (0BSD / GPL-2.0-or-later (tool)): https://tukaani.org/xz/

For the GPL / LGPL / AGPL programs above, the complete corresponding source code is available from the home
pages listed, at the versions in the table. We will also provide it on request for three years after the pack was
published: open an issue at https://github.com/dunkbing/shrink/issues. The build script of the stripped ffmpeg is in the repository
(`scripts/tools/ffmpeg-min.sh`); the licence texts shipped by each upstream are in `licenses/` where the
upstream archive had them.
