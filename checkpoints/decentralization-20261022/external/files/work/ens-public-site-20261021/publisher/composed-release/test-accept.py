#!/usr/bin/env python3
"""OFFLINE fixture tests of the acceptance harness (no network: every phase is a fixture or a stub).
  1. accept-decide.py per phase: valid -> ok; timeout / crash / missing / malformed / missing or extra gate / non-boolean
     pass / exit-code contradiction / empty or wrong route list / transport error -> fail; only the two validated cache-lag
     shapes -> retry (and their near misses -> fail)
  2. accept-release.sh end to end with stub phases: exit codes, and that NO later phase starts after an A or B failure
Usage: python3 test-accept.py   (exit 0 = all pass)"""
import copy, hashlib, importlib.util, json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('accept_decide', os.path.join(HERE, 'accept-decide.py'))
D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)
R, fails = {}, []
def check(label, got, want):
    R[label] = got == want
    if got != want: fails.append(label); print('FAIL', label, 'got', got, 'want', want)
TMP = tempfile.mkdtemp(prefix='accept-test-')
def put(name, obj, raw=None):
    p = os.path.join(TMP, name); open(p, 'w').write(raw if raw is not None else json.dumps(obj)); return p
VALUE = D.VALUE
# --- fixtures: a fully valid post-activation evidence set
A_OK = {'gates': {
  'C1': {'title': 'c1', 'pass': True}, 'C2': {'title': 'c2', 'pass': True},
  'P1': {'title': 'p1', 'pass': True, 'sequence': 1027, 'validUntilUnix': 1793700000},
  'P2': {'title': 'p2', 'pass': True}, 'P3': {'title': 'p3', 'pass': True},
  'R1': {'title': 'r1', 'pass': True, 'status': 200, 'signatureV2Valid': True, 'v1ValueMatchesV2': True, 'expired': False, 'value': VALUE,
         'sequence': 1027, 'validityUnix': 1793700000, 'publisherSequence': 1027, 'publisherValidUntilUnix': 1793700000}},
  'ipniHead': 'baguqeerahead'}
CIDS = D.index_cids()
B_OK = {'gates': {'I1': {'pass': True}, 'I2': {'pass': True}, 'I3': {'pass': True, 'cids': CIDS, 'providerRecords': {k: 1 for k in CIDS}, 'errors': {}}}}
M = D._manifest()
def want(p):
    k = p.split('?')[0] or 'index.html'
    return M.get(k) or M.get(k.rstrip('/') + '/index.html') or M.get(k + '.html')
ROUTES = D.routes()
def gw_ok(base):
    return {'base': base, 'results': [{'path': p, 'status': 200, 'curlErr': '', 'bytes': want(p)['bytes'], 'sha256': want(p)['sha256'], 'match': True,
                                       'expected': {'bytes': want(p)['bytes'], 'sha256': want(p)['sha256'], 'cid': want(p)['cid']}} for p in ROUTES]}
LINK, LIMO = D.GATEWAYS
def stale(seq=1026, validity=1792653351, **kw):
    a = copy.deepcopy(A_OK); r = a['gates']['R1']; r.update(pass_=None); r.pop('pass_')
    r.update({'pass': False, 'sequence': seq, 'validityUnix': validity, **kw}); return a

