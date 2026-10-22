#!/usr/bin/env python3
"""READ-ONLY post-rollout check of directory 37366abb (GET only; no writes, no SSH). 3 rounds, about 20 s apart. Each round:
  - per front (4, concurrently): GET /health, then records -> routes -> records (each route read is bracketed by state);
  - normal-DNS HTTPS GET / for the 3 critical apps.
An OMISSION = a publication present in BOTH bracketing snapshots, with non-empty routes and unexpired at the read, that the
read did not serve. Each omission is attributed from the snapshots: re-signed during the read (sequence moved), a route-named
provider verdict changed, policy changed, or unexplained."""
import concurrent.futures, datetime, email.utils, json, pathlib, subprocess, time, urllib.request
F = {'us-west': '134.199.235.187', 'eu-central': '134.209.248.172', 'ap-southeast': '165.245.191.129', 'ca-east': '146.190.246.39'}
CRIT = ['7ae476a3', '9eb4e600', '38f368d6']
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
    pubs = {}
    for p in j.get('publications', []):
        r = p['bundle']['record']; pubs[r['deploymentId'][2:10]] = {'seq': r['sequence'], 'exp': r['expiresAt'], 'addrs': [x['address'] for x in r['routes']]}
    quals = {p['record']['record']['address']: [q['qualification']['issuedAt'] for q in p.get('qualifications', [])] for p in j.get('providers', [])}
    return {'start': rec['start'], 'end': rec['end'], 'error': rec.get('error'), 'pubs': pubs, 'quals': quals,
            'policies': {p['policy']['deploymentId'][2:10]: p['policy']['nonce'] for p in j.get('policies', [])}}
def front(item):
    name, ip = item
    h = get(ip, '/health'); pre = slim(get(ip, '/v1/network/records')); r = get(ip, '/v1/network/routes'); post = slim(get(ip, '/v1/network/records'))
    j = r.get('json') or {}
    return name, {'health': h.get('status', h.get('error')), 'pre': pre, 'post': post,
                  'read': {'start': r['start'], 'end': r['end'], 'error': r.get('error'), 'status': r.get('status'),
                           'served': sorted(j.get('labels', {})), 'deployments': len(j.get('deployments', {})), 'pending': [x['id'][2:10] for x in j.get('pending', [])]}}
def https(a):
    r = subprocess.run(['curl', '--silent', '--show-error', '--max-time', '15', '--output', '/dev/null', '--write-out', '%{http_code} %{ssl_verify_result} %{remote_ip} %{time_total}',
                        'https://' + a + '.app.enclave.host/'], capture_output=True, text=True, timeout=20)
    return {'app': a, 'at': now(), 'exit': r.returncode, 'result': r.stdout.strip(), 'error': r.stderr.strip()[:200]}
def analyse(f):
    pre, post, rd = f['pre'], f['post'], f['read']
    if rd['error'] or pre['error'] or post['error']: return {'error': rd['error'] or pre['error'] or post['error']}
    out = []
    for lab in sorted(set(pre['pubs']) & set(post['pubs'])):
        a, b = pre['pubs'][lab], post['pubs'][lab]
        if not a['addrs'] or not b['addrs'] or lab in rd['served']: continue
        if min(a['exp'], b['exp']) <= rd['end'] * 1000: continue   # expired around the read: not an omission
        why = []
        if a['seq'] != b['seq']: why.append(f"re-signed during the read (seq {a['seq']}->{b['seq']})")
        if a['addrs'] != b['addrs']: why.append('route addresses changed')
        if any(pre['quals'].get(x) != post['quals'].get(x) for x in set(a['addrs']) | set(b['addrs'])): why.append('a route-named provider verdict changed')
        if pre['policies'].get(lab) != post['policies'].get(lab): why.append('policy changed')
        out.append({'label': lab, 'pendingReported': lab in rd['pending'], 'why': why or ['UNEXPLAINED by directory state']})
    expected = [l for l in set(pre['pubs']) & set(post['pubs']) if pre['pubs'][l]['addrs'] and post['pubs'][l]['addrs']]
    return {'expected': len(expected), 'served': len(rd['served']), 'omissions': out, 'readSec': round(rd['end'] - rd['start'], 1),
            'emptyRouteRecords': sorted(l for l, v in post['pubs'].items() if not v['addrs'])}
out = {'at': now(), 'rounds': []}
for i in range(3):
    if i: time.sleep(20)
    rnd = {'at': now()}
    with concurrent.futures.ThreadPoolExecutor(max_workers=7) as p:
        fronts = p.map(front, F.items()); hs = p.map(https, CRIT)
        rnd['fronts'] = dict(fronts); rnd['https'] = list(hs)
    rnd['analysis'] = {k: analyse(v) for k, v in rnd['fronts'].items()}
    out['rounds'].append(rnd)
    print(json.dumps({'round': i + 1, 'at': rnd['at'], 'health': {k: v['health'] for k, v in rnd['fronts'].items()},
                      'routes': {k: {'served': v.get('served'), 'expected': v.get('expected'), 'omissions': v.get('omissions'), 'readSec': v.get('readSec'), 'emptyRoutes': v.get('emptyRouteRecords'), 'error': v.get('error')} for k, v in rnd['analysis'].items()},
                      'https': [(h['app'], h['result'], h['error'][:80]) for h in rnd['https']]}), flush=True)
pathlib.Path(__file__).with_name('raw.json').write_text(json.dumps(out) + '\n')
