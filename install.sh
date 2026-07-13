#!/usr/bin/env bash
# Install a prebuilt Dictum binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/dictum/main/install.sh | bash
#
# Env overrides:
#   DICTUM_REPO     owner/repo            (default: KsandrSol/dictum)
#   DICTUM_VERSION  vX.Y.Z | latest       (default: latest)
#   DICTUM_BIN_DIR  install directory     (default: ~/.local/bin)
#   DICTUM_CODEX    0 to skip Codex setup (default: configure when Codex exists)
set -euo pipefail

REPO="${DICTUM_REPO:-KsandrSol/dictum}"
VERSION="${DICTUM_VERSION:-latest}"
BIN_DIR="${DICTUM_BIN_DIR:-$HOME/.local/bin}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

err() {
  echo "install: $*" >&2
  exit 1
}

toml_string() {
  # The installed binary path is normally simple, but quote it correctly if a
  # user selected a directory with spaces, quotes, or backslashes.
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# Optional Codex CLI wiring: register the MCP server and a `dictum:` chat
# shorthand. Runs only when ~/.codex already exists, announces every change,
# is idempotent (marker-guarded), and DICTUM_CODEX=0 skips it entirely.
setup_codex() {
  [ "${DICTUM_CODEX:-1}" = "0" ] && return 0
  [ -d "$CODEX_HOME" ] || return 0

  local config="${CODEX_HOME}/config.toml"
  local guidance="${CODEX_HOME}/AGENTS.md"
  local begin="# >>> dictum-codex >>>"

  if [ ! -f "$config" ] || ! grep -q '^\[mcp_servers\.dictum\]$' "$config"; then
    {
      printf '\n# Added by Dictum: host-brain prompt overlay.\n'
      printf '[mcp_servers.dictum]\n'
      printf 'command = "%s"\n' "$(toml_string "$BIN_DIR/dictum")"
      printf 'args = ["mcp"]\n'
    } >> "$config"
    echo "install: registered Dictum MCP for Codex."
  else
    echo "install: Dictum MCP is already registered for Codex."
  fi

  if [ ! -f "$guidance" ] || ! grep -Fq "$begin" "$guidance"; then
    cat >> "$guidance" <<'EOF'

# >>> dictum-codex >>>
## Dictum shorthand

If a user message begins with `dictum:`, `dictum spec:`, or
`dictum decompose:`, it is an explicit Dictum request. Take the text after the
prefix as the rough draft and, before doing any work or calling any other tool,
call the Dictum MCP server's `polish_brief` tool. Use mode `polish` by default,
or `spec`/`decompose` from the prefix. Follow the returned brief: show the
proposed result and wait for the user's 1/2/3 choice. Do not execute the draft
before they choose.

Examples:
- `dictum: fix the failing test`
- `dictum spec: add CSV export`
- `dictum decompose: migrate auth to OAuth`
# <<< dictum-codex <<<
EOF
    echo "install: added the 'dictum:' shorthand to Codex guidance."
  else
    echo "install: Codex shorthand guidance is already present."
  fi

  echo "install: restart Codex to load the MCP server and guidance."
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
