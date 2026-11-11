#!/usr/bin/env bash
# Runs each compiled test file in its own process with hard limits, so one stuck browser can neither hang the run nor hold
# the shared headless lock: 90 s per test, 4 minutes per file. Prints one line per file and the failing lines of any that failed.
cd "$(dirname "$0")/.." || exit 1
status=0
LOCK="${GAMECHECK_LOCK:-}"
# Waiting for the shared lock must not count against a test's time limit, so wait for it to be free first (up to 10 minutes).
wait_free() {
  [ -z "$LOCK" ] && return 0
  for _ in $(seq 1 300); do [ -f "$LOCK" ] || return 0; sleep 2; done
  echo "lock still held after 10 minutes: $(cat "$LOCK" 2>/dev/null | head -c 160)"
}
for f in ${FILES:-dist/test/*.test.js}; do
  wait_free
  out="$(timeout 240 node --test --test-timeout=90000 "$f" 2>&1)"
  code=$?
  pass="$(grep -E '^ℹ pass ' <<<"$out" | awk '{print $3}')"
  fail="$(grep -E '^ℹ fail ' <<<"$out" | awk '{print $3}')"
  if [ "$code" -eq 124 ]; then echo "TIMEOUT $f (killed after 240 s)"; status=1
  elif [ "$code" -ne 0 ]; then echo "FAIL    $f pass ${pass:-?} fail ${fail:-?}"; grep -E '^\s*(✖|not ok|Error|AssertionError)|expected|actual|    at ' <<<"$out" | head -12; status=1
  else echo "ok      $f pass ${pass:-?}"; fi
done
exit $status
