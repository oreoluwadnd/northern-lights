#!/bin/sh
# Builds "Northern Lights.app" from the Electron runtime and installs it in ~/Applications.
# The app runs the engine from this checkout, so rebuild if you move the folder.
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

[ -d node_modules/electron ] || npm install --no-audit --no-fund
# Electron for this Mac's architecture (package.sh may have left the other one here).
ARCH=$(uname -m)
HAVE=$(lipo -archs node_modules/electron/dist/Electron.app/Contents/MacOS/Electron 2>/dev/null || true)
if [ "$HAVE" != "$ARCH" ]; then
  rm -rf node_modules/electron/dist node_modules/electron/path.txt
  npm_config_arch=$([ "$ARCH" = x86_64 ] && echo x64 || echo arm64) node node_modules/electron/install.js
fi

mkdir -p build
[ -f assets/icon.icns ] || sh icon.sh

APP="build/Northern Lights.app"
echo "Assembling $APP…"
rm -rf "$APP"
# APFS clone where possible, so the copy takes no extra disk space.
cp -Rc node_modules/electron/dist/Electron.app "$APP" 2>/dev/null || cp -R node_modules/electron/dist/Electron.app "$APP"
RES="$APP/Contents/Resources"
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app"
cp main.js preload.js "$RES/app/"
node -e '
const fs = require("fs");
const pkg = require("./package.json");
fs.writeFileSync(process.argv[1] + "/package.json", JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: "main.js" }, null, 2));
fs.writeFileSync(process.argv[1] + "/nl-path.json", JSON.stringify({ root: process.argv[2] }));
' "$RES/app" "$ROOT"
cp assets/icon.icns "$RES/electron.icns"

PLIST="$APP/Contents/Info.plist"
VERSION=$(node -p 'require("./package.json").version')
/usr/libexec/PlistBuddy -c "Set :CFBundleName Northern Lights" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Northern Lights" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Northern Lights" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier dev.northernlights.app" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.developer-tools" "$PLIST" 2>/dev/null || true

echo "Signing (ad-hoc)…"
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true

DEST="$HOME/Applications/Northern Lights.app"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -Rc "$APP" "$DEST" 2>/dev/null || cp -R "$APP" "$DEST"
touch "$DEST"
echo "Installed: $DEST"
