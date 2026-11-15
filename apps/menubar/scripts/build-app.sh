#!/bin/bash
# Commander.app (menu-bar) yig'ish: swift build -c release -> .app bundle -> ad-hoc imzo.
# Foydalanish: apps/menubar/scripts/build-app.sh [--install]   (--install: /Applications ga nusxa)
# Natija: apps/menubar/build/Commander.app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${COMMANDER_MENUBAR_VERSION:-0.1.0}"
BUILD_NUMBER="${COMMANDER_MENUBAR_BUILD:-$(date +%Y%m%d%H%M)}"
BUNDLE_ID="uz.commander.menubar"
OUT="$ROOT/build"
APP="$OUT/Commander.app"

echo "==> swift build -c release"
swift build -c release --product CommanderMenuBar
BIN="$(swift build -c release --show-bin-path)/CommanderMenuBar"
[ -x "$BIN" ] || { echo "binary topilmadi: $BIN" >&2; exit 1; }

echo "==> bundle: $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Commander"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>uz</string>
  <key>CFBundleExecutable</key><string>Commander</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Commander</string>
  <key>CFBundleDisplayName</key><string>Commander</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHumanReadableCopyright</key><string>Commander</string>
  <!-- Dashboard oynasi (WKWebView) lokal http://127.0.0.1:4318 ni ochadi: faqat lokal tarmoq istisnosi. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>${BUNDLE_ID}.pair</string>
      <key>CFBundleURLSchemes</key><array><string>commander</string></array>
      <key>CFBundleTypeRole</key><string>Viewer</string>
    </dict>
  </array>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> ad-hoc imzo"
codesign --force --sign - --options runtime --timestamp=none \
  --identifier "$BUNDLE_ID" "$APP"
codesign --verify --strict --verbose=1 "$APP"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

if [ "${1:-}" = "--install" ]; then
  echo "==> /Applications/Commander.app"
  pkill -x Commander 2>/dev/null || true
  rm -rf /Applications/Commander.app
  cp -R "$APP" /Applications/
  # URL sxemasini (commander://) LaunchServices'da ro'yxatdan o'tkazish.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Commander.app || true
  echo "O'rnatildi: open /Applications/Commander.app"
else
  echo "Tayyor: $APP  (o'rnatish: $0 --install)"
fi
