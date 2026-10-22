#!/usr/bin/env bash
# READ-ONLY time series: every 60 s for 8 samples, the public route map entry for 59f1273d and the four authoritative answers
# for 59f1273d / 9eb4e600 (+norec), with timestamps. Public GET/DNS only, TLS verification on.
cd "$(dirname "$0")"; OUT=series-$(date -u +%Y%m%dT%H%M%SZ).log
api=$(dig +short +time=5 +tries=1 A api.enclave.host @9.9.9.9 | grep -E '^[0-9.]+$' | head -1)
for i in 1 2 3 4 5 6 7 8; do
  t=$(date -u +%FT%TZ)
  rm=$(timeout 25 curl -sS -m 20 --resolve "api.enclave.host:443:$api" https://api.enclave.host/v1/network/routes | python3 -c 'import json,sys
d=json.load(sys.stdin); p=[x["reason"] for x in d.get("pending",[]) if x["id"].startswith("0x59f1273d")]
print("updatedAt",d.get("updatedAt"),"labels",len(d["labels"]),"59f1273d", "LABEL" if "59f1273d" in d["labels"] else ("PENDING:"+",".join(p) if p else "ABSENT"))' 2>&1)
  a=""; for ip in 134.199.235.187 146.190.246.39 165.245.191.129 134.209.248.172; do for h in 59f1273d 9eb4e600; do
    s=$(dig +norec +time=5 +tries=1 A $h.app.enclave.host @$ip | grep -oE 'status: [A-Z]+' | cut -d' ' -f2); a="$a $ip/$h=$s"; done; done
  echo "$t route: $rm | auth:$a" | tee -a "$OUT"
  [ $i -lt 8 ] && sleep 60
done
echo SERIES-DONE | tee -a "$OUT"
