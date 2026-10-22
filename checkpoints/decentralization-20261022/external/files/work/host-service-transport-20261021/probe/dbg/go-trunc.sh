#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/../../tree/network/wg"
export GOFLAGS=-mod=readonly GOPROXY=off CGO_ENABLED=0 GOMAXPROCS=2
go test -count=1 -run '^TestUDPIngressTruncatesLongAnswers$' -v . 2>&1 | tail -15
