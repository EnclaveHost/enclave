#!/usr/bin/env bash
# READ-ONLY public DNS: real deployment hex labels in the ip zone + the challenge names, against ca-east (to be pinned)
# and us-west (stays), UDP and TCP. Shows what the control pool answers today.
date -u +%FT%TZ
for ns in 146.190.246.39 134.199.235.187; do for p in "" "+tcp"; do
 for q in "7ae476a3.ip.enclave.host A" "ef514ed3.ip.enclave.host A" "59f1273d.ip.enclave.host AAAA" "_minecraft._tcp.7ae476a3.ip.enclave.host SRV" "ip.enclave.host NS" "_acme-challenge.ef514ed3.app.enclave.host TXT" "_acme-challenge.7ae476a3.app.enclave.host TXT"; do
  set -- $q; r=$(dig @$ns $p +norec +time=3 +tries=1 $1 $2 2>&1); st=$(echo "$r" | grep -o "status: [A-Z]*" | head -1); an=$(echo "$r" | grep -A10 "ANSWER SECTION" | grep -v "^;" | grep -v "^$" | awk '{print $4, $5}' | tr '\n' ';'); fl=$(echo "$r" | grep -o "flags: [a-z ]*" | head -1)
  echo "$ns ${p:-udp} $1 $2 | $st | $fl | $an"; done; done; done
