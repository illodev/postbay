#!/bin/sh
# Runs the publishing browser test from nothing: a clean database, the fake Meta and Google servers, the API (with its
# worker) pointed at them, then e2e/publishing.mjs. Everything it starts is stopped again at the end.
#
#   npm install && npm run build && npm run e2e:assets      # once
#   TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:5433/postgres e2e/publishing.sh
#
# Needs PostgreSQL (and permission to create a database), ffmpeg, Node 22 and a Chromium (CHROMIUM, default /opt/pw-browsers/chromium).
set -e
cd "$(dirname "$0")/.."

ADMIN_URL="${TEST_DATABASE_ADMIN_URL:-postgres://postgres@localhost:5433/postgres}"
DB_NAME="${E2E_DB_NAME:-estudio_e2e_publishing}"
DB_URL="${ADMIN_URL%/*}/$DB_NAME"
PORT="${PORT:-3100}"
FAKES_PORT="${FAKES_PORT:-4020}"
WORK="$(mktemp -d)"
PIDS=""

cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

[ -f apps/web/dist/index.html ] || { echo "Build first: npm run build" >&2; exit 2; }
[ -f e2e/assets/reel-v1.webm ] || sh e2e/make-assets.sh

psql "$ADMIN_URL" -q -c "drop database if exists $DB_NAME" -c "create database $DB_NAME"

# The fake networks print the variables the API needs.
FAKES_PORT="$FAKES_PORT" node --import tsx e2e/fakes.mts > "$WORK/fakes.env" 2> "$WORK/fakes.err" &
PIDS="$PIDS $!"
i=0
until grep -q "fakes ready" "$WORK/fakes.env" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 40 ] && { echo "The fake networks did not start:" >&2; cat "$WORK/fakes.err" >&2; exit 1; }
  sleep 0.5
done
. "$WORK/fakes.env"

export DATABASE_URL="$DB_URL" NODE_ENV=development AUTH_DEV_LOGIN=true PORT
export SECRET="$(openssl rand -hex 32)" TOKEN_KEY="$(openssl rand -base64 32)"
export APP_URL="http://localhost:$PORT" MEDIA_URL="http://localhost:$PORT"
export WEB_DIST="$PWD/apps/web/dist" STORAGE_LOCAL_DIR="$WORK/media" WORKER_SWEEP_SECONDS=2
mkdir -p "$WORK/media"

npm run bootstrap -w @estudio/api --silent -- --workspace Demo --brand "Lumen Coffee" --timezone Europe/Madrid --admin admin@example.com >/dev/null
node --import tsx apps/api/src/server.ts > "$WORK/api.log" 2>&1 &
PIDS="$PIDS $!"
i=0
until curl -sf "http://localhost:$PORT/api/health" >/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "The API did not start:" >&2; tail -20 "$WORK/api.log" >&2; exit 1; }
  sleep 0.5
done

BASE_URL="http://localhost:$PORT" FAKES_URL="http://127.0.0.1:$FAKES_PORT" DATABASE_URL="$DB_URL" node e2e/publishing.mjs
