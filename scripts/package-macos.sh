#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/build-offline-runtime.py
export MACOSX_DEPLOYMENT_TARGET=13.6
export RUSTFLAGS="--remap-path-prefix=$HOME=/build"
export CARGO_TARGET_DIR="$PWD/src-tauri/target"
export PYTHONDONTWRITEBYTECODE=1
cargo tauri build --bundles app
APP="$CARGO_TARGET_DIR/release/bundle/macos/StemWave Extract.app"
# Python caches contain machine-specific paths and are never release resources.
find "$APP/Contents/Resources/engine" -type d -name __pycache__ -prune -exec rm -rf '{}' +
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
mkdir -p builds/release
VERSION=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
ZIP="StemWave-Extract-${VERSION}-arm64.zip"
ditto -c -k --keepParent "$APP" "builds/release/$ZIP"
(cd builds/release && shasum -a 256 "$ZIP" ffmpeg-7.1.tar.xz > SHA256SUMS.txt)
