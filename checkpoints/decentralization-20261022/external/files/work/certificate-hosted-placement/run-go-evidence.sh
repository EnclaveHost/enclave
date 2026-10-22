#!/usr/bin/env bash
# One 1024 MiB queue job: (1) verbose evidence that the Shield app-zone / custody EAB Go tests RUN (not skipped) on the
# composition, (2) the end-to-end process suite (the real Go issuer against separate Shield replica processes, and the
# SNP one) via the frozen runner. Offline Go (GOPROXY=off, -mod=readonly). Exit 0 only if both steps pass.
set -euo pipefail
cd "$(dirname "$0")/tree"
rc=0
( cd isolation/m2 && GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local go test -count=1 -v -tags 'bootstrapdirect shielddirect' \
    -run 'TestShieldCustodyAppZone|TestShieldDirectAppZone|TestShieldDirectCustodyStartsWithoutEnclaveRelease' ./front ) || rc=1
echo "[evidence] go -v tagged exit=$rc"
c=0; APPZONE_EVIDENCE="$(cd .. && pwd)/logs/process-replica-logs.json" bash test/run-shield-certificates.sh process || c=$?
echo "[evidence] process exit=$c"; [ $c -eq 0 ] || rc=1
echo "[evidence] exit=$rc"; exit $rc
