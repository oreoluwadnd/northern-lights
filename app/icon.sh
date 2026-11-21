#!/bin/sh
# Redraws the app icon (assets/icon.icns + icon.png) from icon.swift. Only needed when you change the icon.
set -e
cd "$(dirname "$0")"
mkdir -p build assets
swiftc -O icon.swift -o build/icon-gen
./build/icon-gen assets/icon.png >/dev/null
rm -rf build/icon.iconset && mkdir build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon.png --out "build/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d assets/icon.png --out "build/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o assets/icon.icns
echo "Icon updated: assets/icon.icns"
