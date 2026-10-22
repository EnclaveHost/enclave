#!/bin/bash
# Read-only: the fronts' block route over HTTP/1.1 (what the publisher's webreq client speaks), and the publisher's public status.
for c in bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou bafybeic4uud6xvpuzjrrsrhocxykkleg2vjas6mgw476dbdbz3kkzibbce bafybeidol5icrytwuclwokcjoxjenwxsqhdiwsj2szlchoosyusqvs7qva; do
  curl -sS --http1.1 --max-time 20 -o /tmp/p6.$$ -w "%{http_code} h%{http_version} %{size_download}B ip=%{remote_ip}" -H 'Accept: application/vnd.ipld.raw' "https://ipfs.enclave.host/ipfs/$c?format=raw"; echo " sha=$(sha256sum /tmp/p6.$$ | cut -c1-16) $c"
done; rm -f /tmp/p6.$$
echo "== publisher status (ipni part only)"
curl -sS --max-time 20 https://d9798e4c.app.enclave.host/api/status -w '\nHTTP %{http_code}\n' | python3 -c "
import json,sys
raw=sys.stdin.read(); body,_,code=raw.rpartition('\nHTTP ')
try: d=json.loads(body); print('HTTP',code.strip(),'ipni=',json.dumps(d.get('ipni')),'sequence=',d.get('sequence'),'value=',d.get('value'),'lastError=',d.get('lastError'))
except Exception as e: print('HTTP',code.strip(),'non-json',body[:120])"
