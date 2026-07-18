#!/usr/bin/env bash
# Download the pinned codex CLI release binary into the solstice-codex
# built-in extension so the IDE ships with its own agent backend.
# Usage: bundle-codex-binary.sh <win32|darwin|linux>
# NOTE: must stay bash-3.2 compatible (macOS runners).
set -euo pipefail

CODEX_VERSION="rust-v0.144.4"
TARGET="${1:?usage: $0 <win32|darwin|linux>}"

case "$TARGET" in
  win32)  ASSET="codex-x86_64-pc-windows-msvc.exe.tar.gz"; INNER="codex-x86_64-pc-windows-msvc.exe"; OUT="codex.exe"; EXPECTED_SHA256="b309e797d45a931db9bef3e1a50ea3246fc766e9139af4cde1f8dc8b508f3360" ;;
  darwin) ASSET="codex-aarch64-apple-darwin.tar.gz";       INNER="codex-aarch64-apple-darwin";       OUT="codex";     EXPECTED_SHA256="77c8969a481302f9db1d9ea2a6c21c083abae3f1a8fc8a7275dc38323699391e" ;;
  linux)  ASSET="codex-x86_64-unknown-linux-musl.tar.gz";  INNER="codex-x86_64-unknown-linux-musl";  OUT="codex";     EXPECTED_SHA256="37c985be9d89e8c4f43b3aa0594c1213eac212d30ae2b95221f08fec807515d1" ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/stable/extensions/solstice-codex/bin"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading codex ${CODEX_VERSION} (${ASSET})..."
curl -sfL --retry 3 -o "$TMP/$ASSET" \
  "https://github.com/openai/codex/releases/download/${CODEX_VERSION}/${ASSET}"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$EXPECTED_SHA256" "$TMP/$ASSET" | sha256sum -c -
else
  ACTUAL_SHA256="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
  [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || {
    echo "sha256 mismatch for $ASSET: expected $EXPECTED_SHA256, got $ACTUAL_SHA256" >&2
    exit 1
  }
fi
tar -xzf "$TMP/$ASSET" -C "$TMP"
[ -f "$TMP/$INNER" ] || { echo "expected $INNER inside $ASSET, got:"; ls "$TMP"; exit 1; }
mv "$TMP/$INNER" "$BIN_DIR/$OUT"
chmod +x "$BIN_DIR/$OUT"
if [ "$TARGET" != "win32" ]; then
  BUNDLED_VERSION="$("$BIN_DIR/$OUT" --version | sed -n 's/^codex-cli \([0-9][0-9.]*\)$/\1/p')"
  awk -v version="$BUNDLED_VERSION" 'BEGIN {
    split(version, parts, ".")
    exit !((parts[1] + 0) > 0 || (parts[2] + 0) >= 144)
  }' || {
    echo "bundled codex does not satisfy GPT-5.6 minimum (>=0.144.0)" >&2
    exit 1
  }
fi
echo "Bundled $BIN_DIR/$OUT ($(du -h "$BIN_DIR/$OUT" | cut -f1))"
