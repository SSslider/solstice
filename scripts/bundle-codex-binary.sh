#!/usr/bin/env bash
# Download the complete pinned Codex runtime package into the solstice-codex
# built-in extension so the IDE ships with its own agent backend.
# Usage: bundle-codex-binary.sh <win32|darwin|linux>
# NOTE: must stay bash-3.2 compatible (macOS runners).
set -euo pipefail

CODEX_VERSION="rust-v0.153.3"
TARGET="${1:?usage: $0 <win32|darwin|linux>}"

case "$TARGET" in
  win32)  ASSET="codex-package-x86_64-pc-windows-msvc.tar.gz"; OUT="codex.exe"; EXPECTED_SHA256="7db4c2a12dadbf39db73dd13f058fb14e03c83133e51825b7ad7c708e40cea31" ;;
  darwin) ASSET="codex-package-aarch64-apple-darwin.tar.gz"; OUT="codex"; EXPECTED_SHA256="1101ce8b7f9aaf598120bf14ff260c5f591eaa2c611cf8738070529e60ae8105" ;;
  linux)  ASSET="codex-package-x86_64-unknown-linux-musl.tar.gz"; OUT="codex"; EXPECTED_SHA256="47bb1fb36fb1dbd5fe1af3eb0db422ffb4c3c38d9c1762c7618a9bed46c44a63" ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/stable/extensions/solstice-codex/bin"
EXT_DIR="$(dirname "$BIN_DIR")"
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
node "$(dirname "$0")/verify-codex-runtime.js" "$TMP" "$TARGET"
grep -aFq -- "gpt-6-astra" "$TMP/bin/$OUT" || {
  echo "bundled Codex binary is missing required model capability: gpt-6-astra" >&2
  exit 1
}
# Preserve the upstream layout: code-mode-host is a sibling of codex, and
# resources/path are resolved via codex-package.json in the parent directory.
# Copy only runtime files; existing bundled Grok/Node binaries remain intact.
cp -R "$TMP/bin/." "$BIN_DIR/"
cp "$TMP/codex-package.json" "$EXT_DIR/codex-package.json"
cp -R "$TMP/codex-path" "$TMP/codex-resources" "$EXT_DIR/"
chmod +x "$BIN_DIR/$OUT"
node "$(dirname "$0")/verify-codex-runtime.js" "$EXT_DIR" "$TARGET"
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
