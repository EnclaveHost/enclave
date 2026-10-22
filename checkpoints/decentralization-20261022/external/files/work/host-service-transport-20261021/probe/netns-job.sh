#!/bin/bash
# Real-kernel host-service e2e (tree/test/netns/host-service-e2e.sh) in a private user+network namespace: no root, no host
# network change. enclave-wg = probe/bin/enclave-wg (built from the tree by go-job.sh, c13494ec...).
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
sha256sum "$H/probe/bin/enclave-wg"
unshare -r -n -- bash "$H/tree/test/netns/host-service-e2e.sh" "$H/probe/bin/enclave-wg"
rc=$?; echo "E2E-RC=$rc"; exit $rc
