#!/usr/bin/env bash
# The whole post-deploy pass, in one command, each suite on its own Chrome port
# so none of them can kill another's browser (a lesson from the filter sweep
# that died at 10/22 screens when a sibling script reused its port).
#
#   scripts/full-verify.sh            → results in $OUT/*.txt + a summary
set -u
cd "$(dirname "$0")/.." || exit 1
OUT="${OUT:-/private/tmp/claude-501/-Users-sankalpdutt-Desktop-Code-Corofy-Centralised-dashboard/974f1bc9-3e1c-42d6-9231-09624b95b027/scratchpad/verify-$(date +%H%M)}"
mkdir -p "$OUT"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
NODE="node --import ./scripts/alias-hooks.mjs"
quiet() { grep -vE "Warning|Reparsing|eliminate|^\(node:|trace-warnings"; }

chrome() { # port
  local prof="$OUT/prof-$1"; rm -rf "$prof"; mkdir -p "$prof"
  "$CHROME" --headless=new --remote-debugging-port="$1" --user-data-dir="$prof" \
    --no-first-run --no-default-browser-check --disable-gpu about:blank >"$OUT/chrome-$1.log" 2>&1 &
  for i in $(seq 1 40); do curl -s -m 2 "http://127.0.0.1:$1/json/version" >/dev/null 2>&1 && return 0; perl -e 'select(undef,undef,undef,0.5)'; done
  return 1
}
kill_chrome() { pkill -f "remote-debugging-port=$1" 2>/dev/null; true; }

echo "results → $OUT"

# 0. Nothing about the live portals may have changed. Cheapest, and the one
#    that must never regress.
$NODE scripts/portal-fingerprint.mjs 2>&1 | quiet > "$OUT/portals.txt"; echo "  portals      $(tail -1 "$OUT/portals.txt")"

# 0b. Access control in both directions, plus every public-at-the-proxy path
#     refusing anonymous and wrong-secret callers. No browser needed.
$NODE scripts/rbac-matrix.mjs https://os.brokerstaffer.com 2>&1 | quiet > "$OUT/rbac.txt"
echo "  rbac         $(grep -E 'correct ·|fails closed|answered an anonymous' "$OUT/rbac.txt" | tr '\n' ' ' | cut -c1-120)"

# 1. Every ported feature, on the deployed site.
chrome 9530 && PORT=9530 $NODE scripts/parity-verify.mjs 2>&1 | quiet > "$OUT/parity.txt"; kill_chrome 9530
echo "  parity       $(grep -E 'passed' "$OUT/parity.txt" | tail -1)"

# 2. Create → verify → delete a throwaway client end to end.
$NODE scripts/lifecycle-test.mjs 2>&1 | quiet > "$OUT/lifecycle.txt"; echo "  lifecycle    $(tail -1 "$OUT/lifecycle.txt")"

# 3. UI audit: 12 rules × 5 widths × every screen. Self-test first — a blind
#    audit that passes is worse than none.
chrome 9531 && CDP=http://localhost:9531 $NODE scripts/ui-audit.mjs --self-test 2>&1 | quiet > "$OUT/ui-selftest.txt"
if grep -q "all 12 rules fire" "$OUT/ui-selftest.txt"; then
  CDP=http://localhost:9531 $NODE scripts/ui-audit.mjs https://os.brokerstaffer.com 2>&1 | quiet > "$OUT/ui.txt"
  echo "  ui audit     $(grep -E 'screens x .* issue' "$OUT/ui.txt" | tail -1)"
else
  echo "  ui audit     SKIPPED — self-test blind"; fi
kill_chrome 9531

# 4. Filters: three shards + the inbox builder, in parallel.
chrome 9532; chrome 9533; chrome 9534; chrome 9535; chrome 9538
CDP=http://localhost:9532 ROUTES="/analytics/campaign,/analytics/campaigns,/analytics/attribution,/analytics/volume" \
  $NODE scripts/filter-audit.mjs https://os.brokerstaffer.com 2>&1 | quiet > "$OUT/filters-a.txt" & FA=$!
CDP=http://localhost:9533 ROUTES="/analytics/infrastructure,/analytics/copy,/analytics/clients,/analytics/schedule" \
  $NODE scripts/filter-audit.mjs https://os.brokerstaffer.com 2>&1 | quiet > "$OUT/filters-b.txt" & FB=$!
# Client Health on its own Chrome: three views x 15 filters on a 96-row table
# was ~40 min serialised behind the analytics sweep — the whole run's long pole.
CDP=http://localhost:9538 ROUTES="/clients,/clients/biweekly,/clients/success" \
  $NODE scripts/filter-audit.mjs https://os.brokerstaffer.com 2>&1 | quiet > "$OUT/filters-d.txt" & FD=$!
CDP=http://localhost:9534 ROUTES="/onboarding/pipeline,/onboarding/stages,/onboarding/templates,/search/master,/search/accounts,/search/mls,/inbox/portals,/inbox/trash,/roster,/performance" \
  $NODE scripts/filter-audit.mjs https://os.brokerstaffer.com 2>&1 | quiet > "$OUT/filters-c.txt" & FC=$!
PORT=9535 $NODE scripts/inbox-filters-test.mjs 2>&1 | quiet > "$OUT/filters-inbox.txt" & FI=$!
# Wait on the five test pipelines ONLY. A bare `wait` also waits on the
# headless Chromes launched above as background jobs, which never exit on
# their own — the previous two full runs sat here forever after every filter
# suite had finished, and looked like a slow sweep.
wait $FA $FB $FC $FD $FI
for p in 9532 9533 9534 9535 9538; do kill_chrome $p; done
echo "  filters      a: $(grep -E 'filters exercised' "$OUT/filters-a.txt" | tail -1) | b: $(grep -E 'filters exercised' "$OUT/filters-b.txt" | tail -1) | c: $(grep -E 'filters exercised' "$OUT/filters-c.txt" | tail -1) | d: $(grep -E 'filters exercised' "$OUT/filters-d.txt" | tail -1) | inbox: $(tail -1 "$OUT/filters-inbox.txt")"

# 5. Dialogs centred at desktop and phone width; tab switching feel.
chrome 9536 && PORT=9536 $NODE scripts/modal-center-test.mjs 2>&1 | quiet > "$OUT/modals.txt"; kill_chrome 9536
echo "  modals       $(tail -1 "$OUT/modals.txt")"
chrome 9537 && PORT=9537 $NODE scripts/tab-switch-timing.mjs 2>&1 | quiet > "$OUT/tabs.txt"; kill_chrome 9537
echo "  tab switch   $(grep -E 'feedback \(click' "$OUT/tabs.txt" | tail -1)"

echo
echo "=== anything not passing ==="
grep -hE "^\s*(FAIL|DEAD|WIDE|ERR)\b|PROBLEM|FAILED|✗|leak\(s\)|wrongly refused" "$OUT"/*.txt | grep -vE "self-test|Search by name, email|0 leak\(s\) · 0 wrongly" | head -60 || true
