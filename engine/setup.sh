#!/bin/bash
# First-run setup for StemWave Extract. Everything goes into $STEMWAVE_RUNTIME
# (~/Library/Application Support/com.stemwave.extract); nothing else on the Mac changes.
#   - Python 3.10 and the locked packages, via the bundled uv ($UV)
#   - FFmpeg, from the imageio-ffmpeg package
#   - the separation and beat models, from their original sources, SHA-256 checked
# Prints "STEP n/5 message" lines for the app's progress display. Safe to re-run.
set -euo pipefail
: "${STEMWAVE_RUNTIME:?}" "${UV:?}"
ENGINE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$STEMWAVE_RUNTIME"
mkdir -p "$RUNTIME/models"
# Keep the interpreter inside the runtime folder too: deleting that folder uninstalls everything.
export UV_PYTHON_INSTALL_DIR="$RUNTIME/python"

download() { # url, destination, sha256
  local url=$1 dest=$2 sum=$3
  if [ -f "$dest" ] && [ "$(shasum -a 256 "$dest" | cut -d' ' -f1)" = "$sum" ]; then return; fi
  local bundled="$ENGINE/../checkpoints/$(basename "$dest")"
  if [ -f "$bundled" ]; then
    cp "$bundled" "$dest.part"
  else
    curl -fL --retry 3 --silent --show-error -o "$dest.part" "$url"
  fi
  if [ "$(shasum -a 256 "$dest.part" | cut -d' ' -f1)" != "$sum" ]; then
    rm -f "$dest.part"; echo "ERROR Downloaded file failed its checksum: $(basename "$dest")"; exit 1
  fi
  mv "$dest.part" "$dest"
}

echo "STEP 1/5 Installing Python"
# uv's own Python build, never a system or Homebrew one, so every Mac gets the same interpreter.
[ -x "$RUNTIME/venv/bin/python" ] || "$UV" venv --quiet --python 3.10 --python-preference only-managed "$RUNTIME/venv"

echo "STEP 2/5 Installing audio libraries (about 500 MB)"
"$UV" pip install --quiet --python "$RUNTIME/venv/bin/python" -r "$ENGINE/requirements.lock"

echo "STEP 3/5 Installing the separation model"
HF="https://huggingface.co/ChanTrail/BS-RoFormer/resolve/dfeae36f9a86d51e412c1d17c182cda97b3610d1"
download "$HF/BS-Rofo-SW-Fixed.yaml" "$RUNTIME/models/BS-Rofo-SW-Fixed.yaml" f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b
download "$HF/BS-Rofo-SW-Fixed.ckpt" "$RUNTIME/models/BS-Rofo-SW-Fixed.ckpt" 24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e

echo "STEP 4/5 Downloading the beat model"
download "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt" "$RUNTIME/models/beat_this-final0.ckpt" 8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331

echo "STEP 5/5 Checking"
FFMPEG="$("$RUNTIME/venv/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
"$FFMPEG" -hide_banner -version > /dev/null
"$RUNTIME/venv/bin/python" -c 'import torch, scipy, yaml, einops, rotary_embedding_torch, beat_this'
printf '{"version": 1, "python": "%s", "ffmpeg": "%s"}\n' "$RUNTIME/venv/bin/python" "$FFMPEG" > "$RUNTIME/ready.json.tmp"
mv "$RUNTIME/ready.json.tmp" "$RUNTIME/ready.json"
echo "DONE"
