#!/bin/sh
# LIVE (read-only public JSON-RPC, no keys): the guest reader's code against the live ledger for live current leases,
# measured-only (the frozen behaviour) and with two keyless history operators (tenderly, nodies).
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-cold-history
cfg=$(node $W/find-live-leases.mjs)
echo "LIVE-CONFIG $cfg"
cd $W/tree/isolation/m2
LIVE_COLD_HISTORY="$cfg" GOFLAGS=-mod=mod go test -count=1 -run '^TestLiveColdHistory$' -v -timeout 90m ./bootstrap
echo LIVE-DONE
