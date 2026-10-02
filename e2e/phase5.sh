#!/bin/sh
# Runs the phase 5 browser test from nothing: a clean database, the fake networks plus an OpenID provider, Slack and a push service,
# the API (with its worker) pointed at them with a second factor required, then e2e/phase5.mjs. Everything it starts is stopped again at the end.
#
#   npm install && npm run build && npm run e2e:assets      # once (e2e/assets must have big.webm and captions.vtt: this script makes them if not)
#   TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:5433/postgres e2e/phase5.sh
#
# Needs PostgreSQL (and permission to create a database), ffmpeg, Node 22 and a Chromium (CHROMIUM, default /opt/pw-browsers/chromium).
set -e
cd "$(dirname "$0")/.."

ADMIN_URL="${TEST_DATABASE_ADMIN_URL:-postgres://postgres@localhost:5433/postgres}"
DB_NAME="${E2E_DB_NAME:-estudio_e2e_phase5}"
DB_URL="${ADMIN_URL%/*}/$DB_NAME"
PORT="${PORT:-3500}"
FAKES_PORT="${FAKES_PORT:-4050}"
WORK="$(mktemp -d)"
PIDS=""

cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

[ -f apps/web/dist/index.html ] || { echo "Build first: npm run build" >&2; exit 2; }
[ -f e2e/assets/reel-v1.webm ] && [ -f e2e/assets/big.webm ] && [ -f e2e/assets/captions.vtt ] || sh e2e/make-assets.sh

psql "$ADMIN_URL" -q -c "drop database if exists $DB_NAME" -c "create database $DB_NAME"

# The fake networks print the variables the API needs.
FAKES_ACCESS=1 FAKES_PORT="$FAKES_PORT" node --import tsx e2e/fakes.mts > "$WORK/fakes.env" 2> "$WORK/fakes.err" &
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
export WEB_DIST="$PWD/apps/web/dist" STORAGE_LOCAL_DIR="$WORK/media" STAGING_DIR="$WORK/staging" WORKER_SWEEP_SECONDS=2 METRICS_SWEEP_SECONDS=2 NOTIFY_SECONDS=3
# The second factor is asked of admins and approvers (it is off in development unless set), and YouTube is asked for its Analytics permission.
export SECOND_FACTOR_REQUIRED=true GOOGLE_ANALYTICS=true
mkdir -p "$WORK/media" "$WORK/staging"

npm run bootstrap -w @estudio/api --silent -- --workspace Demo --brand "Lumen Coffee" --timezone Europe/Madrid --admin admin@example.com >/dev/null
node --import tsx apps/api/src/server.ts > "$WORK/api.log" 2>&1 &
PIDS="$PIDS $!"
i=0
until curl -sf "http://localhost:$PORT/api/health" >/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "The API did not start:" >&2; tail -20 "$WORK/api.log" >&2; exit 1; }
  sleep 0.5
done

BASE_URL="http://localhost:$PORT" FAKES_URL="http://127.0.0.1:$FAKES_PORT" DATABASE_URL="$DB_URL" STAGING_DIR="$WORK/staging" node e2e/phase5.mjs || {
  status=$?
  echo "--- the API's log (last lines) ---" >&2
  tail -25 "$WORK/api.log" >&2
  exit "$status"
}
