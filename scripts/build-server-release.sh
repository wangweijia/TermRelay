#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
version="$(git -C "$repo_root" rev-parse --short HEAD)"
platform="linux/arm64"
output_dir="$repo_root/dist/termrelay-server"
env_file="$repo_root/deploy/server/.env.production"
run_checks=true
allow_dirty=false

usage() {
  cat <<'EOF'
Usage: scripts/build-server-release.sh [options]

Options:
  --version VERSION     Image/release version (default: current Git SHA)
  --platform PLATFORM   Docker platform (default: linux/arm64 for Jetson)
  --output-dir PATH     Artifact directory (default: dist/termrelay-server)
  --env-file PATH       Production configuration to embed (default: deploy/server/.env.production)
  --skip-check          Skip pnpm check before building
  --allow-dirty         Allow packaging uncommitted workspace changes
  -h, --help            Show this help

Output:
  termrelay-server-VERSION-linux-arm64.tar.gz
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "--version requires a value" >&2; exit 2; }
      version="$2"
      shift 2
      ;;
    --platform)
      [ "$#" -ge 2 ] || { echo "--platform requires a value" >&2; exit 2; }
      platform="$2"
      shift 2
      ;;
    --output-dir)
      [ "$#" -ge 2 ] || { echo "--output-dir requires a path" >&2; exit 2; }
      output_dir="$2"
      shift 2
      ;;
    --env-file)
      [ "$#" -ge 2 ] || { echo "--env-file requires a path" >&2; exit 2; }
      env_file="$2"
      shift 2
      ;;
    --skip-check)
      run_checks=false
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

case "$version" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid version: $version" >&2; exit 2 ;;
esac
case "$platform" in
  */*) ;;
  *) echo "Invalid Docker platform: $platform" >&2; exit 2 ;;
esac
case "$output_dir" in
  /*) ;;
  *) output_dir="$repo_root/$output_dir" ;;
esac
case "$env_file" in
  /*) ;;
  *) env_file="$repo_root/$env_file" ;;
esac

[ -f "$env_file" ] || {
  echo "Production configuration is missing: $env_file" >&2
  echo "Create it from deploy/server/.env.production.example before building." >&2
  exit 2
}
for required_key in DB_HOST DB_NAME DB_USER DB_PASSWORD DB_MIGRATION_USER DB_MIGRATION_PASSWORD SERVER_BIND_ADDRESS SERVER_PORT; do
  grep -Eq "^${required_key}=.+" "$env_file" || {
    echo "Production configuration is missing $required_key: $env_file" >&2
    exit 2
  }
done
if grep -Eq '^(DB_PASSWORD|DB_MIGRATION_PASSWORD)=replace-' "$env_file"; then
  echo "Production configuration still contains password placeholders: $env_file" >&2
  exit 2
fi

for command in docker git gzip tar shasum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done
docker buildx version >/dev/null 2>&1 || {
  echo "Docker Buildx is required." >&2
  exit 1
}

if [ "$allow_dirty" = false ] && [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
  echo "Workspace has uncommitted changes. Commit them or pass --allow-dirty." >&2
  exit 1
fi

if [ "$run_checks" = true ]; then
  command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required for checks." >&2; exit 1; }
  (cd "$repo_root" && pnpm check)
  (cd "$repo_root" && pnpm --filter @termrelay/server test)
fi

platform_slug="$(printf '%s' "$platform" | tr '/' '-')"
image="termrelay/server:$version"
archive_name="termrelay-server-$version-$platform_slug.tar.gz"
mkdir -p "$output_dir"
release_tmp="$(mktemp -d "${TMPDIR:-/tmp}/termrelay-release.XXXXXX")"
payload_dir="$release_tmp/termrelay-server-$version"
trap 'rm -rf "$release_tmp"' EXIT
mkdir -p "$payload_dir"

echo "Building $image for $platform ..."
docker buildx build \
  --platform "$platform" \
  --file "$repo_root/deploy/server/Dockerfile" \
  --tag "$image" \
  --provenance=false \
  --load \
  "$repo_root"

echo "Exporting Docker image ..."
docker save "$image" | gzip -9 > "$payload_dir/image.tar.gz"
cp "$repo_root/deploy/server/compose.release.yaml" "$payload_dir/compose.yaml"
cp "$repo_root/deploy/server/release.env.example" "$payload_dir/.env.production.example"
install -m 600 "$env_file" "$payload_dir/.env.production"
cp "$repo_root/deploy/server/deploy-release.sh" "$payload_dir/deploy.sh"
chmod 755 "$payload_dir/deploy.sh"

cat > "$payload_dir/manifest.env" <<EOF
TERMRELAY_IMAGE=$image
TERMRELAY_VERSION=$version
TERMRELAY_PLATFORM=$platform
TERMRELAY_GIT_COMMIT=$(git -C "$repo_root" rev-parse HEAD)
TERMRELAY_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

(cd "$release_tmp" && tar -czf "$output_dir/$archive_name" "termrelay-server-$version")
checksum="$(shasum -a 256 "$output_dir/$archive_name" | awk '{print $1}')"
printf '%s  %s\n' "$checksum" "$archive_name" > "$output_dir/$archive_name.sha256"

# Keep the last known-good release until the replacement and its checksum have
# both been created successfully, then remove every older Server artifact.
for old_artifact in \
  "$output_dir"/termrelay-server-*.tar.gz \
  "$output_dir"/termrelay-server-*.tar.gz.sha256; do
  [ -e "$old_artifact" ] || continue
  case "$old_artifact" in
    "$output_dir/$archive_name"|"$output_dir/$archive_name.sha256") continue ;;
  esac
  rm -f -- "$old_artifact"
done

echo
echo "Release created:"
echo "  $output_dir/$archive_name"
echo "  $output_dir/$archive_name.sha256"
echo
echo "Jetson deployment:"
echo "  tar -xzf $archive_name"
echo "  cd termrelay-server-$version"
echo "  ./deploy.sh  # Production configuration is already included"
echo "  # LAN Web: http://JETSON_LAN_IP:3006"
