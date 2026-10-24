#!/usr/bin/env bash
# Focused tests (anvil + loopback fakes; memory journals; no external network). Run through q.sh:
#   ./q.sh 512 handoff-N ./run-tests.sh handoff        ./q.sh 512 browser-N ./run-tests.sh browser
set -u
cd "$(dirname "$0")" && TMPDIR=$(mktemp -d) && trap 'rm -rf "$TMPDIR"' EXIT && export TMPDIR
case "${1:-}" in
  handoff) exec timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit --test-reporter=tap test/handoff.test.mjs ;;
  browser) exec timeout -k 5 300 node --test-reporter=tap test/browser.test.mjs ;;   # direct: no extra node --test parent (512 MiB budget)
  *) echo "usage: run-tests.sh handoff|browser" >&2; exit 2 ;;
esac
