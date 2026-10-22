#!/bin/sh
# LIVE v4 (one lease; wait-all quorum with explicit-refusal cooldown and per-step coverage; coverage diagnostics) (read-only public JSON-RPC, no keys): the guest reader's code, owner history = two independent keyless
# operators that serve old logs (tenderly, polkachu; logs/probe-operators.run2.log), STRICT (a fact must be produced),
# then the independent JS reader cross-checks each fact. Measured-only is kept short (diagnostic).
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-cold-history
cfg=$(node $W/find-live-leases.mjs | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);c.history=["https://gateway.tenderly.co/public/base","https://base-rpc.polkachu.com"];c.ids=c.ids.slice(0,1);c.windowSec=1500;c.measuredWindowSec=30;c.expectFact=true;console.log(JSON.stringify(c))})')
echo "LIVE-CONFIG $cfg"
cd $W/tree/isolation/m2
LIVE_COLD_HISTORY="$cfg" GOFLAGS=-mod=mod go test -count=1 -run '^TestLiveColdHistory$' -v -timeout 40m ./bootstrap
echo LIVE-GO-OK
cd $W && node live-crosscheck.mjs logs/job-live4.log
echo LIVE-CROSSCHECK-OK
