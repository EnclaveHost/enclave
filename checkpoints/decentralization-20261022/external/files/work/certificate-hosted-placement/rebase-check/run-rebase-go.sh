#!/usr/bin/env bash
# One 1024 MiB queue job on the REBASE CHECK tree (current main, which now includes the volume-parity integration, plus this
# workspace's final changes; the custody file is the three-way composition): rebuild the runtime bundle from source, Go vet
# and tests (normal and shielddirect/bootstrapdirect), verbose evidence for the Shield app-zone/custody EAB tests, and the
# end-to-end process suite. Offline Go. Exit 0 only if every step passed.
set -euo pipefail
cd "$(dirname "$0")/tree"
rc=0
step() { echo "=== $*"; c=0; "$@" || c=$?; echo "[rebase] $* exit=$c"; [ $c -eq 0 ] || rc=1; }
step node relay/build-network.mjs
step bash test/run-shield-certificates.sh go
step bash -c "cd isolation/m2 && GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local go test -count=1 -v -tags 'bootstrapdirect shielddirect' -run 'TestShieldCustodyAppZone|TestShieldDirectAppZone|TestShieldDirectCustodyStartsWithoutEnclaveRelease' ./front"
step bash test/run-shield-certificates.sh process
echo "[rebase] exit=$rc"; exit $rc
