#!/usr/bin/env bash
# Read-only: TLS+HTTP GET / against each known front, forced by --resolve; plus normal DNS. Bounded (8 s per request).
set -u
FRONTS="us-west=134.199.235.187 ca-east=146.190.246.39 ap-southeast=165.245.191.129 eu-central=134.209.248.172"
APPS="${APPS:-38f368d6 7ae476a3}"
echo "at $(date -u +%FT%TZ)"
for a in $APPS; do
  h=$a.app.enclave.host
  echo "== $h dns: $(getent ahostsv4 $h | awk '{print $1}' | sort -u | tr '\n' ' ')"
  r=$(curl -sS -o /dev/null -m 8 -w '%{http_code} ip=%{remote_ip} ssl=%{ssl_verify_result} t=%{time_total}' https://$h/ 2>&1 | tr '\n' ' ')
  echo "   normal-dns: $r"
  for f in $FRONTS; do
    n=${f%%=*}; ip=${f#*=}
    r=$(curl -sS -o /dev/null -m 8 --resolve $h:443:$ip -w '%{http_code} ssl=%{ssl_verify_result} t=%{time_total}' https://$h/ 2>&1 | tr '\n' ' ')
    echo "   $n $ip: $r"
  done
done
