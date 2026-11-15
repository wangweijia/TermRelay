#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
configuration="${1:-RelWithDebInfo}"
jobs="${CARDPUTER_BUILD_JOBS:-4}"
image="termrelay-cardputerzero-builder:debian13-lvgl9.5.0"

case "$configuration" in
    Debug|Release|RelWithDebInfo) ;;
    *) echo 'Usage: build-arm64-container.sh [Debug|Release|RelWithDebInfo]' >&2; exit 2 ;;
esac
if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
    echo 'CARDPUTER_BUILD_JOBS must be a positive integer' >&2
    exit 2
fi

build_options=(--platform linux/arm64 --tag "$image")
if [[ -n "${CARDPUTER_DEBIAN_MIRROR:-}" ]]; then
    build_options+=(--build-arg "DEBIAN_MIRROR=$CARDPUTER_DEBIAN_MIRROR")
fi
docker build "${build_options[@]}" "$app_dir/scripts/container"
# Dependencies are in the image; compilation and tests need no network or
# device credentials. The ignored build directory survives container removal.
docker run --rm --platform linux/arm64 --network none \
    --mount "type=bind,src=$app_dir,dst=/workspace" \
    "$image" bash /workspace/scripts/build-arm64-inner.sh "$configuration" "$jobs"
