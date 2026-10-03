#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cargo build --manifest-path "$ROOT/desktop/Cargo.toml" --release --locked
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Built $ROOT/desktop/target/release/streamarena-music"
  exit 0
fi
APP="$ROOT/desktop/dist/Spotify.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/desktop/target/release/streamarena-music" "$APP/Contents/MacOS/streamarena-music"
cp "$ROOT/desktop/packaging/macos/streamarena.icns" "$APP/Contents/Resources/Music.icns"
cp "$ROOT/desktop/LICENSE" "$APP/Contents/Resources/Spotifast-LICENSE.txt"
cp "$ROOT/desktop/Lofty-LICENSE.txt" "$APP/Contents/Resources/Lofty-LICENSE.txt"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Spotify</string>
<key>CFBundleDisplayName</key><string>Spotify</string>
<key>CFBundleIdentifier</key><string>xyz.streamarena.music.desktop</string>
<key>CFBundleExecutable</key><string>streamarena-music</string>
<key>CFBundleIconFile</key><string>Music</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.music</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>Based on Spotifast, copyright 2026 Carmine Paolino, MIT License. StreamArena integration.</string>
</dict></plist>
PLIST
# Keep the app's identity stable across builds so Keychain approvals survive
# updates. Never silently fall back to an ad-hoc, build-specific identity.
SIGNING_IDENTITY="${SPOTIFY_CODESIGN_IDENTITY:-Developer ID Application: Erlin Hoxha (T29NU9NCA2)}"
if [[ "$SIGNING_IDENTITY" == "-" ]]; then
  echo "Spotify requires a persistent signing identity for Keychain access." >&2
  exit 1
fi
codesign --force --sign "$SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $APP"
