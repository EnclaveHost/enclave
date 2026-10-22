#!/usr/bin/env python3
"""READ-ONLY round 3: per front (eu-central slow, us-west control), 4 cycles of GET records -> GET routes -> GET records,
so each route read is bracketed by state snapshots. GET only."""
import concurrent.futures, datetime, json, pathlib, time, urllib.request
F = {'eu-central': '134.209.248.172', 'us-west': '134.199.235.187'}
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
def get(ip, path):
    t0 = time.time()
    try:
        with urllib.request.urlopen('http://' + ip + ':8188' + path, timeout=15) as r:
            return {'status': r.status, 'date': r.headers.get('date'), 'start': t0, 'end': time.time(), 'json': json.loads(r.read(8 << 20))}
    except Exception as e:
        return {'error': type(e).__name__ + ': ' + str(e)[:200], 'start': t0, 'end': time.time()}
def slim(rec):
    j = rec.get('json') or {}
    return {'start': rec['start'], 'end': rec['end'], 'pubs': {p['bundle']['record']['deploymentId'][2:10]: [p['bundle']['record']['sequence'], len(p['bundle']['record']['routes'])] for p in j.get('publications', [])},
            'quals': {p['record']['record']['address']: max([q['qualification']['issuedAt'] for q in p.get('qualifications', [])] or [0]) for p in j.get('providers', [])},
            'policies': {p['policy']['deploymentId'][2:10]: p['policy']['nonce'] for p in j.get('policies', [])}}
def front(item):
    name, ip = item; cycles = []
    for i in range(4):
        pre = slim(get(ip, '/v1/network/records')); r = get(ip, '/v1/network/routes'); post = slim(get(ip, '/v1/network/records'))
        j = r.get('json') or {}
        cycles.append({'pre': pre, 'post': post, 'read': {'start': r['start'], 'end': r['end'], 'error': r.get('error'), 'served': sorted(j.get('labels', {})), 'pending': [x['id'][2:10] for x in j.get('pending', [])]}})
    return name, cycles
out = {'at': now()}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as p: out['fronts'] = dict(p.map(front, F.items()))
pathlib.Path(__file__).with_name('round-3').mkdir(exist_ok=True)
(pathlib.Path(__file__).with_name('round-3') / 'raw.json').write_text(json.dumps(out) + '\n')
for name, cycles in out['fronts'].items():
    for c in cycles:
        pre, post, rd = c['pre'], c['post'], c['read']
        changedPubs = sorted(k for k in set(pre['pubs']) | set(post['pubs']) if pre['pubs'].get(k) != post['pubs'].get(k))
        changedQuals = sorted(a for a in set(pre['quals']) | set(post['quals']) if pre['quals'].get(a) != post['quals'].get(a))
        print(json.dumps({'front': name, 'readSec': round(rd['end'] - rd['start'], 1), 'served': len(rd['served']), 'pending': rd['pending'], 'pubsReSignedDuring': changedPubs,
                          'providerVerdictsDuring': changedQuals, 'policyChanged': pre['policies'] != post['policies'], 'error': rd['error']}))
