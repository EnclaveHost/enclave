#!/usr/bin/env python3
"""The ONLY place accept-release.sh's verdicts are made. Fail closed: a phase is "ok" only when its process exited cleanly,
its JSON parses, it carries EXACTLY the expected gates (or routes) and every one of them passed. "retry" is returned for
exactly two VALIDATED cache-lag shapes, never for a timeout, a transport error, a parse error or missing data:
  A  only R1 failed, and the delegated record is a VALID older record of the same name (status 200, signature verified,
     unexpired, the site value, sequence >= 1026) that is older than the publisher's newly signed one (lower sequence, or
     the same sequence with an earlier validity): the router's cached copy (record TTL 300 s)
  GW every route got a complete HTTP response (status 100-599, no curl error) and some are not the export's exact bytes:
     a gateway serving its cached answer (eth.limo/eth.link max-age=300)
CLI (exit 0 ok, 2 retry, 1 fail; one JSON line on stdout):
  accept-decide.py A  <accept-gates.json> <rc>
  accept-decide.py B  <accept-index.json> <rc>
  accept-decide.py GW <probe.json> <rc> <gateway-base-url>
  accept-decide.py routes                       (the exact gateway route list, one per line; the first is "" = /)
  accept-decide.py final <A> <B> <GW1> <GW2>     (states ok|retry|fail|skipped -> PASS 0 | RETRY-ONCE 2 | FAIL 1)"""
import hashlib, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
VALUE = '/ipfs/bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou'
GATES_A = ('C1', 'C2', 'P1', 'P2', 'P3', 'R1')
GATES_B = ('I1', 'I2', 'I3')
FIRSTPAINT = os.path.join(HERE, '../../public-assets/firstpaint.txt')
FIRSTPAINT_SHA = 'ac8e0db753652bbc963c9fb6de7268559734ef340c900848b921ebe431d1530c'
GATEWAYS = ('https://enclavehost.eth.link', 'https://enclavehost.eth.limo')
MANIFEST = os.path.join(HERE, '../../content/export/files-manifest.json')       # the frozen, verified site export
MANIFEST_SHA = '119d7351f798237256718b9e8b30ada0abb7ecee9034284e694655612fee4b2f'
HEX64 = re.compile(r'^[0-9a-f]{64}$')

def _manifest():
    raw = open(MANIFEST, 'rb').read()
    if hashlib.sha256(raw).hexdigest() != MANIFEST_SHA: raise SystemExit('files-manifest.json is not the pinned export manifest')
    return {f['path']: f for f in json.loads(raw)['files']}

def trusted_expected(M, route):
    """The export file a gateway route must serve, by probe.py's own mapping: / -> index.html, a directory -> its
    index.html, an extensionless page -> <page>.html (the site's _redirects rewrite). From the pinned manifest only."""
    k = route.split('?')[0] or 'index.html'
    f = M.get(k) or M.get(k.rstrip('/') + '/index.html') or M.get(k + '.html')
    return f and {'bytes': f['bytes'], 'sha256': f['sha256'], 'cid': f['cid']}

def index_cids():
    """The CIDs whose provider records I3 requires: the root + the six children public-assets/accept-after.sh checks."""
    M = _manifest()
    return {'root': 'bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou',
            'css/': 'bafybeic4uud6xvpuzjrrsrhocxykkleg2vjas6mgw476dbdbz3kkzibbce', 'css/site.css': 'bafkreiahsauynipsbgmrp7l5s2t32vmsiaggnj7ffbqnvcwlmmz5pcuila',
            'js/': 'bafybeicvfvn6ckjio7wm6uk5ka76t5qbuykvr5zk6gf6bvvpuergegazjy', 'js/boot.js': 'bafkreihr5ejfzmgf32tqlhowznubg4zqpc4pz3zj3zatp3eewz376lgqj4',
            'js/chunks/chunk-TPYLZMII.js': M['js/chunks/chunk-TPYLZMII.js']['cid'], 'favicon.ico': M['favicon.ico']['cid']}

def routes():
    """index.html + every first-paint resource and navigation page of the verified export (firstpaint.txt, pinned)."""
    raw = open(FIRSTPAINT, 'rb').read()
    if hashlib.sha256(raw).hexdigest() != FIRSTPAINT_SHA: raise SystemExit('firstpaint.txt is not the pinned file')
    rs = [''] + [l.split()[0] for l in raw.decode().splitlines() if l.split()[1:2] in (['IN_EXPORT'], ['IN_EXPORT_HTML'])]
    assert len(rs) == len(set(rs)) and len(rs) > 1
    M = _manifest()
    if any(not trusted_expected(M, r) for r in rs): raise SystemExit('a route has no file in the pinned export manifest')
    if trusted_expected(M, '')['sha256'] != M['index.html']['sha256']: raise SystemExit('/ does not map to index.html')
    return rs

def _load(path, rc, ok_rcs):
    if rc not in ok_rcs: return None, f'process exit {rc} (timeout/crash: fail closed)'
    try: return json.load(open(path)), None
    except FileNotFoundError: return None, 'no output file'
    except Exception as e: return None, f'invalid JSON: {str(e)[:80]}'

