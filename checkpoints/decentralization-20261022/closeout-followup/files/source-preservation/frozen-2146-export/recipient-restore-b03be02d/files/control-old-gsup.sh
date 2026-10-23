#!/bin/bash
# Control: the NEW test file run against the UNMODIFIED deabf8f90 tree must FAIL on the vault assertions (exit != 0 expected).
set -u
cd "$(dirname "$0")"
rm -rf control-wt; git -C repo worktree add -q --detach ../control-wt deabf8f90f64902d20d48620fd911d34c445859d
for d in . relay network; do ln -s "$(cd repo/$d && readlink -f node_modules)" control-wt/$d/node_modules; done
mkdir -p control-wt/test/helpers; cp repo/test/helpers/gsup-env-harness.mjs control-wt/test/helpers/; cp repo/test/metal-gsup-custody-env.test.mjs control-wt/test/
(cd control-wt && node --test --test-concurrency=1 test/metal-gsup-custody-env.test.mjs); rc=$?
git -C repo worktree remove --force ../control-wt
echo "control exit $rc (expected non-zero)"; [ $rc -ne 0 ]
