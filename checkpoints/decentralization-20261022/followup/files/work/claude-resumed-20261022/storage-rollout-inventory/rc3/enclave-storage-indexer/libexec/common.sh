# shellcheck shell=bash
# Shared paths for the enclave-storage-indexer scripts. Overridable ONLY for tests (ESI_TEST_ROOT), never in units.
set -euo pipefail
ROOT=${ESI_TEST_ROOT:-}
ETC=$ROOT/etc/enclave-storage-indexer
VAR=$ROOT/var/lib/enclave-storage-indexer
RUN=$ROOT/run/enclave-storage-indexer
PKG=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
die() { echo "enclave-storage-indexer: $*" >&2; exit 1; }
replica_name() {
  local r=${1:-}
  [[ "$r" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || die "replica name must match [a-z0-9][a-z0-9-]{0,30}: '$r'"
  printf '%s' "$r"
}
load_env() { # load_env <r>: the non-secret replica.env, strictly KEY=VALUE with known keys only
  local f=$ETC/$1/replica.env line k
  [ -f "$f" ] || die "missing $f"
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^(REPLICA|ADVERTISE_URL|ENCLAVE_HOST_ID|FAILURE_DOMAIN_SITE|FAILURE_DOMAIN_PROVIDER|FAILURE_DOMAIN_POWER|PG_BIN|ENCLAVE_HOST_SOFTWARE)=([^\`\$\;]*)$ ]] \
      || die "replica.env: unexpected line: ${line%%=*}"
    k=${BASH_REMATCH[1]}; printf -v "$k" '%s' "${BASH_REMATCH[2]}"; export "${k?}"
  done < "$f"
  [ "${REPLICA:-}" = "$1" ] || die "replica.env REPLICA must equal $1"
}
