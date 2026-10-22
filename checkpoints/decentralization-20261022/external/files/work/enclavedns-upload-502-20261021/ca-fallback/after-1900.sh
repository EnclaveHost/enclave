#!/usr/bin/env bash
# READ-ONLY: relay [certs] lines since 19:00Z (ef514ed3 / CA lines) + the public TLS certificate ef514ed3.app.enclave.host
# presents through each routed front (issuer, subject, validity, verify result) - one handshake per front, no HTTP request.
cd /home/steven/Documents/Codex/2026-10-18/wo
date -u +%FT%TZ
timeout 60 ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 \
 "sudo journalctl -u enclave-api-relay.service --since '2026-10-21 19:00:00 UTC' -o short-iso --no-pager 2>/dev/null | grep -F '[certs]' | cut -c1-300"
for ip in $(dig +short A ef514ed3.app.enclave.host @1.1.1.1); do
  echo "== front $ip"
  echo | timeout 20 openssl s_client -connect $ip:443 -servername ef514ed3.app.enclave.host -verify_return_error 2>&1 \
    | grep -E "^(subject|issuer)=|Verify return code|verify error|notAfter|NotAfter" | head -5
  echo | timeout 20 openssl s_client -connect $ip:443 -servername ef514ed3.app.enclave.host 2>/dev/null | openssl x509 -noout -issuer -subject -dates 2>/dev/null
done
