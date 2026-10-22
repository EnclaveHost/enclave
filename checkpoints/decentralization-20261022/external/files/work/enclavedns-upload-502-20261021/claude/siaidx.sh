#!/usr/bin/env bash
# READ-ONLY: is the indexer sia-s3 depends on reachable? DNS + one unauthenticated GET (expect an auth refusal = reachable).
H=sia.enclave.host
echo "dns A: $(dig +short +time=3 +tries=1 $H A | tr '\n' ' ') AAAA: $(dig +short +time=3 +tries=1 $H AAAA | tr '\n' ' ')"
for ip in $(dig +short +time=3 +tries=1 $H A | grep -E '^[0-9.]+$'); do
  echo "== GET /api/state via $ip $(date -u +%TZ)"; curl -sS -o /dev/null --max-time 20 --resolve $H:443:$ip -w '  -> code=%{http_code} verify=%{ssl_verify_result} tls=%{time_appconnect} total=%{time_total}\n' https://$H/api/state 2>&1 | tail -2
done
