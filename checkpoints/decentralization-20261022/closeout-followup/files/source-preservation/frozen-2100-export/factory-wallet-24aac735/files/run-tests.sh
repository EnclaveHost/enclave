#!/usr/bin/env bash
# Focused tests only (fake two-provider Base on loopback; memory journals; no external network). Run through q.sh:
#   ./q.sh 256 activation-N ./run-tests.sh activation        ./q.sh 512 browser-N ./run-tests.sh browser
set -u
cd "$(dirname "$0")" && TMPDIR=$(mktemp -d) && trap 'rm -rf "$TMPDIR"' EXIT && export TMPDIR
case "${1:-}" in
  activation) exec timeout -k 5 240 node --test --test-concurrency=1 --test-force-exit --test-reporter=tap test/activation.test.mjs ;;
  browser) exec timeout -k 5 240 node --test-reporter=tap test/browser.test.mjs ;;   # direct: no extra node --test parent (512 MiB budget)
  *) echo "usage: run-tests.sh activation|browser" >&2; exit 2 ;;
esac
