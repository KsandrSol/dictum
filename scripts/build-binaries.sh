#!/usr/bin/env bash
# Cross-compile standalone Dictum binaries for the release matrix.
# Bun downloads each target runtime on demand. Output → dist/dictum-<os>-<arch>.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
mkdir -p dist

targets=(
  "bun-linux-x64:dictum-linux-x64"
  "bun-linux-arm64:dictum-linux-arm64"
  "bun-darwin-x64:dictum-darwin-x64"
  "bun-darwin-arm64:dictum-darwin-arm64"
)

# Allow building a subset: `build-binaries.sh linux-arm64`
filter="${1:-}"

for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  if [[ -n "$filter" && "$name" != *"$filter"* ]]; then
    continue
  fi
  echo "building $name ($target)…"
  bun build --compile --minify --target="$target" --outfile "dist/$name" src/cli.ts
done

echo "done → dist/"
ls -la dist/ | grep dictum- || true
