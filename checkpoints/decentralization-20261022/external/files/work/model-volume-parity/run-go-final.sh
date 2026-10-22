#!/usr/bin/env bash
# Model volumes, Go and C, FINAL tree state (immutable): run-go-v2.sh's list plus test-domprobe-layers.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
cd "$here/tree/isolation/m2"
sh ./test-dominit-handoff.sh
sh ./test-dominit-hardening.sh
sh ./test-seccomp-statement.sh
go vet ./front/ ./modelspec/ && go vet -tags shielddirect,bootstrapdirect ./front/
go test -count=1 ./front/ ./egress/ ./appconfig/
go test -count=1 -v ./modelspec/
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
sh ./test-domprobe-layers.sh
echo "run-go-final: PASS"
