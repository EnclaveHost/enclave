#!/usr/bin/env bash
# READ-ONLY: sia-s3's public status page JSON (no auth; the page's own unsigned status call). Bucket listings are not requested.
H=ef514ed3.app.enclave.host
for ip in 134.209.248.172 146.190.246.39; do echo "== /api/status via $ip $(date -u +%TZ)"; curl -sS --max-time 30 --resolve $H:443:$ip -w '\n  -> code=%{http_code} total=%{time_total}\n' https://$H/api/status | head -c 4000; echo; done
