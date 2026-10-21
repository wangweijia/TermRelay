#!/usr/bin/env bash
set -euo pipefail
repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
root="$repo/apps/linux"
output="$repo/dist/termrelay-linux"
if [ "$(uname -s)" != Linux ]; then
  echo "Build the Debian release on the matching Linux architecture (Ubuntu 22.04+)." >&2
  exit 1
fi
arch="$(dpkg --print-architecture)"
case "$arch" in amd64|arm64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
node_arch="$(node -p process.arch)"
if { [ "$arch" = amd64 ] && [ "$node_arch" != x64 ]; } || { [ "$arch" = arm64 ] && [ "$node_arch" != arm64 ]; }; then
  echo "Build host and Node architecture must match." >&2
  exit 1
fi
cd "$repo"
pnpm --filter @termrelay/linux build
version="$(node -p "require('./apps/linux/package.json').version")"
stage="$(mktemp -d)"
trap 'rm -r "$stage"' EXIT
mkdir -p "$output" "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/lib/systemd/user" "$stage/usr/lib/termrelay-linux"
node "$repo/scripts/stage-linux-release.cjs" "$stage/usr/lib/termrelay-linux/release"
ldd "$stage/usr/lib/termrelay-linux/release/runtime/bin/node" > "$stage/node-libraries"
if grep -Eq 'not found|libnode|libssl|libcrypto|libicu' "$stage/node-libraries"; then
  echo "Use the official Node distribution with bundled Node/OpenSSL/ICU dependencies." >&2
  cat "$stage/node-libraries" >&2
  exit 1
fi
rm "$stage/node-libraries"
cat > "$stage/DEBIAN/control" <<EOF
Package: termrelay-linux
Version: $version
Section: utils
Priority: optional
Architecture: $arch
Maintainer: TermRelay Contributors
Depends: libc6 (>= 2.35), libstdc++6, libgcc-s1
Description: TypeScript headless TermRelay agent with a private Node runtime
 CLI-managed Codex structured sessions and PTY sessions. No system Node or Python required.
EOF
install -m 755 "$root/packaging/termrelay-linux" "$stage/usr/bin/termrelay-linux"
install -m 755 "$root/packaging/termrelay-linux" "$stage/usr/bin/termrelay-agent"
install -m 644 "$root/packaging/termrelay-agent.service" "$stage/usr/lib/systemd/user/"
dpkg-deb --root-owner-group --build "$stage" "$output/termrelay-linux_${version}_${arch}.deb"