def _gates(obj, expected, rc):
    g = obj.get('gates') if isinstance(obj, dict) else None
    if not isinstance(g, dict): return None, 'no gates object'
    if set(g) != set(expected): return None, f'gate set {sorted(g)} != expected {list(expected)}'
    if not all(isinstance(g[k], dict) and isinstance(g[k].get('pass'), bool) for k in expected): return None, 'a gate has no boolean pass'
    allpass = all(g[k]['pass'] for k in expected)
    if (rc == 0) != allpass: return None, f'exit {rc} contradicts the gates (all pass = {allpass})'
    return g, None

def _int(x): return x if isinstance(x, int) and not isinstance(x, bool) else None

def stale_record(r):
    """R1 detail -> True only for a VALID record of the site value that is OLDER than the publisher's new one."""
    if 'error' in r: return False
    s, v, ps, pv = (_int(r.get(k)) for k in ('sequence', 'validityUnix', 'publisherSequence', 'publisherValidUntilUnix'))
    if None in (s, v, ps, pv): return False
    valid = r.get('status') == 200 and r.get('signatureV2Valid') is True and r.get('expired') is False \
        and r.get('v1ValueMatchesV2') is not False and r.get('value') == VALUE and s >= 1026
    return valid and (s < ps or (s == ps and v < pv))

def decide_A(path, rc):
    obj, err = _load(path, rc, (0, 1))
    if err: return 'fail', [err]
    g, err = _gates(obj, GATES_A, rc)
    if err: return 'fail', [err]
    bad = [k for k in GATES_A if not g[k]['pass']]
    if not bad: return 'ok', []
    if bad == ['R1'] and stale_record(g['R1']): return 'retry', ['R1: the delegated router still serves the valid previous record (cache lag)']
    return 'fail', [f'{k} failed: {g[k].get("error") or g[k].get("title", "")}' for k in bad]

def decide_B(path, rc):
    obj, err = _load(path, rc, (0, 1))
    if err: return 'fail', [err]
    g, err = _gates(obj, GATES_B, rc)
    if err: return 'fail', [err]
    want = index_cids(); i3 = g['I3']
    if i3.get('cids') != want or set((i3.get('providerRecords') or {})) != set(want): return 'fail', ['I3 is not over exactly the expected CIDs']
    if i3['pass'] and not all((_int(n) or 0) >= 1 for n in i3['providerRecords'].values()): return 'fail', ['I3 passed with a missing provider record']
    bad = [k for k in GATES_B if not g[k]['pass']]
    return ('fail', [f'{k} failed: {g[k].get("error", "")}' for k in bad]) if bad else ('ok', [])

def decide_GW(path, rc, base):
    if base not in GATEWAYS: return 'fail', [f'unknown gateway {base}']
    obj, err = _load(path, rc, (0,))
    if err: return 'fail', [err]
    res = obj.get('results') if isinstance(obj, dict) else None
    if not isinstance(res, list) or not res: return 'fail', ['no results']
    if obj.get('base') != base: return 'fail', [f'results are for {obj.get("base")}, not {base}']
    want = routes()
    if [r.get('path') if isinstance(r, dict) else None for r in res] != want: return 'fail', ['route list is not exactly the expected one']
    M = _manifest()
    incomplete, mismatch = [], []
    for r in res:
        # every expectation comes from the pinned manifest; the row's own "expected" must merely agree with it
        trust, st, got = trusted_expected(M, r['path']), _int(r.get('status')), r.get('sha256')
        if st is None or not (100 <= st <= 599) or r.get('curlErr') or not isinstance(r.get('match'), bool) \
                or not isinstance(got, str) or not HEX64.match(got) or r.get('expected') != trust:
            incomplete.append(r.get('path') or '/'); continue
        same = got == trust['sha256']
        exact = same and st == 200 and r.get('bytes') == trust['bytes']
        if r['match'] != same or (same and not exact): incomplete.append(r.get('path') or '/')
        elif not exact: mismatch.append(f'{r.get("path") or "/"}:{st}')
    if incomplete: return 'fail', [f'no complete/consistent HTTP answer for {incomplete[:8]}']
    if mismatch: return 'retry', [f'{len(mismatch)} of {len(res)} routes not exact yet: {mismatch[:8]}']
    return 'ok', []

def final(states):
    if len(states) != 4 or any(s not in ('ok', 'retry', 'fail', 'skipped') for s in states): return 'FAIL', 1
    if all(s == 'ok' for s in states): return 'PASS', 0
    if all(s in ('ok', 'retry') for s in states): return 'RETRY-ONCE', 2
    return 'FAIL', 1

if __name__ == '__main__':
    a = sys.argv[1:]
    try:
        if a[:1] == ['routes']: print('\n'.join(routes())); sys.exit(0)
        if a[:1] == ['final']:
            v, code = final(a[1:]); print(json.dumps({'verdict': v, 'states': a[1:]})); sys.exit(code)
        rc = int(a[2])
        state, why = {'A': lambda: decide_A(a[1], rc), 'B': lambda: decide_B(a[1], rc), 'GW': lambda: decide_GW(a[1], rc, a[3])}[a[0]]()
    except SystemExit: raise
    except Exception as e: state, why = 'fail', [f'decide error: {str(e)[:120]}']
    print(json.dumps({'phase': a[0] if a else None, 'state': state, 'reasons': why}))
    sys.exit({'ok': 0, 'retry': 2}.get(state, 1))
