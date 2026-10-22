#!/usr/bin/env bash
# READ-ONLY DNS/HTTPS probe after the EnclaveDNS 0.1.5 upgrade of deployment 59f1273d. Compares the local EnclaveDNS client
# (127.0.0.1 / ::1) with public recursive resolvers and each authoritative nameserver of app.enclave.host, for 59f1273d and the
# working control 9eb4e600. Public queries and public HTTPS GETs only; TLS verification stays ON (no -k). No writes, no
# restarts, no secrets (config is not read here). Every command bounded by a timeout.
set -uo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)/probe1-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$OUT"
LABELS="59f1273d.app.enclave.host 9eb4e600.app.enclave.host"
log() { echo "[$(date -u +%FT%T.%3NZ)] $*"; }
run() { local f="$1"; shift; { echo "# at $(date -u +%FT%T.%3NZ): $*"; timeout 25 "$@" 2>&1; echo "# rc=$?"; } > "$OUT/$f"; }
log "out $OUT"
run resolv.conf cat /etc/resolv.conf
run enclavedns-status enclavedns status
run enclavedns-version enclavedns version
for h in $LABELS example.com api.enclave.host; do
  run "local4-$h" dig +time=5 +tries=1 A "$h" @127.0.0.1
  run "local6-$h" dig +time=5 +tries=1 A "$h" @::1
  run "enclavedns-query-$h" enclavedns query "$h" A
done
run ns-q9 dig +time=5 +tries=1 NS app.enclave.host @9.9.9.9
run ns-cf dig +time=5 +tries=1 NS app.enclave.host @1.1.1.1
run ns-parent dig +time=5 +tries=1 +norec NS app.enclave.host @"$(dig +short NS enclave.host @9.9.9.9 | head -1)"
NS=$(dig +short +time=5 +tries=1 NS app.enclave.host @9.9.9.9 | sed 's/\.$//' | sort -u)
log "NS: $(echo $NS)"
for n in $NS; do
  ip=$(dig +short +time=5 +tries=1 A "$n" @9.9.9.9 | grep -E '^[0-9.]+$' | head -1)
  echo "$n $ip" >> "$OUT/ns-addresses"
  for h in $LABELS; do
    run "auth-$n-$ip-A-$h" dig +norec +time=5 +tries=1 A "$h" @"$ip"
    run "auth-$n-$ip-AAAA-$h" dig +norec +time=5 +tries=1 AAAA "$h" @"$ip"
  done
done
for r in 1.1.1.1 8.8.8.8 9.9.9.9; do for h in $LABELS; do run "rec-$r-$h" dig +dnssec +time=5 +tries=1 A "$h" @$r; done; done
# the public route map (relay), reached at an address an independent resolver gives, full TLS verification
api=$(dig +short +time=5 +tries=1 A api.enclave.host @9.9.9.9 | grep -E '^[0-9.]+$' | head -1)
run routes-headers curl -sS -m 20 -D - -o "$OUT/routes.json" --resolve "api.enclave.host:443:$api" https://api.enclave.host/v1/network/routes
for h in $LABELS; do
  # reproduce root's failing call through this machine's resolver
  run "curl-system-$h" curl -sS -m 20 -o /dev/null -w 'http=%{http_code} ip=%{remote_ip} verify=%{ssl_verify_result}\n' "https://$h/api/status"
  for ip in $(cat "$OUT"/auth-*-A-"$h" | awk '$4=="A"{print $5}' | sort -u); do
    run "curl-auth-$ip-$h" curl -sS -m 20 -D - -o "$OUT/body-$ip-$h" -w '\nhttp=%{http_code} verify=%{ssl_verify_result}\n' --resolve "$h:443:$ip" "https://$h/api/status"
    run "cert-$ip-$h" bash -c "openssl s_client -connect $ip:443 -servername $h -verify_return_error </dev/null 2>&1 | grep -E 'Verify return code|verify error|subject=|issuer=' ; openssl s_client -connect $ip:443 -servername $h </dev/null 2>/dev/null | openssl x509 -noout -dates -ext subjectAltName"
  done
done
log PROBE1-DONE
