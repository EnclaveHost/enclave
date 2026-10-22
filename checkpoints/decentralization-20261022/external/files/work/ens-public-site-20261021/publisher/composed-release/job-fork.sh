#!/bin/bash
# local Anvil fork only (127.0.0.1); the anvil child is killed by fork-sim.mjs on exit; timeout bounds the job
set -uo pipefail
cd "/home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher/composed-release"
timeout 900 node fork-sim.mjs 18545 > fork-sim.json; rc=$?
echo rc=$rc; exit $rc