# 1. decide, phase A
check('A valid, exit 0 -> ok', D.decide_A(put('a.json', A_OK), 0)[0], 'ok')
check('A valid file but exit 124 (timeout) -> fail', D.decide_A(put('a.json', A_OK), 124)[0], 'fail')
check('A no output file -> fail', D.decide_A(os.path.join(TMP, 'none.json'), 1)[0], 'fail')
check('A malformed JSON -> fail', D.decide_A(put('a.json', None, raw='{"gates": {"C1"'), 1)[0], 'fail')
check('A empty output -> fail', D.decide_A(put('a.json', None, raw=''), 1)[0], 'fail')
x = copy.deepcopy(A_OK); del x['gates']['P3']
check('A missing gate P3 -> fail', D.decide_A(put('a.json', x), 0)[0], 'fail')
x = copy.deepcopy(A_OK); x['gates']['X9'] = {'pass': True}
check('A extra gate -> fail', D.decide_A(put('a.json', x), 0)[0], 'fail')
x = copy.deepcopy(A_OK); x['gates']['C2']['pass'] = 'true'
check('A non-boolean pass -> fail', D.decide_A(put('a.json', x), 0)[0], 'fail')
x = copy.deepcopy(A_OK); x['gates']['P2']['pass'] = False
check('A exit 0 but a gate failed (contradiction) -> fail', D.decide_A(put('a.json', x), 0)[0], 'fail')
check('A P2 failed, exit 1 -> fail', D.decide_A(put('a.json', x), 1)[0], 'fail')
x = copy.deepcopy(A_OK); x['gates']['C1'] = {'title': 'c1', 'pass': False, 'error': 'HTTP request failed'}
check('A chain read error -> fail', D.decide_A(put('a.json', x), 1)[0], 'fail')
check('A R1 valid OLDER record (seq 1026 < 1027) -> retry', D.decide_A(put('a.json', stale()), 1)[0], 'retry')
check('A R1 valid same seq, earlier validity -> retry', D.decide_A(put('a.json', stale(seq=1027, validity=1793600000)), 1)[0], 'retry')
check('A R1 signature invalid -> fail', D.decide_A(put('a.json', stale(signatureV2Valid=False)), 1)[0], 'fail')
check('A R1 expired -> fail', D.decide_A(put('a.json', stale(expired=True)), 1)[0], 'fail')
check('A R1 other value -> fail', D.decide_A(put('a.json', stale(value='/ipfs/bafyother')), 1)[0], 'fail')
check('A R1 router NEWER than publisher -> fail', D.decide_A(put('a.json', stale(seq=1028)), 1)[0], 'fail')
check('A R1 HTTP 404 -> fail', D.decide_A(put('a.json', stale(status=404)), 1)[0], 'fail')
x = stale(); x['gates']['R1'] = {'title': 'r1', 'pass': False, 'error': 'fetch failed'}
check('A R1 transport error -> fail', D.decide_A(put('a.json', x), 1)[0], 'fail')
x = stale(); x['gates']['R1'].pop('validityUnix')
check('A R1 missing field -> fail', D.decide_A(put('a.json', x), 1)[0], 'fail')
x = stale(); x['gates']['P3']['pass'] = False
check('A R1 stale AND P3 failed -> fail', D.decide_A(put('a.json', x), 1)[0], 'fail')

# 1. decide, phase B
check('B valid -> ok', D.decide_B(put('b.json', B_OK), 0)[0], 'ok')
check('B timeout exit 124 -> fail', D.decide_B(put('b.json', B_OK), 124)[0], 'fail')
check('B empty gates -> fail', D.decide_B(put('b.json', {'gates': {}}), 1)[0], 'fail')
x = copy.deepcopy(B_OK); del x['gates']['I3']['providerRecords']['root']
check('B I3 without the root -> fail', D.decide_B(put('b.json', x), 0)[0], 'fail')
x = copy.deepcopy(B_OK); x['gates']['I3']['cids'] = {}
check('B I3 over no CIDs -> fail', D.decide_B(put('b.json', x), 0)[0], 'fail')
x = copy.deepcopy(B_OK); x['gates']['I3']['providerRecords']['favicon.ico'] = 0
check('B I3 passed with a zero count -> fail', D.decide_B(put('b.json', x), 0)[0], 'fail')
x = copy.deepcopy(B_OK); x['gates']['I2'] = {'pass': False, 'lastAdvertisement': 'old'}
check('B ad not ingested -> fail (not retry)', D.decide_B(put('b.json', x), 1)[0], 'fail')

