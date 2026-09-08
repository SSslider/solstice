#!/usr/bin/env bash
# Download the pinned codex CLI release binary into the solstice-codex
# built-in extension so the IDE ships with its own agent backend.
# Usage: bundle-codex-binary.sh <win32|darwin|linux>
# NOTE: must stay bash-3.2 compatible (macOS runners).
set -euo pipefail

CODEX_VERSION="rust-v0.153.3"
TARGET="${1:?usage: $0 <win32|darwin|linux>}"

case "$TARGET" in
  win32)  ASSET="codex-x86_64-pc-windows-msvc.exe.tar.gz"; INNER="codex-x86_64-pc-windows-msvc.exe"; OUT="codex.exe"; EXPECTED_SHA256="d0719dc2ab6f51510dc208633e9577fd03f50f0c00ac384fe9e0a069fd6c387b" ;;
  darwin) ASSET="codex-aarch64-apple-darwin.tar.gz";       INNER="codex-aarch64-apple-darwin";       OUT="codex";     EXPECTED_SHA256="02cdcbd874c1616f2cab6f602580329de1b00b26bf216d384b348519a9b356cd" ;;
  linux)  ASSET="codex-x86_64-unknown-linux-musl.tar.gz";  INNER="codex-x86_64-unknown-linux-musl";  OUT="codex";     EXPECTED_SHA256="6ff9674bb00e14734c2748bc8788eab3cb6e5ac53ebde7e1e780b4ed7af48cba" ;;
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
grep -aFq -- "gpt-6-astra" "$TMP/$INNER" || {
  echo "bundled Codex binary is missing required model capability: gpt-6-astra" >&2
  exit 1
}
mv "$TMP/$INNER" "$BIN_DIR/$OUT"
chmod +x "$BIN_DIR/$OUT"
if [ "$TARGET" != "win32" ]; then
  BUNDLED_VERSION="$("$BIN_DIR/$OUT" --version | sed -n 's/^codex-cli \([0-9][0-9.]*\)$/\1/p')"
  awk -v version="$BUNDLED_VERSION" 'BEGIN {
    split(version, parts, ".")
    exit !((parts[1] + 0) > 0 || (parts[2] + 0) >= 153)
  }' || {
    echo "bundled codex does not satisfy GPT-6 minimum (>=0.153.0)" >&2
    exit 1
  }
fi
echo "Bundled $BIN_DIR/$OUT ($(du -h "$BIN_DIR/$OUT" | cut -f1))"
