#!/bin/bash
# READ-ONLY public acceptance after the discovery repair (root runs it; queue 512, ~1-12 min):
#   python3 ../../claude-test-queue.py --mib 512 --log accept-after.guard.log -- bash accept-after.sh > accept-after.out 2>&1
# 1 the publisher's crawl host resolves; 2 its IPNI status lists all 487 blocks; 3 cid.contact ingested a NEW ad;
# 4 cid.contact names the provider for child CIDs (css/, site.css, js/, boot.js, a chunk, favicon);
# 5 eth.link + eth.limo serve every first-paint resource of index.html with the export's exact sha256.
# Exit 0 only when all pass. Does not sign, write or log in anywhere.
cd "$(dirname "$0")"
OLD_AD=bafyreie4ho4j4uw3rfh4socqoa2e5u5jefxur3nbjl27lekdssvezyoifi     # root-only ad, 2026-10-20T01:41:22Z
PEER=12D3KooWSHxfM6L5zdmTkMh5ho8yPBB2292ug6T46BnkpCwYzoZP
fail=0; bad() { echo "FAIL: $*"; fail=1; }
a=$(dig +short +time=5 +tries=1 @1.1.1.1 d9798e4c.app.enclave.host A | head -1); echo "1 publisher host A: ${a:-none}"; [ -n "$a" ] || bad "d9798e4c.app.enclave.host does not resolve (cid.contact cannot crawl the ad)"
curl -sS --max-time 20 https://d9798e4c.app.enclave.host/api/status | python3 -c "
import json,sys
try: i=json.load(sys.stdin).get('ipni') or {}
except Exception: i={}
print('2 publisher ipni:', json.dumps(i)); sys.exit(0 if i.get('blocks')==487 and i.get('root')=='bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou' else 1)" || bad "publisher does not report 487 advertised blocks for the root"
curl -sS --max-time 20 "https://cid.contact/providers/$PEER" | python3 -c "
import json,sys
d=json.load(sys.stdin); ad=(d.get('LastAdvertisement') or {}).get('/'); print('3 cid.contact last ad:', ad, d.get('LastAdvertisementTime'), 'error:', d.get('LastError'))
sys.exit(0 if ad and ad!='$OLD_AD' else 1)" || bad "cid.contact has not ingested a new advertisement"
for c in bafybeic4uud6xvpuzjrrsrhocxykkleg2vjas6mgw476dbdbz3kkzibbce bafkreiahsauynipsbgmrp7l5s2t32vmsiaggnj7ffbqnvcwlmmz5pcuila bafybeicvfvn6ckjio7wm6uk5ka76t5qbuykvr5zk6gf6bvvpuergegazjy bafkreihr5ejfzmgf32tqlhowznubg4zqpc4pz3zj3zatp3eewz376lgqj4 $(python3 -c "
import json;M={f['path']:f['cid'] for f in json.load(open('../content/export/files-manifest.json'))['files']};print(M['js/chunks/chunk-TPYLZMII.js'],M['favicon.ico'])"); do
  n=$(curl -sS --max-time 20 -H 'Accept: application/json' "https://cid.contact/cid/$c" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(0); sys.exit()
print(sum(1 for r in d.get('MultihashResults',[]) for p in r.get('ProviderResults',[]) if p.get('Provider',{}).get('ID')=='$PEER'))")
  echo "4 cid.contact $c: provider records $n"; [ "$n" -ge 1 ] || bad "no provider record for $c"
done
paths=$(awk '$2=="IN_EXPORT"{print $1}' firstpaint.txt | tr '\n' ' ')
for g in https://enclavehost.eth.link https://enclavehost.eth.limo; do
  out=accept-$(echo "$g" | sed 's#https://##').json
  python3 probe.py "$g" "$out" "" $paths apps develop | sed "s#^#5 $g #"
  python3 -c "
import json,sys; r=json.load(open('$out'))['results']; bad=[x['path'] or '/' for x in r if not x['match']]
print('5', '$g', len(r)-len(bad), '/', len(r), 'exact'); sys.exit(1 if bad else 0)" || bad "$g: not every first-paint resource is exact"
done
[ $fail = 0 ] && echo "PUBLIC ACCEPT PASS" || echo "PUBLIC ACCEPT FAIL"; exit $fail
