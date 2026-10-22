#!/usr/bin/env bash
# Model volumes, Go and C (immutable; v2 = v1 + the shared modelspec package, the Windows partition path and the
# harnesses whose header copies changed). SNP: the init handoff (M1, measured table, disks, staging, budgeted preloads;
# glibc + musl), dominit hardening and the seccomp statement, the front, modelspec (incl. the root rule against a
# veritysetup tree), guestd's whole suite. Windows partition: monitor + secretrun suites, domexec in namespaces (the new
# model-volume suite with mutants; the encvol, front-uid, seccomp and egress suites as regressions).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
cd "$here/tree/isolation/m2"
sh ./test-dominit-handoff.sh
sh ./test-dominit-hardening.sh
sh ./test-seccomp-statement.sh
go vet ./front/ ./modelspec/ && go vet -tags shielddirect,bootstrapdirect ./front/
go test -count=1 ./front/ ./egress/ ./appconfig/ ./modelspec/
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
echo "run-go-v2: PASS"
