#!/bin/bash
set -euo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/resource-guest-lineage-20261023
export GOTOOLCHAIN=local GOFLAGS=-mod=mod GOPROXY=off GOCACHE=$D/scratch/gocache GOMAXPROCS=1 GOMEMLIMIT=256MiB
cd $D/tools/pcline
go vet . && go build -o $D/scratch/pcline .
S=$D/scratch
T="$S/old $S/t-33f7e73fe $S/t-d2ef66631 $S/t-65818c239 $S/t-28d642888 $S/qbase $S/qe"
$S/pcline -main isolation/m3/monitor $S/f86fb512/monitor $T
$S/pcline -main isolation/m2/front $S/f86fb512/plat/front $T
$S/pcline -main isolation/m3/secretrun $S/f86fb512/plat/secretrun $T
