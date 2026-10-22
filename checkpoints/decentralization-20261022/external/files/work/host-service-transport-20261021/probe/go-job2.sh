#!/bin/bash
# ONE bounded Go job (queue 1024; root 15:30Z + 16:30Z): vet + the network/wg package tests, the linux AND windows enclave-wg
# builds (network/build.mjs flags: -trimpath, CGO_ENABLED=0, amd64), then the relay negative controls (go-mut.sh).
set -euo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
cd "$H/tree/network/wg"
export GOFLAGS=-mod=readonly GOPROXY=off CGO_ENABLED=0 GOMAXPROCS=2
echo "== go vet"; go vet . ./cmd/enclave-wg
echo "== go test (package network/wg)"; go test -count=1 -timeout 600s -v . 2>&1 | grep -E '^(--- |PASS|FAIL|ok|panic)'
echo "== builds"; mkdir -p "$H/probe/bin"
GOOS=linux GOARCH=amd64 go build -trimpath -o "$H/probe/bin/enclave-wg" ./cmd/enclave-wg
GOOS=windows GOARCH=amd64 go build -trimpath -o "$H/probe/bin/enclave-wg.exe" ./cmd/enclave-wg
# the relay's own tests as a NATIVE Windows binary (root runs it on minipc: real Windows loopback sockets, no peer/provider)
GOOS=windows GOARCH=amd64 go test -c -trimpath -o "$H/probe/bin/wg-udp-test.exe" .
sha256sum "$H/probe/bin/enclave-wg" "$H/probe/bin/enclave-wg.exe" "$H/probe/bin/wg-udp-test.exe"; go version
file "$H/probe/bin/enclave-wg.exe" 2>/dev/null || true
echo "== relay negative controls"; bash "$H/probe/go-mut.sh"
echo GO-JOB2-OK
