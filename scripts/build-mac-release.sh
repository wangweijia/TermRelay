#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
package_dir="$repo_root/apps/mac"
product_name="TermRelay"
bundle_id="com.termrelay.mac"
version="0.1.0"
build_number="$(date -u +%Y%m%d%H%M)"
output_dir="$repo_root/dist/termrelay-mac"
run_tests=false
allow_dirty=false

usage() {
  cat <<'EOF'
Usage: scripts/build-mac-release.sh [options]

Builds the macOS app in Release mode, creates a standard .app bundle, applies
an ad-hoc signature, and packages both ZIP and DMG artifacts.

Options:
  --version VERSION       Marketing version, such as 0.1.0 (default: 0.1.0)
  --build-number NUMBER   Numeric build number (default: UTC timestamp)
  --bundle-id ID          Bundle identifier (default: com.termrelay.mac)
  --output-dir PATH       Artifact directory (default: dist/termrelay-mac)
  --run-tests             Run swift test before the Release build (requires XCTest)
  --allow-dirty           Allow packaging uncommitted workspace changes
  -h, --help              Show this help

Examples:
  scripts/build-mac-release.sh --version 0.1.0
  scripts/build-mac-release.sh --version 0.1.0 --allow-dirty

If GitHub access requires the local proxy, export it before running:
  export HTTPS_PROXY=http://127.0.0.1:7890
  export HTTP_PROXY=http://127.0.0.1:7890
  export ALL_PROXY=socks5h://127.0.0.1:7890
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "--version requires a value" >&2; exit 2; }
      version="$2"
      shift 2
      ;;
    --build-number)
      [ "$#" -ge 2 ] || { echo "--build-number requires a value" >&2; exit 2; }
      build_number="$2"
      shift 2
      ;;
    --bundle-id)
      [ "$#" -ge 2 ] || { echo "--bundle-id requires a value" >&2; exit 2; }
      bundle_id="$2"
      shift 2
      ;;
    --output-dir)
      [ "$#" -ge 2 ] || { echo "--output-dir requires a path" >&2; exit 2; }
      output_dir="$2"
      shift 2
      ;;
    --run-tests)
      run_tests=true
      shift
      ;;
    --allow-dirty)
      allow_dirty=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$version" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "Invalid version: $version (expected a numeric version such as 0.1.0)" >&2
  exit 2
fi
if [[ ! "$build_number" =~ ^[0-9]+$ ]]; then
  echo "Invalid build number: $build_number (digits only)" >&2
  exit 2
fi
if [[ ! "$bundle_id" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+$ ]]; then
  echo "Invalid bundle identifier: $bundle_id" >&2
  exit 2
