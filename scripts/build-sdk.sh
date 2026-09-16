#!/usr/bin/env bash
#
# Builds the client SDK and stages it where the Go build embeds it, so the
# broker can serve it at /sdk.js.
#
# Run this before `go build`/`go run` in the server directory if you want the
# /sdk.js route live locally. The Dockerfile does the equivalent in its
# sdk-builder stage, so container builds never need this.
#
#   scripts/build-sdk.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="$ROOT/packages/vconsole-remote"
DEST="$ROOT/server/assets/sdk.js"

cd "$SDK_DIR"
npm ci --no-audit --no-fund
npm run build

mkdir -p "$(dirname "$DEST")"
# The minified UMD build: this ships to real phones, so the ~80kB the
# unminified bundle adds is not free.
cp dist/vconsole-remote.min.js "$DEST"

printf 'staged %s (%s bytes)\n' "$DEST" "$(wc -c < "$DEST")"
