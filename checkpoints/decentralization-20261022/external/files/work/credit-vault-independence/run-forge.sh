#!/usr/bin/env bash
# Forge suites for work/credit-vault-independence, offline inside an unshared network namespace (no RPC, no Enclave API).
#   python3 work/claude-test-queue.py --mib 512 --log <abs> -- bash <this> [all|gap|candidate|negative]
set -euo pipefail
cd "$(dirname "$0")/forge"
export PATH="$HOME/.foundry/bin:$PATH" FOUNDRY_OFFLINE=true
SUITE="${1:-all}"
case "$SUITE" in all) M=".";; gap) M="CreditVaultReserveGap";; candidate) M="CandidateReserve1271";; negative) M=".";; *) echo "usage: run-forge.sh all|gap|candidate|negative" >&2; exit 2;; esac
exec unshare -rn bash -c '
  set -uo pipefail; ip link set lo up
  forge build --sizes | grep -E "EnclaveLeaseGasReserve|EnclaveDeployments |Contract" || true
  if [ "$1" = negative ]; then
    INJECT_FAILURE=true forge test --match-test test_injectedFailure -vv; c=$?
    echo "[run-forge] negative: injected run exit=$c (must be nonzero)"; [ $c -ne 0 ] && exit 0 || exit 1
  fi
  forge test -vv --match-contract "$2"; c=$?; echo "[run-forge] suite=$1 exit=$c"; exit $c' run-forge "$SUITE" "$M"
