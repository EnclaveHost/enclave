#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/post-rollout
timeout 60 python3 probe.py 2
echo "== ledger 0x59f1273d (read-only)"; timeout 30 node extra.mjs
echo "== EnclaveDNS public reachability"
for ip in 134.199.235.187 134.209.248.172 165.245.191.129 146.190.246.39; do echo "auth@$ip: $(timeout 6 dig +short +norecurse +time=3 +tries=1 @$ip 59f1273d.app.enclave.host A | tr '\n' ' ')"; done
timeout 15 curl --silent --show-error --max-time 12 --write-out ' -> %{http_code} %{remote_ip}\n' https://59f1273d.app.enclave.host/api/status 2>&1 | tail -c 600
