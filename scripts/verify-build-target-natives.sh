#!/usr/bin/env bash
# verify-build-target-natives.sh
#
# Verify every .node native module in a cross-compiled Electron/VSCode build
# matches the target architecture. Catches the Linux-ELF-inside-PE.exe trap.
#
# Usage:
#   verify-build-target-natives.sh <output-dir> <target>
# Targets:
#   win32       → expects PE32+
#   darwin      → expects Mach-O
#   linux       → expects ELF
#
# Exits non-zero if any .node mismatches target.
# Bails verbose so the failure is obvious in CI logs.

set -euo pipefail

OUT_DIR="${1:-}"
TARGET="${2:-}"

if [ -z "$OUT_DIR" ] || [ -z "$TARGET" ]; then
  echo "usage: $0 <output-dir> <win32|darwin|linux>" >&2
  exit 2
fi
if [ ! -d "$OUT_DIR" ]; then
  echo "ERROR: output dir does not exist: $OUT_DIR" >&2
  exit 2
fi

case "$TARGET" in
  win32)  EXPECTED="PE32" ;;
  darwin) EXPECTED="Mach-O" ;;
  linux)  EXPECTED="ELF" ;;
  *)      echo "ERROR: unknown target '$TARGET' (use win32|darwin|linux)" >&2; exit 2 ;;
esac

# Find every .node file in the build.
# NOTE: no mapfile/arrays — macOS ships bash 3.2; keep this POSIX-ish.
TOTAL=0
MISMATCH=0
while IFS= read -r f; do
  TOTAL=$((TOTAL+1))
  FT=$(file -b "$f")
  if echo "$FT" | grep -q "$EXPECTED"; then
    : # ok
  else
    echo "MISMATCH: $f"
    echo "  expected: $EXPECTED"
    echo "  got:      $FT"
    MISMATCH=$((MISMATCH+1))
  fi
done < <(find "$OUT_DIR" -name '*.node' -type f 2>/dev/null)

if [ "$TOTAL" -eq 0 ]; then
  echo "WARN: no .node files found in $OUT_DIR — verify the path"
  exit 0
fi

if [ "$MISMATCH" -gt 0 ]; then
  echo ""
  echo "FAIL: $MISMATCH/$TOTAL .node files do NOT match target $TARGET."
  echo "This build will NOT launch on the target OS."
  echo "Root cause: cross-compiling native modules on Linux doesn't rebuild .node files for the target."
  echo "Fix: build on the target OS itself (or run electron-rebuild with correct --target_platform/--target_arch)."
  exit 1
fi

echo "PASS: all $TOTAL .node files match target $TARGET ($EXPECTED)."
