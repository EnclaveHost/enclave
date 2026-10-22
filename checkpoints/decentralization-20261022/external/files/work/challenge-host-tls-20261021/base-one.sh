#!/bin/bash
# the same single test on the FROZEN G3 tree (read-only: node --test writes only to tmp) and on this tree
B=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package/tree; T="$(cd "$(dirname "$0")" && pwd)"
P='^the REAL platform host policy gate'
(cd "$B" && node --test --test-name-pattern="$P" test/challenge-replica-host.test.mjs) > "$T/gate-base.out" 2>&1; echo "exit=$?" >> "$T/gate-base.out"
(cd "$T/tree" && node --test --test-name-pattern="$P" test/challenge-replica-host.test.mjs) > "$T/gate-new.out" 2>&1; echo "exit=$?" >> "$T/gate-new.out"
