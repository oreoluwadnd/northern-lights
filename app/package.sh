#!/bin/sh
# Makes a self-contained "Northern Lights.app" you can send to someone, zipped in app/dist/.
# The engine is copied inside the app and runs on Electron's built-in Node, so the recipient
# needs no Node, no terminal and no setup. They do need Claude Code or Antigravity installed.
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# ARCH=arm64 (Apple Silicon) or ARCH=x86_64 (Intel). Defaults to this Mac's.
ARCH="${ARCH:-$(uname -m)}"
case "$ARCH" in arm64) EARCH=arm64 ;; x86_64) EARCH=x64 ;; *) echo "Unknown ARCH $ARCH" >&2; exit 1 ;; esac

[ -d node_modules/electron ] || npm install --no-audit --no-fund
# Make sure node_modules/electron/dist holds Electron for the requested architecture.
DIST=node_modules/electron/dist
HAVE=$(lipo -archs "$DIST/Electron.app/Contents/MacOS/Electron" 2>/dev/null || true)
if [ "$HAVE" != "$ARCH" ]; then
  echo "Downloading Electron for $ARCH…"
  rm -rf "$DIST" node_modules/electron/path.txt
  npm_config_arch=$EARCH node node_modules/electron/install.js
fi
[ -f assets/icon.icns ] || sh icon.sh

VERSION=$(node -p 'require("./package.json").version')
OUT="dist/$ARCH/Northern Lights"
APP="$OUT/Northern Lights.app"
rm -rf "$OUT" && mkdir -p "$OUT"
echo "Assembling the shareable app…"
cp -Rc node_modules/electron/dist/Electron.app "$APP" 2>/dev/null || cp -R node_modules/electron/dist/Electron.app "$APP"
RES="$APP/Contents/Resources"
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app" "$RES/engine"
cp main.js preload.js "$RES/app/"
node -e '
const pkg = require("./package.json");
require("fs").writeFileSync(process.argv[1] + "/package.json", JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: "main.js" }, null, 2));
' "$RES/app"
# The engine: source only (no tests, no dev tooling). Node runs the TypeScript directly.
cp -R "$ROOT/src" "$RES/engine/src"
node -e '
const pkg = require(process.argv[2] + "/package.json");
require("fs").writeFileSync(process.argv[1] + "/package.json", JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true }, null, 2));
' "$RES/engine" "$ROOT"
cp assets/icon.icns "$RES/electron.icns"

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Northern Lights" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Northern Lights" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Northern Lights" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier dev.northernlights.app" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.developer-tools" "$PLIST" 2>/dev/null || true
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true

cat > "$OUT/How to open.txt" <<'EOF'
Northern Lights — a task board where AI coding agents work missions for you.

Before you start
- A Mac with macOS 12 or newer. Use the arm64 download on Apple Silicon (M1 and newer), x86_64 on Intel Macs.
- Claude Code installed and signed in (https://claude.com/claude-code), and/or Antigravity's CLI (agy).
- Optional: agent-browser, so checkers can test web pages and attach screenshots.

Opening it the first time
This test build isn't notarized by Apple, so macOS blocks the first open:
1. Drag "Northern Lights" into Applications.
2. Open it. When macOS says it can't verify the app, click Done.
3. Open System Settings → Privacy & Security, scroll down, and click "Open Anyway" next to Northern Lights.
(Or, in Terminal: xattr -dr com.apple.quarantine "/Applications/Northern Lights.app")

Using it
- Click + next to Projects and pick a folder with code.
- Click New mission, describe what you want roughly, press Sharpen, pick a preset, Start planning.
- Approve the plan. Agents work one task at a time; anything that needs you shows up in the Inbox.
- Budgets stop agents automatically. ⌘K searches everything.
EOF

mkdir -p dist
ZIP="dist/Northern-Lights-$VERSION-macOS-$ARCH.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$OUT" "$ZIP"
echo "Ready to send: $(cd dist && pwd)/$(basename "$ZIP") ($(du -h "$ZIP" | cut -f1))"
