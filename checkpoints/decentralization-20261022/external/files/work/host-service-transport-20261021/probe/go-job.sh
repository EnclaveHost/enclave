#!/bin/bash
# Bounded Go target job (root 15:30Z: 1024 MiB lane): network/wg package tests + vet, and the linux enclave-wg binary for the
# netns host-side test. Offline: module cache only (GOPROXY=off), no network.
set -euo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
cd "$H/tree/network/wg"
export GOFLAGS=-mod=readonly GOPROXY=off CGO_ENABLED=0 GOMAXPROCS=2
echo "== go vet"; go vet . ./cmd/enclave-wg
echo "== go test (package network/wg)"; go test -count=1 -timeout 600s -v . 2>&1 | grep -E '^(=== RUN|--- |PASS|FAIL|ok|panic)' 
echo "== go build linux enclave-wg"; go build -trimpath -o "$H/probe/bin/enclave-wg" ./cmd/enclave-wg
sha256sum "$H/probe/bin/enclave-wg"
echo GO-JOB-OK
