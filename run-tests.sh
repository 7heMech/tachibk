#!/usr/bin/env bash
# Build, then run every suite. See AGENTS.md section 5.
set -euo pipefail
cd "$(dirname "$0")"

bun tools/build.ts

# Logic suites run on Bun. The three DOM suites need jsdom, which Bun cannot host:
# jsdom's runScripts:'dangerously' uses vm.runInContext with a Proxy-based global and
# Bun rejects that ("Proxy is not allowed in the global prototype chain"). happy-dom
# does not execute inline <script> either. So those three stay on Node.
BUN_SUITES=(test test2 test3 rootcheck domcheck)
DOM_SUITES=(guard uitest e2e)

fail=0
run() { # <runner> <suite> <ext>
  printf '  %-10s %-5s ' "$2" "$1"
  if out=$("$1" "tests/$2.${3:-mjs}" 2>&1) && tail -1 <<<"$out" | grep -qE 'passed|verified'; then
    echo pass
  else
    echo FAIL; echo "$out" | grep -E '^FAIL|Error' | head -5 | sed 's/^/      /'; fail=1
  fi
}
for s in "${BUN_SUITES[@]}"; do
  [ "$s" = domcheck ] && run bun "$s" ts || run bun "$s"
done
for s in "${DOM_SUITES[@]}"; do run node "$s"; done

[ $fail -eq 0 ] && echo "  all suites passed" || echo "  FAILURES"
exit $fail
