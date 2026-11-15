#!/usr/bin/env bash
set -euo pipefail

configuration="$1"
jobs="$2"
cmake --preset cp0-container -DFETCHCONTENT_SOURCE_DIR_LVGL=/opt/lvgl
cmake --build build/cp0-container --config "$configuration" --parallel "$jobs"
ctest --test-dir build/cp0-container -C "$configuration" --output-on-failure
file "build/cp0-container/$configuration/termrelay-cardputerzero"
sha256sum "build/cp0-container/$configuration/termrelay-cardputerzero"
