#!/usr/bin/env bash
# The rest of the candidate's Go and C on the candidate (immutable; v1): guestd (supports.encVolumes), the whole m2
# front package (its existing suites with the encvol wiring; the E2E skips without ENCVOL_E2E), init's suites, and the
# Hyper-V partition path: monitor staging, secretrun, domexec in namespaces (new and existing suites).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GOFLAGS=-mod=readonly GOTOOLCHAIN=local GOMAXPROCS=4
(cd "$here/tree/isolation/m4/guestd" && go vet ./... && go test -count=1 ./...)
(cd "$here/tree/isolation/m2" && go test -count=1 ./front/ ./egress/ ./appconfig/)
(cd "$here/tree/isolation/m2" && sh ./test-dominit-handoff.sh && sh ./test-dominit-hardening.sh && sh ./test-seccomp-statement.sh)
(cd "$here/tree/isolation/m3" && go vet ./monitor/ ./secretrun/ && go test -count=1 ./monitor/ ./secretrun/)
(cd "$here/tree/isolation/m3" && sh ./test-domexec-encvol.sh && sh ./test-domexec-frontuid.sh && sh ./test-domexec-seccomp.sh)
echo "run-go-misc-v1: PASS"
