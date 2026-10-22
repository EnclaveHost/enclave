#!/bin/bash
# The focused cost-model suites, sequentially in one queued job (peak = one suite + its anvil).
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave || exit 2
echo "== A: unit"; node --test test/lease-gas-cost-model.test.mjs; a=$?
echo "== B: deployed ledger on anvil"; node --test test/lease-gas-cost-model-ledger.test.mjs; b=$?
echo "== C: CLI callsites"; node --test --test-name-pattern "plan for many apps|status: a live rate-0" test/lease-gas-owner-cli.test.mjs; c=$?
echo "== rc unit=$a ledger=$b cli=$c"
[ $a -eq 0 ] && [ $b -eq 0 ] && [ $c -eq 0 ]
