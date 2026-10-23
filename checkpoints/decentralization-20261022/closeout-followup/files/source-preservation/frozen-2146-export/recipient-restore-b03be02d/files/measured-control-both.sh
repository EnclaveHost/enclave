#!/bin/bash
# metal-measured-control.test.mjs on the UNMODIFIED deabf8f90 tree and on the restore commit; reports each verdict per test.
set -u
cd "$(dirname "$0")"
rm -rf control-wt; git -C repo worktree add -q --detach ../control-wt deabf8f90f64902d20d48620fd911d34c445859d
for d in . relay network; do ln -s "$(cd repo/$d && readlink -f node_modules)" control-wt/$d/node_modules; done
echo "== deabf8f90 (unmodified)"; (cd control-wt && node --test --test-concurrency=1 test/metal-measured-control.test.mjs 2>&1 | grep -E '^(not )?ok|^# (pass|fail)')
echo "== restore commit $(git -C repo rev-parse --short HEAD)"; (cd repo && node --test --test-concurrency=1 test/metal-measured-control.test.mjs 2>&1 | grep -E '^(not )?ok|^# (pass|fail)')
git -C repo worktree remove --force ../control-wt
