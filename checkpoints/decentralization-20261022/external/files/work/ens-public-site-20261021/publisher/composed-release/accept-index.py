#!/usr/bin/env python3
"""READ-ONLY phase B of accept-release.sh: discovery. ALWAYS emits exactly the gates I1 I2 I3 (a failed read fails its
gate with an error, it never drops it). Sequential, every request bounded (dig 5 s, HTTP 20 s).
  I1 the publisher's crawl host resolves (cid.contact must reach it)
  I2 cid.contact's last advertisement from the peer == the publisher's current IPNI head (accept-gates.json ipniHead)
  I3 cid.contact names the peer as provider for the site ROOT and the six representative first-paint children
     (css/, css/site.css, js/, js/boot.js, a chunk, favicon.ico: the same CIDs public-assets/accept-after.sh checks)
Usage: accept-index.py <accept-gates.json>  > accept-index.json   (exit 0 = all pass)"""
import ipaddress, json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
PEER = '12D3KooWSHxfM6L5zdmTkMh5ho8yPBB2292ug6T46BnkpCwYzoZP'
HOST = 'd9798e4c.app.enclave.host'
INDEXER = 'https://cid.contact'
import importlib.util
_spec = importlib.util.spec_from_file_location('accept_decide', os.path.join(HERE, 'accept-decide.py'))
_dec = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_dec)
CIDS = _dec.index_cids()   # one source for the CID set I3 checks and accept-decide.py validates
out = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'gates': {}}
def gate(i, ok, **d): out['gates'][i] = {'pass': ok is True, **d}
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json'}), timeout=20) as r:
        if r.status != 200: raise RuntimeError(f'HTTP {r.status}')
        return json.loads(r.read())
try:
    a = subprocess.run(['dig', '+short', '+time=5', '+tries=1', '@1.1.1.1', HOST, 'A'], capture_output=True, text=True, timeout=15).stdout.split()
    ips = [x for x in a if all(c.isdigit() or c == '.' for c in x)]
    ok = bool(ips) and all(ipaddress.ip_address(x).is_global for x in ips)
    gate('I1', ok, host=HOST, a=ips)
except Exception as e: gate('I1', False, error=str(e)[:200])
try:
    head = json.load(open(sys.argv[1])).get('ipniHead')
    d = get(f'{INDEXER}/providers/{PEER}')
    ad = (d.get('LastAdvertisement') or {}).get('/')
    gate('I2', isinstance(head, str) and bool(head) and ad == head, lastAdvertisement=ad, lastAdvertisementTime=d.get('LastAdvertisementTime'),
         lastError=d.get('LastError'), publisherHead=head)
except Exception as e: gate('I2', False, error=str(e)[:200])
counts, errors = {}, {}
for k, c in CIDS.items():
    try:
        d = get(f'{INDEXER}/cid/{c}')
        counts[k] = sum(1 for r in d.get('MultihashResults', []) for p in r.get('ProviderResults', []) if (p.get('Provider') or {}).get('ID') == PEER)
    except Exception as e: counts[k] = 0; errors[k] = str(e)[:120]
gate('I3', set(counts) == set(CIDS) and all(n >= 1 for n in counts.values()), providerRecords=counts, cids=CIDS, errors=errors)
out['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
out['pass'] = all(out['gates'].get(i, {}).get('pass') is True for i in ('I1', 'I2', 'I3'))
print(json.dumps(out, indent=1)); sys.exit(0 if out['pass'] else 1)
