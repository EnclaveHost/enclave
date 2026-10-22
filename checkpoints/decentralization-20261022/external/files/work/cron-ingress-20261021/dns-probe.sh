#!/usr/bin/env bash
set -u
echo "at $(date -u +%FT%TZ)"
for z in app.enclave.host enclave.host; do echo "NS $z: $(dig +short +time=3 +tries=1 NS $z | tr '\n' ' ')"; done
for ns in $(dig +short +time=3 +tries=1 NS app.enclave.host); do
  for a in 38f368d6 7ae476a3; do echo "@$ns $a: $(dig +norecurse +time=3 +tries=1 @$ns $a.app.enclave.host A | grep -E '^[0-9a-f]{8}\.app' | awk '{print $2, $5}' | tr '\n' ' ')"; done
done
for r in 1.1.1.1 8.8.8.8 9.9.9.9; do echo "@$r 38f368d6: $(dig +time=3 +tries=1 @$r 38f368d6.app.enclave.host A | grep -E '^38f368d6' | awk '{print $2, $5}' | tr '\n' ' ')"; done
echo "local resolver: $(dig +time=3 +tries=1 38f368d6.app.enclave.host A | grep -E '^38f368d6' | awk '{print $2, $5}' | tr '\n' ' ')"
