#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
out="$root/dist"
stage="$(mktemp -d)"
trap 'rm -r "$stage"' EXIT
mkdir -p "$out" "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/lib/termrelay-linux/termrelay" "$stage/usr/share/applications"
cat > "$stage/DEBIAN/control" <<'EOF'
Package: termrelay-linux
Version: 0.1.0
Section: utils
Priority: optional
Architecture: all
Maintainer: TermRelay Contributors
Depends: python3 (>= 3.10), python3-gi, gir1.2-gtk-3.0, gir1.2-vte-2.91, python3-websocket
Description: Independent TermRelay desktop client for Ubuntu and Xubuntu
 Local PTY terminals with remote access through a TermRelay relay server.
EOF
install -m 755 "$root/packaging/termrelay-linux" "$stage/usr/bin/termrelay-linux"
install -m 644 "$root/packaging/termrelay-linux.desktop" "$stage/usr/share/applications/"
install -m 644 "$root"/termrelay/*.py "$stage/usr/lib/termrelay-linux/termrelay/"
dpkg-deb --root-owner-group --build "$stage" "$out/termrelay-linux_0.1.0_all.deb"
