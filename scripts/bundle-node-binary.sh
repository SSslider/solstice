#!/usr/bin/env bash
# Download the official, code-SIGNED Node.js runtime into the solstice-codex
# built-in extension's bin/ dir, next to codex.exe.
#
# WHY THIS EXISTS: to launch the grok/Composer engine (an npm .cmd shim) without
# the `spawn EPERM` Defender block, winspawn must run the shim's cli.js with a
# real Node binary. When the user has no standalone node on PATH, the only
# fallback was re-launching Solstice.exe itself with ELECTRON_RUN_AS_NODE — an
# UNSIGNED app spawning itself HIDDEN, which Windows Defender flags as malware
# and blocks (surfacing as a bare `spawn EPERM`, plus a Defender alert). The
# official node.exe is signed by the OpenJS Foundation, so Defender trusts it and
# the engine launches cleanly. winspawn.js prefers this bundled node first.
#
# Usage: bundle-node-binary.sh <win32|darwin|linux>
# Only win32 actually needs it (resolveWinSpawn is a no-op on *nix); the other
# targets are accepted as harmless no-ops so the CI matrix can call it uniformly.
# NOTE: must stay bash-3.2 compatible (macOS runners).
set -euo pipefail

# Match .nvmrc so the bundled runtime is the same Node the build/CLI expect.
NODE_VERSION="v22.22.1"
TARGET="${1:?usage: $0 <win32|darwin|linux>}"

if [ "$TARGET" != "win32" ]; then
  echo "bundle-node-binary: $TARGET needs no bundled node (winspawn is *nix no-op); skipping."
  exit 0
fi

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/stable/extensions/solstice-codex/bin"
mkdir -p "$BIN_DIR"

URL="https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe"
echo "Downloading signed Node ${NODE_VERSION} (win-x64) from ${URL}..."
curl -sfL --retry 3 -o "$BIN_DIR/node.exe" "$URL"
[ -s "$BIN_DIR/node.exe" ] || { echo "node.exe download failed / empty" >&2; exit 1; }
echo "Bundled $BIN_DIR/node.exe ($(du -h "$BIN_DIR/node.exe" | cut -f1))"
