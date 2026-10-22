#!/usr/bin/env bash
# READ-ONLY: sia-s3's unauthenticated /healthz (counts and per-indexer state only) via its public label, both route addresses.
H=ef514ed3.app.enclave.host
for ip in $(dig +short +time=3 +tries=1 $H A) ; do
  echo "== /healthz via $ip $(date -u +%TZ)"; curl -sS --max-time 25 --resolve $H:443:$ip -w '\n  -> code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total}\n' https://$H/healthz | head -c 3000; echo
done
