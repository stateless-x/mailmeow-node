#!/usr/bin/env bash
# Runs the contract suite against its OWN throwaway stack, never the dev stack:
#   - Postgres 17 + Redis 7 in `docker run --rm` containers, data on tmpfs, free ports
#   - migrations, then api + worker built from ../mailmeow-be with the FAKE email provider
#   - every Go process runs under `env -i`, so no AWS_* variable (or anything else
#     from this shell, including a sourced .env) can reach it
#   - an org, a project, a verified domain and live + test keys made with mmctl
# Everything is torn down on exit. Usage: scripts/contract-env.sh [vitest args]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
BE="$ROOT/../mailmeow-be"
STATE="$ROOT/.contract"
RUN_ID="$$"
PG_NAME="mailmeow-contract-pg-$RUN_ID"
REDIS_NAME="mailmeow-contract-redis-$RUN_ID"
PIDS=()

cleanup() {
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do wait "$pid" 2>/dev/null || true; done
  docker rm -f "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# A free port that is not one the dev stack uses.
free_port() {
  python3 - <<'PY'
import socket
while True:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    if p not in (8080, 55432, 56379): print(p); break
PY
}

PG_PORT=$(free_port); REDIS_PORT=$(free_port); API_PORT=$(free_port)
DATABASE_URL="postgres://postgres:contract@127.0.0.1:$PG_PORT/postgres?sslmode=disable"
REDIS_URL="redis://127.0.0.1:$REDIS_PORT/0"
BASE_URL="http://127.0.0.1:$API_PORT"

mkdir -p "$STATE/bin"
: > "$STATE/api.log"; : > "$STATE/worker.log"

docker run --rm -d --name "$REDIS_NAME" -p "127.0.0.1:$REDIS_PORT:6379" \
  redis:7-alpine redis-server --save "" --appendonly no >/dev/null
docker run --rm -d --name "$PG_NAME" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=contract -p "127.0.0.1:$PG_PORT:5432" postgres:17-alpine >/dev/null

wait_for() { # description, tries, command...
  local what="$1" tries="$2"; shift 2
  until "$@" >/dev/null 2>&1; do
    tries=$((tries - 1)); [ "$tries" -gt 0 ] || { echo "$what did not become ready" >&2; exit 1; }
    sleep 1
  done
}
wait_for postgres 60 docker exec "$PG_NAME" pg_isready -U postgres -h 127.0.0.1
wait_for redis 30 docker exec "$REDIS_NAME" redis-cli ping

# Only these variables reach the Go programs. HOME and PATH are for the Go toolchain.
# An array, not a function, so `"${CLEAN[@]}" cmd &` gives $! of the program itself (env execs it).
CLEAN=(env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}"
  DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL"
  MAILMEOW_EMAIL_PROVIDER=fake RATE_LIMIT_PER_SECOND=100 SEND_RATE_PER_SECOND=100
  # The webhook test's receiver is a local http:// server; the API refuses private webhook URLs unless both are set.
  APP_ENV=development WEBHOOK_ALLOW_PRIVATE=true)

(cd "$BE" && "${CLEAN[@]}" go run ./cmd/migrate >"$STATE/migrate.log" 2>&1) || { cat "$STATE/migrate.log" >&2; exit 1; }
(cd "$BE" && for c in api worker mmctl; do "${CLEAN[@]}" go build -o "$STATE/bin/$c" "./cmd/$c"; done)

"${CLEAN[@]}" PORT="$API_PORT" "$STATE/bin/api" >"$STATE/api.log" 2>&1 & PIDS+=($!)
"${CLEAN[@]}" "$STATE/bin/worker" >"$STATE/worker.log" 2>&1 & PIDS+=($!)
wait_for api 30 curl -sf "$BASE_URL/health"

mm() { "${CLEAN[@]}" "$STATE/bin/mmctl" "$@"; }
ORG_ID=$(mm org create --name contract --daily-limit 100000)
PROJECT_ID=$(mm project create --org "$ORG_ID" --name contract)
DOMAIN="contract.test"
mm domain add --org "$ORG_ID" --name "$DOMAIN" --verified >/dev/null
LIVE_KEY=$(mm key create --org "$ORG_ID" --project "$PROJECT_ID" --name live --mode live --stream transactional 2>/dev/null)
TEST_KEY=$(mm key create --org "$ORG_ID" --project "$PROJECT_ID" --name test --mode test --stream transactional 2>/dev/null)

echo "contract stack: api $BASE_URL, postgres :$PG_PORT, redis :$REDIS_PORT, provider fake"

# The suite gets the stack's coordinates and nothing from the caller's shell that could reach AWS.
set +e
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_PROFILE -u AWS_REGION \
  -u MAILMEOW_API_KEY -u MAILMEOW_BASE_URL -u RESEND_API_KEY -u RESEND_BASE_URL \
  MAILMEOW_CONTRACT_BASE_URL="$BASE_URL" \
  MAILMEOW_CONTRACT_LIVE_KEY="$LIVE_KEY" \
  MAILMEOW_CONTRACT_TEST_KEY="$TEST_KEY" \
  MAILMEOW_CONTRACT_FROM="Contract <hello@$DOMAIN>" \
  MAILMEOW_CONTRACT_ORG_ID="$ORG_ID" \
  MAILMEOW_CONTRACT_DATABASE_URL="$DATABASE_URL" \
  MAILMEOW_CONTRACT_MMCTL="$STATE/bin/mmctl" \
  bunx vitest run --config vitest.contract.config.ts "$@"
status=$?
set -e
exit "$status"
