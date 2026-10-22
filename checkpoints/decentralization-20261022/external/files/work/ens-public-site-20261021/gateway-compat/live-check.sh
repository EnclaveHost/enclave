#!/usr/bin/env bash
# Bounded READ-ONLY public checks (no auth, GET/HEAD only), each with a 20 s cap: what a boxo/Rainbow/Kubo HTTP-retrieval
# client does first against the advertised provider https://ipfs.enclave.host, and what cid.contact indexed.
set -u
R=bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou
echo "at $(date -u +%FT%TZ)"
for m in HEAD GET; do
  echo "== $m probe /ipfs/bafkqaaa?format=raw (boxo connectToURL: HTTP/2 + 200/204 required)"
  curl -sS --http2 -o /tmp/gc-body.$$ -D - -X $m --max-time 20 -H 'Accept: application/vnd.ipld.raw' -w 'RESULT status=%{http_code} http_version=%{http_version} bytes=%{size_download}\n' "https://ipfs.enclave.host/ipfs/bafkqaaa?format=raw" | grep -iE '^HTTP/|^server:|^content-type:|^RESULT'
  [ $m = GET ] && echo "body: $(head -c 200 /tmp/gc-body.$$)"; rm -f /tmp/gc-body.$$
done
echo "== GET root block (Accept raw), protocol"
curl -sS --http2 -o /dev/null --max-time 20 -H 'Accept: application/vnd.ipld.raw' -w 'RESULT status=%{http_code} http_version=%{http_version} bytes=%{size_download}\n' "https://ipfs.enclave.host/ipfs/$R?format=raw"
echo "== reference: a public trustless gateway answering the same probe path"
curl -sS --http2 -o /dev/null --max-time 20 -H 'Accept: application/vnd.ipld.raw' -w 'RESULT status=%{http_code} http_version=%{http_version} bytes=%{size_download}\n' "https://trustless-gateway.link/ipfs/bafkqaaa?format=raw"
echo "== cid.contact native find (the indexed advertisement metadata)"
curl -sS --max-time 20 -H 'Accept: application/json' "https://cid.contact/cid/$R" | head -c 1500; echo
echo "== DNS ipfs.enclave.host"
getent ahostsv4 ipfs.enclave.host | awk '{print $1}' | sort -u | tr '\n' ' '; echo
