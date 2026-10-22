#!/usr/bin/env bash
# m2 front/egress/appconfig (existing suites + the encvol wiring and the Shield-partition plane test), init's suites,
# and the Hyper-V partition path (monitor staging, secretrun, domexec in namespaces with mutants) (immutable; v2).
# guestd needs the whole repository (ipfs_fetch, the supervisor seam): it runs in run-overlay-v1.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
(cd "$here/tree/isolation/m2" && go test -count=1 ./front/ ./egress/ ./appconfig/)
(cd "$here/tree/isolation/m2" && go test -count=1 -tags shielddirect,bootstrapdirect ./front/)
(cd "$here/tree/isolation/m2" && sh ./test-dominit-handoff.sh && sh ./test-dominit-hardening.sh && sh ./test-seccomp-statement.sh)
(cd "$here/tree/isolation/m3" && go vet ./monitor/ ./secretrun/ && go test -count=1 ./monitor/ ./secretrun/)
(cd "$here/tree/isolation/m3" && sh ./test-domexec-encvol.sh && sh ./test-domexec-frontuid.sh && sh ./test-domexec-seccomp.sh)
echo "run-go-misc-v2: PASS"
