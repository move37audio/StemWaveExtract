#!/bin/bash
# Downloads the pinned official uv release (MIT/Apache-2.0) that the app bundles for first-run setup.
set -euo pipefail
VERSION=0.7.12
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor"
NAME=uv-aarch64-apple-darwin
mkdir -p "$DEST"
cd "$(mktemp -d)"
curl -fsSL -o "$NAME.tar.gz" "https://github.com/astral-sh/uv/releases/download/$VERSION/$NAME.tar.gz"
curl -fsSL -o "$NAME.tar.gz.sha256" "https://github.com/astral-sh/uv/releases/download/$VERSION/$NAME.tar.gz.sha256"
shasum -a 256 -c "$NAME.tar.gz.sha256"
tar -xzf "$NAME.tar.gz"
install -m 755 "$NAME/uv" "$DEST/uv"
"$DEST/uv" --version
