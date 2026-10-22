#!/bin/bash
# READ-ONLY public DNS comparison (reviewer 9d): what each delegated front answers today, incl. the dnsdist 'control' pool
# names (_acme-challenge TXT, *.ip.enclave.host) that a G2 pin would move to the pinned host's route-dns.
for ns in 146.190.246.39 134.199.235.187; do
  for q in "app.enclave.host SOA" "app.enclave.host NS" "7ae476a3.app.enclave.host A" "custody-ca-east.app.enclave.host A" \
           "_acme-challenge.app.enclave.host TXT" "ip.enclave.host SOA" "probe-9d.ip.enclave.host A"; do
    for t in "" "+tcp"; do
      set -- $q
      out=$(dig @$ns $1 $2 +time=3 +tries=1 +norecurse $t 2>&1)
      st=$(printf '%s\n' "$out" | grep -o 'status: [A-Z]*' | head -1); [ -z "$st" ] && st="NO-ANSWER($(printf '%s' "$out" | grep -o 'timed out\|refused\|communications error' | head -1))"
      ans=$(printf '%s\n' "$out" | awk '/ANSWER SECTION/{f=1;next} /^$/{f=0} f' | awk '{print $4,$5,$6,$7}' | sort | tr '\n' ';')
      flags=$(printf '%s\n' "$out" | grep -o 'flags: [a-z ]*' | head -1)
      echo "$ns ${t:-udp} $1 $2 | $st | $flags | $ans"
    done
  done
done