fi
case "$output_dir" in
  /*) ;;
  *) output_dir="$repo_root/$output_dir" ;;
esac

for command in codesign ditto git hdiutil iconutil plutil shasum sips swift xattr; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

if [ "$allow_dirty" = false ] && [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
  echo "Workspace has uncommitted changes. Commit them or pass --allow-dirty." >&2
  exit 1
fi

if [ "$run_tests" = true ]; then
  echo "Running macOS tests ..."
  swift test --package-path "$package_dir" --disable-sandbox
fi

echo "Building $product_name in Release mode ..."
swift build --package-path "$package_dir" -c release --disable-sandbox
bin_dir="$(swift build --package-path "$package_dir" -c release --show-bin-path --disable-sandbox)"
executable="$bin_dir/$product_name"
[ -x "$executable" ] || { echo "Release executable not found: $executable" >&2; exit 1; }

architecture="$(uname -m)"
release_name="$product_name-$version-$architecture"
mkdir -p "$output_dir"
release_tmp="$(mktemp -d "${TMPDIR:-/tmp}/termrelay-mac-release.XXXXXX")"
trap 'rm -rf "$release_tmp"' EXIT

app_path="$release_tmp/$product_name.app"
contents_dir="$app_path/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
mkdir -p "$macos_dir" "$resources_dir"
install -m 755 "$executable" "$macos_dir/$product_name"

# SwiftPM dependencies may emit resource bundles beside the executable.
while IFS= read -r -d '' resource_bundle; do
  ditto "$resource_bundle" "$resources_dir/$(basename "$resource_bundle")"
done < <(find "$bin_dir" -maxdepth 1 -type d -name '*.bundle' -print0)

icon_master="$repo_root/TermRelay-AppIcon/TermRelay-AppIcon-1024.png"
[ -f "$icon_master" ] || { echo "App icon master not found: $icon_master" >&2; exit 1; }
iconset_dir="$release_tmp/$product_name.iconset"
mkdir -p "$iconset_dir"
for icon_size in 16 32 128 256 512; do
  retina_size=$((icon_size * 2))
  sips -z "$icon_size" "$icon_size" "$icon_master" \
    --out "$iconset_dir/icon_${icon_size}x${icon_size}.png" >/dev/null
  sips -z "$retina_size" "$retina_size" "$icon_master" \
    --out "$iconset_dir/icon_${icon_size}x${icon_size}@2x.png" >/dev/null
done
iconutil --convert icns --output "$resources_dir/$product_name.icns" "$iconset_dir"

info_plist="$contents_dir/Info.plist"
plutil -create xml1 "$info_plist"
plutil -insert CFBundleDevelopmentRegion -string en "$info_plist"
plutil -insert CFBundleDisplayName -string "$product_name" "$info_plist"
plutil -insert CFBundleExecutable -string "$product_name" "$info_plist"
plutil -insert CFBundleIdentifier -string "$bundle_id" "$info_plist"
plutil -insert CFBundleIconFile -string "$product_name.icns" "$info_plist"
plutil -insert CFBundleInfoDictionaryVersion -string 6.0 "$info_plist"
plutil -insert CFBundleName -string "$product_name" "$info_plist"
plutil -insert CFBundlePackageType -string APPL "$info_plist"
plutil -insert CFBundleShortVersionString -string "$version" "$info_plist"
plutil -insert CFBundleVersion -string "$build_number" "$info_plist"
plutil -insert LSApplicationCategoryType -string public.app-category.developer-tools "$info_plist"
plutil -insert LSMinimumSystemVersion -string 14.0 "$info_plist"
plutil -insert NSHighResolutionCapable -bool YES "$info_plist"
plutil -insert NSPrincipalClass -string NSApplication "$info_plist"

# Remove inherited quarantine metadata before signing. A browser/download tool
# may add quarantine again on the user's Mac, which is handled by manual trust.
chmod -R u+w "$app_path"
xattr -cr "$app_path"

echo "Applying ad-hoc signature ..."
codesign --force --deep --options runtime --sign - --timestamp=none "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"

zip_path="$output_dir/$release_name.zip"
dmg_path="$output_dir/$release_name.dmg"
checksum_path="$output_dir/$release_name.sha256"

rm -f "$zip_path" "$dmg_path" "$checksum_path"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$zip_path"

dmg_staging="$release_tmp/dmg"
mkdir -p "$dmg_staging"
ditto "$app_path" "$dmg_staging/$product_name.app"
ln -s /Applications "$dmg_staging/Applications"
hdiutil create \
  -volname "$product_name" \
  -srcfolder "$dmg_staging" \
  -format UDZO \
  -ov \
  "$dmg_path" >/dev/null

(
  cd "$output_dir"
  shasum -a 256 "$(basename "$zip_path")" "$(basename "$dmg_path")" > "$(basename "$checksum_path")"
)

echo
echo "macOS release created:"
echo "  $zip_path"
echo "  $dmg_path"
echo "  $checksum_path"
echo
echo "Signature: ad-hoc (not notarized)"
echo "First launch on another Mac:"
echo "  1. Move $product_name.app to Applications."
echo "  2. Control-click the app, choose Open, then confirm Open."
echo "  3. If macOS still blocks it, use System Settings > Privacy & Security > Open Anyway."
