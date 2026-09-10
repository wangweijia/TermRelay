#!/usr/bin/env bash
set -euo pipefail

release_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
env_file="$release_dir/.env.production"
skip_migration=false

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [--env-file PATH] [--skip-migration]

Loads the bundled TermRelay Docker image, runs database migrations, starts the
production container, and waits for its health check.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || { echo "--env-file requires a path" >&2; exit 2; }
      env_file="$2"
      shift 2
      ;;
    --skip-migration)
      skip_migration=true
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

for command in docker gzip curl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done
docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose v2 is required (docker compose)." >&2
  exit 1
}

manifest="$release_dir/manifest.env"
image_archive="$release_dir/image.tar.gz"
compose_file="$release_dir/compose.yaml"
[ -f "$manifest" ] || { echo "Missing release manifest: $manifest" >&2; exit 1; }
[ -f "$image_archive" ] || { echo "Missing image archive: $image_archive" >&2; exit 1; }
[ -f "$compose_file" ] || { echo "Missing Compose file: $compose_file" >&2; exit 1; }

if [ ! -f "$env_file" ]; then
  cp "$release_dir/.env.production.example" "$env_file"
  chmod 600 "$env_file"
  echo "Created $env_file"
  echo "Fill in DB_PASSWORD and DB_MIGRATION_PASSWORD, then run this command again." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
. "$manifest"
set +a
: "${TERMRELAY_IMAGE:?TERMRELAY_IMAGE missing from manifest}"

if grep -Eq '^(DB_PASSWORD|DB_MIGRATION_PASSWORD)=replace-' "$env_file"; then
  echo "Replace the database password placeholders in $env_file first." >&2
  exit 2
fi

echo "Loading $TERMRELAY_IMAGE ..."
gzip -dc "$image_archive" | docker load

compose() {
  TERMRELAY_IMAGE="$TERMRELAY_IMAGE" docker compose \
    --env-file "$env_file" \
    -f "$compose_file" \
    -p termrelay "$@"
}

if [ "$skip_migration" = false ]; then
  echo "Running database migrations ..."
  compose --profile migration run --rm --no-deps migrate
fi

echo "Starting TermRelay Server ..."
compose up -d --no-build server

server_port="$(sed -n 's/^SERVER_PORT=//p' "$env_file" | tail -n 1)"
server_port="${server_port:-3000}"
health_url="http://127.0.0.1:${server_port}/health"

attempt=1
while [ "$attempt" -le 30 ]; do
  if curl -fsS "$health_url" >/dev/null 2>&1; then
    echo "TermRelay is healthy: $health_url"
    compose ps
    exit 0
  fi
  sleep 2
  attempt=$((attempt + 1))
done

echo "Server did not become healthy within 60 seconds." >&2
compose ps >&2
compose logs --tail=120 server >&2
exit 1
