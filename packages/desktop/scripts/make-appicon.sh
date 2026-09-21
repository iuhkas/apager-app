#!/usr/bin/env bash
# Erzeugt resources/icon.icns aus resources/icon.png (nur macOS, braucht sips/iconutil).
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=resources/icon.png
SET=$(mktemp -d)/icon.iconset
mkdir -p "$SET"

for size in 16 32 128 256 512; do
  sips -z $size $size "$SRC" --out "$SET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$SRC" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$SET" -o resources/icon.icns
echo "resources/icon.icns geschrieben"
