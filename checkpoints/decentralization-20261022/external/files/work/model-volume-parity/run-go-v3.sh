#!/usr/bin/env bash
# Model volumes, Go and C (immutable; v3): what v2 did not reach or what changed since. guestd's whole suite; the
# Windows partition: monitor + secretrun suites (vet included), domexec in namespaces (the model-volume suite with
# mutants; encvol, front-uid, seccomp and egress as regressions); modelspec verbosely (the veritysetup root test).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
cd "$here/tree/isolation/m2"
go test -count=1 -v -run 'HoldsRoot|TableIsStrict|ConfigVolumes' ./modelspec/
cd "$here/tree/isolation/m4/guestd"
go vet ./...
go test -count=1 ./...
cd "$here/tree/isolation/m3"
go vet ./monitor/ ./secretrun/
go test -count=1 ./monitor/ ./secretrun/
sh ./test-domexec-modelvol.sh
sh ./test-domexec-encvol.sh
sh ./test-domexec-frontuid.sh
sh ./test-domexec-seccomp.sh
sh ./test-domexec-egress.sh
echo "run-go-v3: PASS"
