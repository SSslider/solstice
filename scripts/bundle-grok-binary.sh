#!/usr/bin/env bash
# Bundle the @xai-official/grok engine (Composer 2.5 / Grok) into the
# solstice-codex built-in extension so the IDE ships with its OWN grok engine —
# exactly like bundle-codex-binary.sh does for GPT-5.5. Without this, switching
# to Composer/Grok on a clean install has no engine to spawn (`spawn grok EPERM`
# / "isn't installed" snap-back). The per-platform binary is ~107MB raw, so the
# upstream packages ship it brotli-compressed (~31MB); we bundle the COMPRESSED
# payload (bin/grok[.exe].br) and the extension decompresses it on first use.
# Usage: bundle-grok-binary.sh <win32|darwin|linux>
# NOTE: must stay bash-3.2 compatible (macOS runners). Node is used only to
# pull the package via `npm pack` — no decompression happens here.
set -euo pipefail

GROK_VERSION="0.2.20"
TARGET="${1:?usage: $0 <win32|darwin|linux>}"

case "$TARGET" in
  win32)  PKG="@xai-official/grok-win32-x64";   INNER="package/bin/grok.exe.br"; OUT="grok.exe.br" ;;
  darwin) PKG="@xai-official/grok-darwin-arm64"; INNER="package/bin/grok.br";     OUT="grok.br" ;;
  linux)  PKG="@xai-official/grok-linux-x64";    INNER="package/bin/grok.br";     OUT="grok.br" ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/stable/extensions/solstice-codex/bin"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching ${PKG}@${GROK_VERSION}..."
( cd "$TMP" && npm pack "${PKG}@${GROK_VERSION}" >/dev/null )
TGZ="$(ls "$TMP"/*.tgz)"
tar -xzf "$TGZ" -C "$TMP"
[ -f "$TMP/$INNER" ] || { echo "expected $INNER inside $PKG, got:"; tar -tzf "$TGZ"; exit 1; }
mv "$TMP/$INNER" "$BIN_DIR/$OUT"
echo "Bundled $BIN_DIR/$OUT ($(du -h "$BIN_DIR/$OUT" | cut -f1)) — decompressed on first run by grok.js"
