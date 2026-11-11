#!/usr/bin/env bash
# Release check: does the Docker image work on a real Docker host?
# Builds the image, starts it with a fresh volume and budget-it.env.example as its settings (what a new
# self-hoster copies), adds a person with the laptop command, signs in, saves something, takes a backup,
# restarts the container and checks that the sign-in, the data and the time zone (TZ) are still right.
#   scripts/smoke-docker.sh            (from the repo root; needs docker and curl)
# Leaves nothing behind unless KEEP=1. SMOKE_PORT picks the port on this computer (default 18090).
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="budget-it-smoke-$$"
PORT="${SMOKE_PORT:-18090}"
URL="http://127.0.0.1:${PORT}"
JAR="$(mktemp)"
PASS="smoke-test-password"
# A time zone far from UTC with no daylight saving time (UTC+14), so "today" in it is easy to work out here
ZONE="Pacific/Kiritimati"

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; docker logs "$TAG" 2>&1 | tail -40 >&2 || true; exit 1; }
cleanup() {
  rm -f "$JAR"
  if [ "${KEEP:-}" = 1 ]; then echo "Kept container, volume and image named $TAG"; return; fi
  docker rm -f "$TAG" >/dev/null 2>&1 || true
  docker volume rm "$TAG" >/dev/null 2>&1 || true
  docker image rm "$TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 60); do curl -fsS "$URL/manifest.webmanifest" >/dev/null 2>&1 && return 0; sleep 1; done
  fail "the app did not answer on $URL"
}
# api METHOD PATH [JSON]: prints the body, then the status code on its own last line
api() { curl -sS -b "$JAR" -c "$JAR" -X "$1" ${3:+-H 'Content-Type: application/json' --data "$3"} -w '\n%{http_code}' "$URL$2"; }
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
# The date in $ZONE right now, worked out here without needing this computer's time zone files
zone_today() { date -u -d '+14 hours' +%F; }

step "Build the image"
docker build -q -t "$TAG" . >/dev/null

step "Start it with an empty volume and the example settings"
docker volume create "$TAG" >/dev/null
docker run -d --name "$TAG" -p "127.0.0.1:${PORT}:8090" -v "$TAG:/data" --env-file budget-it.env.example -e "TZ=$ZONE" \
  --cap-drop ALL --security-opt no-new-privileges:true "$TAG" >/dev/null
wait_up
[ "$(docker exec "$TAG" id -u)" != 0 ] || fail "the app runs as root inside the container"
! docker exec "$TAG" sh -c 'touch /app/server.js' 2>/dev/null || fail "the app can change its own files inside the container"
docker exec "$TAG" sh -c 'touch /data/.smoke && rm /data/.smoke' || fail "the app can't write to its data volume"

step "Add a person with the laptop command"
out="$(printf '%s\n%s\n' "$PASS" "$PASS" | docker exec -i "$TAG" node server.js add-user Smoke)"
echo "$out"
grep -q 'Added' <<<"$out" || fail "add-user did not add anyone"

step "Sign in and save something"
r="$(api POST /api/login "{\"name\":\"Smoke\",\"password\":\"$PASS\"}")"
[ "$(code "$r")" = 200 ] || fail "sign-in answered $(code "$r"): $(body "$r")"
r="$(api POST /api/op '{"op":"txn.add","args":{"amount":4.5,"m":"Smoke test coffee"}}')"
[ "$(code "$r")" = 200 ] || fail "saving answered $(code "$r"): $(body "$r")"
r="$(api GET /)"
[ "$(code "$r")" = 200 ] || fail "the app page answered $(code "$r")"
r="$(curl -sS -o /dev/null -w '%{http_code}' "$URL/art/hancock-happy.webp")"
[ "$r" = 200 ] || fail "the character art is missing from the image ($r)"

step "Time zone: \"today\" is today in $ZONE, not in UTC"
r="$(api GET /api/state)"
[ "$(code "$r")" = 200 ] || fail "reading answered $(code "$r")"
today="$(body "$r" | grep -o '"today":"[0-9-]*"' | head -n1 | cut -d'"' -f4)"
[ "$today" = "$(zone_today)" ] || fail "the app thinks today is $today, but in $ZONE it's $(zone_today) (is tzdata in the image?)"
[ "$(docker exec "$TAG" node -e 'console.log(new Date().getTimezoneOffset())')" = -840 ] || fail "TZ=$ZONE isn't used inside the container"

step "A backup from the laptop command, while it runs"
out="$(printf '\n' | docker exec -i "$TAG" node server.js backup /data/smoke-backup.zip)"
grep -q 'Wrote' <<<"$out" || fail "the backup command didn't write one: $out"

step "Restart the container"
docker restart "$TAG" >/dev/null
wait_up

step "Still signed in, and the data is still there"
r="$(api GET /api/state)"
[ "$(code "$r")" = 200 ] || fail "after the restart, reading answered $(code "$r") (signed out?)"
grep -q 'Smoke test coffee' <<<"$(body "$r")" || fail "the saved purchase is gone after the restart"
docker exec "$TAG" test -s /data/smoke-backup.zip || fail "the backup is gone after the restart"
rm -f "$JAR"; JAR="$(mktemp)"
r="$(api POST /api/login "{\"name\":\"Smoke\",\"password\":\"$PASS\"}")"
[ "$(code "$r")" = 200 ] || fail "signing in again after the restart answered $(code "$r")"

printf '\nDocker smoke test passed.\n'
