#!/usr/bin/env bash
# READ-ONLY: what 7ae476a3.app.enclave.host and ipfs.enclave.host resolve to (public DNS), then ONE GET /healthz to the app
# through EACH front's address (SNI passthrough to the minipc circuit). Status, curl exit and timings only.
date -u +%FT%TZ
for n in 7ae476a3.app.enclave.host ipfs.enclave.host; do echo "dns $n: $(dig +short A $n @1.1.1.1 | sort | tr '\n' ' ')"; done
for ip in 134.209.248.172 134.199.235.187 165.245.191.129 146.190.246.39; do
  printf 'front %s ' $ip; curl -sS -o /dev/null --max-time 20 --resolve 7ae476a3.app.enclave.host:443:$ip -w 'code=%{http_code} tls=%{time_appconnect} total=%{time_total}' https://7ae476a3.app.enclave.host/healthz 2>&1 | tr '\n' ' '; echo " exit=$?"
done
