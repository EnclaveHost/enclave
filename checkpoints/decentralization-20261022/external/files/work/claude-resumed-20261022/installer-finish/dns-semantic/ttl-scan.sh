#!/usr/bin/env bash
# READ-ONLY: authoritative TTLs of short-TTL candidates (one +norec query each), to pick test names for the TTL-lapse check.
for n in 9eb4e600 ef514ed3 c13d4b6a a69dcbba e64f7cba; do echo "app $n: $(dig +norec +time=5 +tries=1 A $n.app.enclave.host @ns-us-west.enclave.host | awk '$4=="A"{print $2, $5}' | tr '\n' ' ')"; done
for n in ns-us-west.enclave.host api.enclave.host; do echo "$n: $(dig +time=5 +tries=1 A $n @9.9.9.9 | awk '$4=="A"{print $2, $5}' | tr '\n' ' ')"; done
for n in x$RANDOM.localtest.me x$RANDOM.lvh.me x$RANDOM.traefik.me 127-0-0-9.traefik.me; do echo "$n: $(dig +time=5 +tries=1 A $n @1.1.1.1 | awk '$4=="A"||$4=="CNAME"{print $2, $5}' | tr '\n' ' ')"; done
