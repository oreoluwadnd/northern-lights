#!/bin/sh
# Packages Northern Lights for Windows or Linux (run on any Mac or Linux machine):
#   PLATFORM=win32 ARCH=x64 sh package-other.sh   → dist/Northern-Lights-<v>-windows-x64.zip
#   PLATFORM=linux ARCH=x64 sh package-other.sh   → dist/Northern-Lights-<v>-linux-x64.tar.gz
# Like the Mac build, the engine is inside and runs on Electron's own Node.
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PLATFORM="${PLATFORM:?set PLATFORM=win32 or linux}"
ARCH="${ARCH:-x64}"
case "$PLATFORM" in win32) NAME=windows ;; linux) NAME=linux ;; *) echo "PLATFORM must be win32 or linux" >&2; exit 1 ;; esac

[ -d node_modules/@electron/get ] || npm install --no-audit --no-fund
VERSION=$(node -p 'require("./package.json").version')
EVERSION=$(node -p 'require("./node_modules/electron/package.json").version')

echo "Downloading Electron $EVERSION for $PLATFORM-$ARCH…"
ZIPFILE=$(node -e '
const { downloadArtifact } = require("@electron/get");
downloadArtifact({ version: process.argv[1], platform: process.argv[2], arch: process.argv[3], artifactName: "electron" })
  .then((p) => console.log(p), (e) => { console.error(e.message); process.exit(1); });
' "$EVERSION" "$PLATFORM" "$ARCH")

OUT="dist/$PLATFORM-$ARCH/Northern Lights"
rm -rf "dist/$PLATFORM-$ARCH" && mkdir -p "$OUT"
unzip -q "$ZIPFILE" -d "$OUT"
RES="$OUT/resources"
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app" "$RES/engine"
cp main.js preload.js assets/icon.png "$RES/app/"
node -e '
const pkg = require("./package.json");
require("fs").writeFileSync(process.argv[1] + "/package.json", JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: "main.js" }, null, 2));
' "$RES/app"
cp -R "$ROOT/src" "$RES/engine/src"
node -e '
const pkg = require(process.argv[2] + "/package.json");
require("fs").writeFileSync(process.argv[1] + "/package.json", JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true }, null, 2));
' "$RES/engine" "$ROOT"

COMMON='Using it
- Click + next to Projects and pick a folder with code.
- Click New mission, describe what you want roughly, press Sharpen, pick a preset, Start planning.
- Approve the plan. Agents work one task at a time; anything that needs you shows up in the Inbox.
- Budgets stop agents automatically. Ctrl+K searches everything.'

mkdir -p dist
if [ "$PLATFORM" = win32 ]; then
  mv "$OUT/electron.exe" "$OUT/Northern Lights.exe"
  cat > "$OUT/How to open.txt" <<EOF
Northern Lights — a task board where AI coding agents work missions for you.

Before you start
- Windows 10 or 11 (64-bit).
- Claude Code installed and signed in (https://claude.com/claude-code), and/or Antigravity's CLI (agy).
- Optional: agent-browser, so checkers can test web pages and attach screenshots.

Opening it
1. Unzip the whole folder somewhere permanent (e.g. Documents), not inside the zip preview.
2. Double-click "Northern Lights.exe".
3. This test build isn't code-signed, so Windows SmartScreen may warn you: click "More info", then "Run anyway".

$COMMON
EOF
  PKG="dist/Northern-Lights-$VERSION-$NAME-$ARCH.zip"
  rm -f "$PKG"
  (cd "dist/$PLATFORM-$ARCH" && zip -qr "../$(basename "$PKG")" "Northern Lights")
else
  mv "$OUT/electron" "$OUT/northern-lights"
  cat > "$OUT/How to open.txt" <<EOF
Northern Lights — a task board where AI coding agents work missions for you.

Before you start
- A 64-bit Linux desktop (Ubuntu 22.04+, Fedora 38+ or similar).
- Claude Code installed and signed in (https://claude.com/claude-code), and/or Antigravity's CLI (agy).
- Optional: agent-browser, so checkers can test web pages and attach screenshots.

Opening it
  tar -xzf Northern-Lights-$VERSION-linux-$ARCH.tar.gz
  "./Northern Lights/northern-lights"

If it exits with a message about the "SUID sandbox" (common on Ubuntu 24.04), either run
  sudo chown root "Northern Lights/chrome-sandbox" && sudo chmod 4755 "Northern Lights/chrome-sandbox"
or start it with: "./Northern Lights/northern-lights" --no-sandbox

$COMMON
EOF
  PKG="dist/Northern-Lights-$VERSION-$NAME-$ARCH.tar.gz"
  rm -f "$PKG"
  COPYFILE_DISABLE=1 tar -czf "$PKG" -C "dist/$PLATFORM-$ARCH" "Northern Lights"
fi
echo "Ready: $(cd dist && pwd)/$(basename "$PKG") ($(du -h "$PKG" | cut -f1))"
