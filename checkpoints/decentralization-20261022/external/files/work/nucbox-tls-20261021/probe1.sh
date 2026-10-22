#!/usr/bin/env bash
# READ-ONLY, bounded public TLS probe of https://59f1273d.app.enclave.host (EnclaveDNS on nucbox), with two controls:
# d9798e4c (ipns-publisher, also nucbox) and 9eb4e600 (EyesOff, another host). For every address the public resolvers AND
# each authoritative nameserver give, one TLS handshake with SNI (public certificate only: subject, issuer, SAN, dates,
# chain verdict) and one HTTPS GET with full verification. 15 s per connection. No keys, no writes.
set -uo pipefail
OUT="$(dirname "$0")/probe1"; rm -rf "$OUT"; mkdir -p "$OUT"
HOSTS="59f1273d.app.enclave.host d9798e4c.app.enclave.host 9eb4e600.app.enclave.host"
echo "at $(date -u +%FT%TZ)"
echo "== NS of app.enclave.host"
NS=$(dig +short NS app.enclave.host @1.1.1.1 | sed 's/\.$//' | sort -u); echo "$NS"
for h in $HOSTS; do
  echo "=================== $h"
  ips=""
  for r in 1.1.1.1 8.8.8.8 9.9.9.9; do a=$(dig +short +time=5 +tries=1 A "$h" @$r | grep -E '^[0-9.]+$' | sort | tr '\n' ' '); echo "resolver $r: A ${a:-<none>}"; ips="$ips $a"; done
  for n in $NS; do a=$(dig +short +norec +time=5 +tries=1 A "$h" @"$n" | grep -E '^[0-9.]+$' | sort | tr '\n' ' '); s=$(dig +norec +time=5 +tries=1 A "$h" @"$n" | grep -o 'status: [A-Z]*'); echo "auth $n: ${s} A ${a:-<none>}"; ips="$ips $a"; done
  for ip in $(echo $ips | tr ' ' '\n' | sort -u); do
    f="$OUT/$h-$ip"
    timeout 15 openssl s_client -connect "$ip:443" -servername "$h" -showcerts -verify_return_error < /dev/null > "$f.sclient" 2>&1; rc=$?
    v=$(grep -m1 -E "Verify return code|verify error" "$f.sclient")
    openssl x509 -noout -subject -issuer -dates -ext subjectAltName -fingerprint -sha256 < "$f.sclient" > "$f.cert" 2>/dev/null
    timeout 15 openssl s_client -connect "$ip:443" -servername "$h" -showcerts < /dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName -fingerprint -sha256 > "$f.cert" 2>/dev/null
    c=$(curl -sS -m 15 -o /dev/null -w '%{http_code} %{http_version} ssl_verify=%{ssl_verify_result}' --resolve "$h:443:$ip" "https://$h/" 2>&1 | tail -1)
    echo "--- $ip  s_client_rc=$rc  ${v}"
    sed 's/^/      /' "$f.cert"
    echo "      curl: $c"
  done
done
echo PROBE1-DONE
