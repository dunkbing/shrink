#!/usr/bin/env bash
# Builds a minimal static ffmpeg + ffprobe: only what Shrink runs (stream copy between containers, audio decoding
# for hashes, the hash/streamhash muxers). No video decoders/encoders, no network, no external libraries.
# usage: ffmpeg-min.sh <outdir> [workdir]   -> <outdir>/ffmpeg(.exe), <outdir>/ffprobe(.exe)
set -euo pipefail
VERSION=8.1
SHA256=b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a
OUT=$(cd "$1" && pwd)
WORK=${2:-$(mktemp -d)}
mkdir -p "$WORK" && cd "$WORK"
# ffmpeg.org resets some CI connections: retry, then a mirror
for u in "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" "https://ftp.osuosl.org/pub/blfs/conglomeration/ffmpeg/ffmpeg-$VERSION.tar.xz"; do
  curl -fsSL --retry 4 --retry-all-errors -o src.tar.xz "$u" && break
done
echo "$SHA256  src.tar.xz" | (command -v sha256sum >/dev/null && sha256sum -c - || shasum -a 256 -c -)
tar xf src.tar.xz && cd "ffmpeg-$VERSION"

list() { ./configure --list-"$1" 2>/dev/null | tr '\n' ' '; }
pick() { list "$1" | tr ' ' '\n' | grep -E "$2" | paste -sd, -; }

EXTRA=()
case "$(uname -s)" in
  Linux) EXTRA+=(--extra-ldflags=-static --pkg-config-flags=--static) ;;
  MINGW*|MSYS*) EXTRA+=(--target-os=mingw32 --arch=x86_64) ;;
esac

./configure --prefix="$PWD/out" --disable-everything --disable-autodetect --disable-doc --disable-network \
  --disable-debug --disable-ffplay --enable-ffmpeg --enable-ffprobe --disable-shared --enable-static \
  --enable-small --enable-protocol=file,pipe \
  --enable-demuxer="$(pick demuxers '^(mov|matroska|avi|flv|mpegps|mpegts|ogg|mp3|flac|wav|aac|ac3|eac3|ape|caf|aiff|asf|amr|dsf|wv|tta|tak|ivf|mpegvideo|h264|hevc|m4v|dts|truehd|w64|au|voc)$')" \
  --enable-muxer="mp4,ipod,mov,matroska,webm,avi,flv,mpeg1system,mpeg2vob,ogg,streamhash,hash,framehash,null,wav,mp3,flac,adts,md5,crc" \
  --enable-decoder="$(pick decoders '^(aac|aac_latm|ac3|eac3|alac|flac|mp1|mp2|mp3|mp3float|opus|vorbis|wavpack|ape|tta|tak|dca|truehd|mlp|amrnb|amrwb|wmav1|wmav2|cook|atrac3|dsd_lsbf|dsd_msbf|pcm_.*)$')" \
  --enable-encoder=pcm_f64le,pcm_s16le --enable-parser="$(pick parsers '.')" --enable-bsf="$(pick bsfs '.')" \
  --enable-filter=aresample,aformat,anull,null,format,atrim,asetpts \
  ${EXTRA[@]+"${EXTRA[@]}"}
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)" ffmpeg ffprobe
for b in ffmpeg ffprobe; do cp "$b$([ -f "$b.exe" ] && echo .exe)" "$OUT/"; done
strip "$OUT"/ffmpeg* "$OUT"/ffprobe* 2>/dev/null || true
