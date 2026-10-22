#!/bin/sh
# The reader changed (leasegen.go keeps the claim's whole block; checkpoint seeding is time-bound and gap-free), so the
# lease16d reader rig and the cold-history suite run again; test 6 of the latter is now the checkpoint TRANSPORT
# (producer endpoint, carrier, committed mirrors, LoadCheckpoints) on the live rev-16d bytecode.
set -e
cd /home/steven/Documents/Codex/2026-10-18/wo/work/history-checkpoint-transport/tree
node --test --test-concurrency=1 test/storage-front-binding-go.test.mjs
echo FROZEN-GO-RIG-OK
node --test --test-concurrency=1 test/storage-front-cold-history.test.mjs
echo COLD-HISTORY-OK
