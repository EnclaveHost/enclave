#!/usr/bin/env bash
set -u
/usr/sbin/dig @1.1.1.1 +time=3 +tries=1 59f1273d.app.enclave.host A
for ip in 134.209.248.172 165.245.191.129 146.190.246.39; do
 curl --silent --show-error --max-time 12 --resolve "59f1273d.app.enclave.host:443:$ip" --write-out "\npeer=$ip http=%{http_code}\n" https://59f1273d.app.enclave.host/healthz
done