# 1. decide, gateways
check('GW valid full route set -> ok', D.decide_GW(put('g.json', gw_ok(LINK)), 0, LINK)[0], 'ok')
check('GW empty results -> fail', D.decide_GW(put('g.json', {'base': LINK, 'results': []}), 0, LINK)[0], 'fail')
check('GW no results key -> fail', D.decide_GW(put('g.json', {'base': LINK}), 0, LINK)[0], 'fail')
check('GW process timeout -> fail', D.decide_GW(put('g.json', gw_ok(LINK)), 124, LINK)[0], 'fail')
check('GW no output file -> fail', D.decide_GW(os.path.join(TMP, 'none.json'), 0, LINK)[0], 'fail')
check('GW results for the other gateway -> fail', D.decide_GW(put('g.json', gw_ok(LIMO)), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'].pop()
check('GW one route missing -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'].append(x['results'][3])
check('GW duplicated route -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][5].update(status=0, curlErr='curl: (28) Operation timed out', match=False)
check('GW one curl timeout -> fail (not retry)', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][2]['expected'] = None; x['results'][2]['match'] = False
check('GW route unknown to the export -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][1]['sha256'] = '0' * 64
check('GW match=true but wrong sha (inconsistent) -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LIMO); x['results'][4].update(status=504, sha256=hashlib.sha256(b'gateway timeout').hexdigest(), match=False)
check('GW complete 504 answer (cached) -> retry', D.decide_GW(put('g.json', x), 0, LIMO)[0], 'retry')
x = gw_ok(LIMO); x['results'][0].update(sha256='1' * 64, match=False)
check('GW complete 200, old bytes -> retry', D.decide_GW(put('g.json', x), 0, LIMO)[0], 'retry')
# root review: expectations come from the PINNED manifest, never from the row
x = gw_ok(LINK); x['results'][3].update(expected={}, match=True, status=200); x['results'][3].pop('sha256')
check('GW expected={} + missing actual sha, match=true, 200 -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][3]['expected'] = {}
check('GW expected={} with the right bytes -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][3].pop('sha256')
check('GW actual sha256 missing -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][3]['sha256'] = x['results'][3]['sha256'].upper()
check('GW actual sha256 malformed (not lowercase hex64) -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][3].update(sha256='3' * 64, match=True); x['results'][3]['expected']['sha256'] = '3' * 64
check('GW self-consistent WRONG expected+actual -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][3]['expected']['cid'] = 'bafkreiother'
check('GW expected cid not the manifest one -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); f = M['css/site.css']; x['results'][0].update(sha256=f['sha256'], bytes=f['bytes'], expected={'bytes': f['bytes'], 'sha256': f['sha256'], 'cid': f['cid']})
check('GW / reported as another export file (consistent) -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][3]['match'] = False
check('GW match=false but the bytes ARE exact (inconsistent) -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LINK); x['results'][3]['bytes'] += 1
check('GW exact hash but wrong byte count -> fail', D.decide_GW(put('g.json', x), 0, LINK)[0], 'fail')
x = gw_ok(LIMO); x['results'][9].update(status=502, sha256=hashlib.sha256(b'bad gateway').hexdigest(), bytes=11, match=False)
check('GW complete 502 with manifest-true expected -> retry (kept)', D.decide_GW(put('g.json', x), 0, LIMO)[0], 'retry')
check('GW unknown gateway -> fail', D.decide_GW(put('g.json', gw_ok(LINK)), 0, 'https://example.org')[0], 'fail')

# 1. final
for states, v in ((['ok'] * 4, 'PASS'), (['ok', 'ok', 'retry', 'ok'], 'RETRY-ONCE'), (['retry', 'ok', 'ok', 'retry'], 'RETRY-ONCE'),
                  (['fail', 'skipped', 'skipped', 'skipped'], 'FAIL'), (['ok', 'ok', 'skipped', 'skipped'], 'FAIL'),
                  (['ok', 'ok', 'retry', 'fail'], 'FAIL'), (['ok', 'ok', 'ok'], 'FAIL'), (['ok', 'ok', 'ok', 'maybe'], 'FAIL')):
    check(f'final {states} -> {v}', D.final(states)[0], v)
check('routes: / first, exactly the pinned list', (ROUTES[0], len(ROUTES), len(set(ROUTES))), ('', 36, 36))

# 2. accept-release.sh end to end with stub phases
def run_sh(name, a=A_OK, a_rc=0, b=B_OK, b_rc=0, gw=None, gw_rc=0, sleep=None):
    d = tempfile.mkdtemp(prefix=f'accept-sh-{name}-', dir=TMP); stubs = os.path.join(d, 'stubs'); out = os.path.join(d, 'out'); os.makedirs(stubs); os.makedirs(out)
    json.dump(a, open(os.path.join(stubs, 'A.json'), 'w')) if isinstance(a, dict) else open(os.path.join(stubs, 'A.json'), 'w').write(a)
    json.dump(b, open(os.path.join(stubs, 'B.json'), 'w')) if isinstance(b, dict) else open(os.path.join(stubs, 'B.json'), 'w').write(b)
    gw = gw or {LINK: gw_ok(LINK), LIMO: gw_ok(LIMO)}
    for i, base in enumerate((LINK, LIMO), 1): json.dump(gw[base], open(os.path.join(stubs, f'GW{i}.json'), 'w'))
    sl = lambda k: f'sleep {sleep[1]}\n' if sleep and sleep[0] == k else ''
    open(os.path.join(stubs, 'A'), 'w').write(f'#!/bin/bash\ntouch {d}/ran.A\n{sl("A")}cat {stubs}/A.json\nexit {a_rc}\n')
    open(os.path.join(stubs, 'B'), 'w').write(f'#!/bin/bash\ntouch {d}/ran.B\n{sl("B")}cat {stubs}/B.json\nexit {b_rc}\n')
    open(os.path.join(stubs, 'GW'), 'w').write(f'#!/bin/bash\ntouch {d}/ran.GW\n{sl("GW")}n=1; [ "$1" = "{LIMO}" ] && n=2\n'
                                                f'[ "$#" -eq {2 + len(ROUTES)} ] || exit 9\ncp {stubs}/GW$n.json "$2"\nexit {gw_rc}\n')
    for s in ('A', 'B', 'GW'): os.chmod(os.path.join(stubs, s), 0o755)
    env = {**os.environ, 'ACCEPT_STUBS': stubs, 'ACCEPT_OUT': out, 'ACCEPT_T_A': '3', 'ACCEPT_T_B': '3', 'ACCEPT_T_GW': '3'}
    p = subprocess.run(['bash', os.path.join(HERE, 'accept-release.sh')], env=env, capture_output=True, text=True, timeout=120)
    ran = sorted(x[4:] for x in os.listdir(d) if x.startswith('ran.'))
    return p.returncode, ran, p.stdout
rc, ran, _ = run_sh('valid'); check('sh valid -> exit 0, all phases', (rc, ran), (0, ['A', 'B', 'GW']))
x = copy.deepcopy(A_OK); x['gates']['C1'] = {'title': 'c1', 'pass': False, 'error': 'numVersions 6'}
rc, ran, _ = run_sh('chainfail', a=x, a_rc=1); check('sh chain failure -> exit 1, B and GW never start', (rc, ran), (1, ['A']))
rc, ran, _ = run_sh('Atimeout', sleep=('A', 10)); check('sh A timeout -> exit 1, nothing later', (rc, ran), (1, ['A']))
rc, ran, _ = run_sh('Amalformed', a='{"gates":'); check('sh A malformed -> exit 1, nothing later', (rc, ran), (1, ['A']))
rc, ran, _ = run_sh('Bmalformed', b='not json'); check('sh B malformed -> exit 1, GW never starts', (rc, ran), (1, ['A', 'B']))
rc, ran, _ = run_sh('Btimeout', sleep=('B', 10)); check('sh B timeout -> exit 1, GW never starts', (rc, ran), (1, ['A', 'B']))
rc, ran, _ = run_sh('GWempty', gw={LINK: gw_ok(LINK), LIMO: {'base': LIMO, 'results': []}}); check('sh one gateway empty -> exit 1', rc, 1)
rc, ran, _ = run_sh('GWtimeout', sleep=('GW', 10)); check('sh gateway timeout -> exit 1', rc, 1)
y = gw_ok(LIMO); y['results'][7].update(status=504, sha256='2' * 64, match=False)
rc, ran, _ = run_sh('GWcache', gw={LINK: gw_ok(LINK), LIMO: y}); check('sh complete 504 on eth.limo only -> exit 2 (retry once)', (rc, ran), (2, ['A', 'B', 'GW']))
rc, ran, out = run_sh('Rstale', a=stale(), a_rc=1); check('sh delegated record valid but older -> exit 2', rc, 2)
z = gw_ok(LINK); z['results'][7].update(status=0, curlErr='curl: (6) Could not resolve host', match=False)
rc, ran, _ = run_sh('Rstale+transport', a=stale(), a_rc=1, gw={LINK: z, LIMO: gw_ok(LIMO)}); check('sh stale record + a transport error -> exit 1', rc, 1)
shutil.rmtree(TMP)
print(json.dumps(R, indent=1)); print(f'{len(R) - len(fails)}/{len(R)} PASS' + (f'; FAILED {fails}' if fails else ''))
sys.exit(1 if fails else 0)
