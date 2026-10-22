#!/bin/bash
# Read-only DNS: the publisher's crawl host (ad publisherUrl) and the app zone delegation, via two public resolvers.
for r in 1.1.1.1 8.8.8.8; do
  echo "@$r A d9798e4c.app.enclave.host: $(dig +short +time=5 +tries=1 @$r d9798e4c.app.enclave.host A | tr '\n' ' ') status=$(dig +time=5 +tries=1 @$r d9798e4c.app.enclave.host A | grep -o 'status: [A-Z]*')"
done
echo "NS app.enclave.host: $(dig +short +time=5 +tries=1 @1.1.1.1 app.enclave.host NS | tr '\n' ' ')"
for ns in $(dig +short +time=5 +tries=1 @1.1.1.1 app.enclave.host NS); do
  echo "  @$ns -> $(dig +short +time=4 +tries=1 @$ns d9798e4c.app.enclave.host A 2>&1 | head -2 | tr '\n' ' ')"
done
echo "cid.contact providers/12D3KooWSHx (ingest state):"
curl -sS --max-time 20 https://cid.contact/providers/12D3KooWSHxfM6L5zdmTkMh5ho8yPBB2292ug6T46BnkpCwYzoZP | python3 -c "
import json,sys
d=json.load(sys.stdin); print({k:d.get(k) for k in ('LastAdvertisement','LastAdvertisementTime','Publisher','LastError','LastErrorTime','FrozenAt')})"
