#!/usr/bin/env bash
H=sia.enclave.host
for ip in 134.199.235.187 146.190.246.39; do for path in /api/state /api/auth /; do
  echo "== GET $path via $ip $(date -u +%TZ)"; curl -sS -i --max-time 20 --resolve $H:443:$ip https://$H$path 2>&1 | grep -i -E "^HTTP|^server|^via|^content-length|^content-type" | tr -d '\r'; curl -sS --max-time 20 --resolve $H:443:$ip https://$H$path 2>&1 | head -c 160; echo
done; done
