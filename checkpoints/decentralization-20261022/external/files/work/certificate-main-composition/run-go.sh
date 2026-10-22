#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/certificate-main-composition/isolation/m2
export GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
go test -count=1 ./bootstrap ./front
go test -count=1 -tags='shielddirect bootstrapdirect' ./bootstrap ./front
