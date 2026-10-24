#!/usr/bin/env bash
# Local tests only (anvil + loopback; throwaway keys). Through the queue: ./q.sh 512 protocol-N ./run-tests.sh protocol
set -u
cd "$(dirname "$0")" && TMPDIR=$(mktemp -d) && trap 'rm -rf "$TMPDIR"' EXIT && export TMPDIR
case "${1:-}" in
  protocol) exec timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit --test-reporter=tap test/protocol.test.mjs ;;
  plan) exec timeout -k 5 120 node --test --test-concurrency=1 --test-reporter=tap test/plan.test.mjs ;;
  sender) exec timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit --test-reporter=tap test/sender.test.mjs ;;
  all) exec timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit --test-reporter=tap test/plan.test.mjs test/protocol.test.mjs test/sender.test.mjs ;;
  *) echo "usage: run-tests.sh protocol|plan|sender|all" >&2; exit 2 ;;
esac
