#!/usr/bin/env bash
# Install a prebuilt Dictum binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/dictum/main/install.sh | bash
#
# Env overrides:
#   DICTUM_REPO     owner/repo            (default: ksandrbn/dictum)
#   DICTUM_VERSION  vX.Y.Z | latest       (default: latest)
#   DICTUM_BIN_DIR  install directory     (default: ~/.local/bin)
set -euo pipefail

REPO="${DICTUM_REPO:-ksandrbn/dictum}"
VERSION="${DICTUM_VERSION:-latest}"
BIN_DIR="${DICTUM_BIN_DIR:-$HOME/.local/bin}"

err() {
  echo "install: $*" >&2
  exit 1
}

# Detect OS
os="$(uname -s)"
case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) err "unsupported OS: $os (Linux/macOS only). On other systems use: npm i -g dictum-cli (needs Bun)" ;;
esac

# Detect arch
arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

asset="dictum-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

echo "install: downloading ${asset} (${VERSION}) from ${REPO}…"
mkdir -p "$BIN_DIR"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if ! curl -fSL "$url" -o "$tmp"; then
  err "download failed: $url
  (no release published yet? build locally instead: bun run build → ./dist/dictum)"
fi

chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/dictum"
trap - EXIT

echo "install: installed to $BIN_DIR/dictum"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "install: add $BIN_DIR to PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "install: run 'dictum doctor' to check your setup."
