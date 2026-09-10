#!/bin/bash
# Everything, in one process group.
#
# Background servers started in one shell invocation do not survive it, so a
# test run that starts the server in one step and tests in the next hits a
# dead — or worse, a STALE — server. That cost an hour chasing 307s that were
# never the app's fault. Server, browser and tests all live here now.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-3210}"
CDP="${CDP:-9333}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; [ -n "${BRW:-}" ] && kill "$BRW" 2>/dev/null; }
trap cleanup EXIT

# Only ever kill OUR server.
#
# This used to be `lsof -ti:$PORT | xargs kill -9`, on port 3111 — which is
# where the Analytics Dashboard dev server runs. It killed the user's running
# app, repeatedly, and produced a day of "intermittent" 307s and 404s that were
# really two servers fighting over one port. Hence both the dedicated port
# above and this check: a PID is killed only if its working directory is this
# repository.
ROOT="$(pwd)"
for pid in $(lsof -ti:"$PORT" 2>/dev/null); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)
  if [ "$cwd" = "$ROOT" ]; then
    kill -9 "$pid" 2>/dev/null
  else
    echo "  refusing to kill pid $pid on port $PORT — it belongs to $cwd"
    echo "  set PORT=<free port> and re-run."
    exit 1
  fi
done
pkill -f "remote-debugging-port=$CDP" 2>/dev/null
sleep 1

PORT="$PORT" npm start > /tmp/os-server.log 2>&1 & SRV=$!
"$CHROME" --headless=new --remote-debugging-port="$CDP" --user-data-dir=/tmp/cdp-profile \
  --no-first-run --disable-gpu --window-size=1600,1000 > /tmp/chrome.log 2>&1 & BRW=$!

for i in $(seq 1 45); do
  sleep 1
  curl -s -o /dev/null "http://localhost:$PORT/login" 2>/dev/null \
    && curl -s -o /dev/null "http://localhost:$CDP/json/version" 2>/dev/null && break
done
curl -s -o /dev/null "http://localhost:$PORT/login" || { echo "  server never came up"; tail -5 /tmp/os-server.log; exit 1; }

filter() { grep -viE 'warning|reparsing|trace-warn|eliminate|^\(node'; }
FAIL=0
echo "═══ TYPECHECK"; n=$(npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c 'error TS'); echo "  $n errors"; [ "$n" -gt 0 ] && FAIL=1
echo "═══ UNIT";      node --test $(find src -name '*.test.ts' | tr '\n' ' ') 2>&1 | grep -E '^ℹ (tests|pass|fail)'
echo "═══ API";       node scripts/smoke.mjs   2>&1 | filter | tail -2  || FAIL=1
echo "═══ SCREENS";   node scripts/ui-test.mjs 2>&1 | filter            || FAIL=1
echo "═══ FEATURES";  node scripts/feature-test.mjs 2>&1 | filter | grep -E "features present|✗" || FAIL=1
echo "═══ PAYLOAD";   node scripts/payload.mjs 2>&1 | filter            || true
echo "═══ PORTALS";   node scripts/portal-fingerprint.mjs check 2>&1 | filter | grep -E "portal URL|DIFFEREN|\\*\\*\\*" || FAIL=1
exit $FAIL
