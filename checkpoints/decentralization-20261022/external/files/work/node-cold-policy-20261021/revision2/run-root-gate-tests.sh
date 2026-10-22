#!/bin/bash
set -eu
cd /home/steven/Documents/Codex/2026-10-18/wo/work/node-cold-policy-20261021/revision2/tree
node --test test/wallet-network-admission.test.mjs test/wg-manager.test.mjs test/privacy-agent-lifecycle.test.mjs > ../root-gate-tests.out 2>&1
