#!/usr/bin/env bash
# Install a prebuilt Dictum binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/dictum/main/install.sh | bash
#
# Env overrides:
#   DICTUM_REPO     owner/repo            (default: KsandrSol/dictum)
#   DICTUM_VERSION  vX.Y.Z | latest       (default: latest)
#   DICTUM_BIN_DIR  install directory     (default: ~/.local/bin)
#   DICTUM_CODEX    0 to skip Codex MCP + prefix-hook setup
#                                         (default: configure when Codex exists)
set -euo pipefail

REPO="${DICTUM_REPO:-KsandrSol/dictum}"
VERSION="${DICTUM_VERSION:-latest}"
BIN_DIR="${DICTUM_BIN_DIR:-$HOME/.local/bin}"

err() {
  echo "install: $*" >&2
  exit 1
}

# Optional Codex CLI wiring: register the MCP server through Codex's own CLI
# and let the installed binary set up the deterministic `dictum:` prefix hook
# plus the managed $dictum skill (which also removes the legacy v0.1.x
# guidance block). Runs only when the codex CLI is present, announces every
# change, and DICTUM_CODEX=0 skips it entirely.
setup_codex() {
  [ "${DICTUM_CODEX:-1}" = "0" ] && return 0
  command -v codex > /dev/null 2>&1 || return 0

  local existing compact expected
  if existing="$(codex mcp get dictum --json 2>/dev/null)"; then
    compact="$(printf '%s' "$existing" | tr -d '[:space:]')"
    expected="$(printf '%s' "$BIN_DIR/dictum" | tr -d '[:space:]')"
    if printf '%s\n' "$compact" | grep -Fq "\"command\":\"$expected\"" &&
      printf '%s\n' "$compact" | grep -Fq '"args":["mcp"]' &&
      printf '%s\n' "$compact" | grep -Fq '"enabled":true'; then
      echo "install: Dictum MCP already points to the installed binary."
    else
      echo "install: warning: an existing Dictum MCP entry was left unchanged." >&2
      echo "install: it does not exactly match enabled command $BIN_DIR/dictum with args [mcp]." >&2
      echo "install: inspect it with: codex mcp get dictum" >&2
      echo "install: to replace it, run: codex mcp remove dictum" >&2
      echo "install: then run: codex mcp add dictum -- \"$BIN_DIR/dictum\" mcp" >&2
    fi
  elif codex mcp add dictum -- "$BIN_DIR/dictum" mcp; then
    echo "install: registered Dictum MCP for Codex."
  else
    echo "install: warning: could not register Dictum MCP automatically." >&2
    echo "install: run: codex mcp add dictum -- \"$BIN_DIR/dictum\" mcp" >&2
  fi

  if "$BIN_DIR/dictum" codex setup --binary "$BIN_DIR/dictum"; then
    echo "install: configured deterministic dictum: routing for Codex."
    echo "install: start a new Codex session, open /hooks, and trust 'Routing Dictum prompt'."
  else
    echo "install: warning: could not configure the Codex prefix hook." >&2
    echo "install: run: dictum codex setup --binary \"$BIN_DIR/dictum\"" >&2
  fi
}

# Detect OS
os="$(uname -s)"
case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) err "unsupported OS: $os (Linux/macOS only). On other systems use: npm i -g dictum-cli (needs Bun)" ;;
esac

# Prebuilt Linux binaries are glibc-only — fail early on musl (Alpine etc.)
# NB: musl's `ldd --version` exits non-zero while printing its banner, so the
# status must be decoupled from the output (pipefail would eat a plain pipe).
if [ "$os" = "linux" ] && command -v ldd > /dev/null 2>&1; then
  ldd_out="$(ldd --version 2>&1 || true)"
  case "$ldd_out" in
    *musl* | *Musl* | *MUSL*)
      err "musl libc detected (Alpine?): prebuilt binaries are glibc-only. Use: npm i -g dictum-cli (needs Bun)"
      ;;
  esac
fi

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

# Verify the digest against the release's SHA256SUMS. Fail closed on ANY
# failure, including 404: every published release ships the manifest, so a
# missing one means a broken or tampered release, not a legacy artifact.
sha256_of() {
  # macOS ships shasum, not GNU sha256sum
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

sums_url="${url%/*}/SHA256SUMS"
sums_tmp="$(mktemp)"
http_code="$(curl -sSL -o "$sums_tmp" -w '%{http_code}' "$sums_url" || echo 000)"
if [ "$http_code" = "200" ]; then
  want="$(awk -v a="$asset" '$2 == a { print $1 }' "$sums_tmp")"
  [ -n "$want" ] || err "SHA256SUMS has no entry for ${asset}"
  got="$(sha256_of "$tmp")"
  [ "$got" = "$want" ] || err "checksum mismatch for ${asset}: expected ${want}, got ${got}"
  echo "install: checksum verified"
else
  err "could not fetch SHA256SUMS (HTTP ${http_code}) — refusing to install unverified"
fi
rm -f "$sums_tmp"

chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/dictum"
trap - EXIT

echo "install: installed to $BIN_DIR/dictum"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "install: add $BIN_DIR to PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
setup_codex
echo "install: run 'dictum doctor' to check your setup."
