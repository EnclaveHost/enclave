#!/usr/bin/env bash
# READ-ONLY final check: local client status, local vs public recursive answers, and root's exact failing call (TLS verify on).
cd "$(dirname "$0")"; OUT=probe3-$(date -u +%Y%m%dT%H%M%SZ).log
{ echo "at $(date -u +%FT%T.%3NZ)"; timeout 20 enclavedns status
for r in 127.0.0.1 ::1 1.1.1.1 8.8.8.8 9.9.9.9; do for h in 59f1273d 9eb4e600; do echo "$r $h: $(dig +time=5 +tries=1 A $h.app.enclave.host @$r | grep -oE 'status: [A-Z]+') $(dig +short +time=5 +tries=1 A $h.app.enclave.host @$r | tr '\n' ' ')"; done; done
echo "root-call: $(timeout 25 curl -sS -m 20 -o /tmp/claude-1000/p3body -w 'http=%{http_code} ip=%{remote_ip} verify=%{ssl_verify_result}' https://59f1273d.app.enclave.host/api/status 2>&1; echo " rc=$?")"
python3 -c 'import json;d=json.load(open("/tmp/claude-1000/p3body"));print("status keys",sorted(d)); print("version", d.get("version"), "uptime", d.get("uptime_s", d.get("uptime")))' 2>&1
echo "at $(date -u +%FT%T.%3NZ)"; } > "$OUT" 2>&1; cat "$OUT"
