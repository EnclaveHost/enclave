#!/usr/bin/env bash
# The Hyper-V partition path (immutable; v1): monitor staging + its whole suite, secretrun, and domexec in namespaces
# (the new encvol suite with mutants, and the existing front-uid and seccomp suites).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
cd "$here/tree/isolation/m3"
go vet ./monitor/ ./secretrun/
go test -count=1 ./monitor/ ./secretrun/
sh ./test-domexec-encvol.sh
sh ./test-domexec-frontuid.sh
sh ./test-domexec-seccomp.sh
echo "run-m3-v1: PASS"
