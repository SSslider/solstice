#!/usr/bin/env bash
# Download the pinned codex CLI release binary into the solstice-codex
# built-in extension so the IDE ships with its own agent backend.
# Usage: bundle-codex-binary.sh <win32|darwin|linux>
# NOTE: must stay bash-3.2 compatible (macOS runners).
set -euo pipefail

CODEX_VERSION="rust-v0.137.0"
TARGET="${1:?usage: $0 <win32|darwin|linux>}"

case "$TARGET" in
  win32)  ASSET="codex-x86_64-pc-windows-msvc.exe.tar.gz"; INNER="codex-x86_64-pc-windows-msvc.exe"; OUT="codex.exe" ;;
  darwin) ASSET="codex-aarch64-apple-darwin.tar.gz";       INNER="codex-aarch64-apple-darwin";       OUT="codex" ;;
  linux)  ASSET="codex-x86_64-unknown-linux-musl.tar.gz";  INNER="codex-x86_64-unknown-linux-musl";  OUT="codex" ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/stable/extensions/solstice-codex/bin"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading codex ${CODEX_VERSION} (${ASSET})..."
curl -sfL --retry 3 -o "$TMP/$ASSET" \
  "https://github.com/openai/codex/releases/download/${CODEX_VERSION}/${ASSET}"
tar -xzf "$TMP/$ASSET" -C "$TMP"
[ -f "$TMP/$INNER" ] || { echo "expected $INNER inside $ASSET, got:"; ls "$TMP"; exit 1; }
mv "$TMP/$INNER" "$BIN_DIR/$OUT"
chmod +x "$BIN_DIR/$OUT"
echo "Bundled $BIN_DIR/$OUT ($(du -h "$BIN_DIR/$OUT" | cut -f1))"
