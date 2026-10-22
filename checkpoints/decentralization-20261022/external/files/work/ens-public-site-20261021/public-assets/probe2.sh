#!/bin/bash
# Read-only. (1) the advertised HTTP provider (public DNS ipfs.enclave.host) for every block on the css/js paths, raw, h2;
# (2) cid.contact provider records for those CIDs; (3) one eth.limo request for / and css/site.css each.
R=bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou
CSSD=bafybeic4uud6xvpuzjrrsrhocxykkleg2vjas6mgw476dbdbz3kkzibbce; CSS=bafkreiahsauynipsbgmrp7l5s2t32vmsiaggnj7ffbqnvcwlmmz5pcuila
JSD=bafybeicvfvn6ckjio7wm6uk5ka76t5qbuykvr5zk6gf6bvvpuergegazjy; BOOT=bafkreihr5ejfzmgf32tqlhowznubg4zqpc4pz3zj3zatp3eewz376lgqj4
IDX=bafkreih6jphyfe2ustt2byckoodtngsv4o5pcm3va45gujfmpuxac3hwfu
echo "== provider ipfs.enclave.host (public DNS: $(getent ahostsv4 ipfs.enclave.host | awk '{print $1}' | sort -u | tr '\n' ' '))"
for c in $R $CSSD $CSS $JSD $BOOT $IDX; do
  for i in 1 2; do  # twice: DNS round-robin spreads over fronts
    curl -sS --http2 --max-time 20 -o >(sha256sum | cut -c1-16 > /tmp/pa.$$) -w "%{http_code} h%{http_version} %{size_download}B %{content_type} ip=%{remote_ip}" -H 'Accept: application/vnd.ipld.raw' "https://ipfs.enclave.host/ipfs/$c?format=raw"; sleep 0.3; echo " sha=$(cat /tmp/pa.$$) $c"
  done
done; rm -f /tmp/pa.$$
echo "== cid.contact"
for c in $R $CSSD $CSS $IDX; do
  curl -sS --max-time 20 -H 'Accept: application/json' "https://cid.contact/cid/$c" -o /tmp/pa.cc.$$ -w "%{http_code} "; python3 -c "
import json,sys
try: d=json.load(open('/tmp/pa.cc.$$'))
except Exception: print('non-json'); sys.exit()
ps=[(p.get('Provider',{}).get('ID','')[:16], p.get('Provider',{}).get('Addrs'), p.get('Metadata')) for r in d.get('MultihashResults',[]) for p in r.get('ProviderResults',[])]
print(len(ps), ps[:3])"; echo "  $c"
done; rm -f /tmp/pa.cc.$$
echo "== delegated-ipfs.dev routing/v1 providers"
for c in $R $CSS; do curl -sS --max-time 25 -H 'Accept: application/json' "https://delegated-ipfs.dev/routing/v1/providers/$c" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('non-json'); sys.exit()
print(len(d.get('Providers') or []), [(p.get('ID','')[:16], p.get('Addrs'), p.get('Protocols')) for p in (d.get('Providers') or [])][:4])"; echo "  $c"; done
