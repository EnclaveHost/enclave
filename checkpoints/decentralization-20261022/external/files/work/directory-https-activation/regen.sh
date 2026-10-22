#!/usr/bin/env bash
# Regenerate result/<host>.Caddyfile and patches/<host>.Caddyfile.patch from baseline/ with transform.py (deterministic).
set -euo pipefail
cd "$(dirname "$0")"
declare -A IP=([us-west]=134.199.235.187 [eu-central]=134.209.248.172 [ap-southeast]=165.245.191.129 [ca-east]=146.190.246.39)
mkdir -p result patches
for h in us-west eu-central ap-southeast ca-east; do
  rm -f result/$h.Caddyfile
  python3 transform.py baseline/$h.Caddyfile ${IP[$h]} result/$h.Caddyfile | sed "s/^/$h /"
  diff -u --label a/etc/enclave-bootstrap-tls/Caddyfile --label b/etc/enclave-bootstrap-tls/Caddyfile baseline/$h.Caddyfile result/$h.Caddyfile > patches/$h.Caddyfile.patch || [ $? -eq 1 ]
  python3 transform.py result/$h.Caddyfile ${IP[$h]} | awk -v h=$h '$1!=$2{print h" NOT idempotent"; exit 1}'
done
