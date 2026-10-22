#!/bin/bash
# Windows supervisor (tree-r2/network/host-services/windows-supervisor): vet (linux + windows), portable unit tests,
# the windows test binary compiled, two reproducible windows/amd64 builds (fresh build cache for the second). Offline.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H/tree-r2/network/host-services/windows-supervisor"
export GOPROXY=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=mod CGO_ENABLED=0
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
go version
step VET-LINUX go vet ./...
step VET-WINDOWS env GOOS=windows GOARCH=amd64 go vet ./...
step TEST-PORTABLE go test -count=1 -v ./...
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
step COMPILE-WINDOWS-TESTS env GOOS=windows GOARCH=amd64 go test -c -o "$T/supervisor-test.exe" .
build() { env GOOS=windows GOARCH=amd64 GOCACHE="$2" go build -trimpath -ldflags="-s -w -buildid=" -o "$1" . ; }
step BUILD-1 build "$T/a.exe" "$(go env GOCACHE)"
mkdir -p "$T/cache2"
step BUILD-2-FRESH-CACHE build "$T/b.exe" "$T/cache2"
step REPRODUCIBLE cmp "$T/a.exe" "$T/b.exe"
if [ "$fails" -eq 0 ]; then mkdir -p "$H/out/windows"; cp "$T/a.exe" "$H/out/windows/hostsvc-supervisor.exe"; sha256sum "$H/out/windows/hostsvc-supervisor.exe"; file "$H/out/windows/hostsvc-supervisor.exe"; fi
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
