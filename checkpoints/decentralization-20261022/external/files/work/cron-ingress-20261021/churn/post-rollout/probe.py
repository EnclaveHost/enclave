#!/usr/bin/env python3
"""READ-ONLY post-rollout sample: GET only on the 4 fronts' public :8188 API + normal-DNS HTTPS for 3 critical apps.
One round per invocation (round name = argv[1]). Raw bodies saved for offline analysis. No writes, no SSH."""
import concurrent.futures, datetime, json, pathlib, subprocess, sys, time, urllib.request
F = {'us-west': '134.199.235.187', 'eu-central': '134.209.248.172', 'ap-southeast': '165.245.191.129', 'ca-east': '146.190.246.39'}
APP = ['38f368d6', '7ae476a3', '9eb4e600']
RND = sys.argv[1]; OUT = pathlib.Path(__file__).with_name('round-' + RND); OUT.mkdir(exist_ok=True)
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
def get(ip, path):
    t0 = time.time()
    try:
        with urllib.request.urlopen('http://' + ip + ':8188' + path, timeout=10) as r:
            body = r.read(8 * 1024 * 1024); return {'status': r.status, 'date': r.headers.get('date'), 'ms': int((time.time() - t0) * 1000), 'json': json.loads(body)}
    except Exception as e:
        return {'error': type(e).__name__ + ': ' + str(e)[:200], 'ms': int((time.time() - t0) * 1000)}
def front(item):
    name, ip = item; o = {'ip': ip, 'start': now(), 'health': get(ip, '/health'), 'records': get(ip, '/v1/network/records'), 'routes': []}
    for i in range(3):
        if i: time.sleep(2)
        r = get(ip, '/v1/network/routes'); r['at'] = now(); o['routes'].append(r)
    return name, o
def https(a):
    r = subprocess.run(['curl', '--silent', '--show-error', '--max-time', '12', '--output', '/dev/null', '--write-out', '%{http_code} %{ssl_verify_result} %{remote_ip} %{time_total}', 'https://' + a + '.app.enclave.host/'], capture_output=True, text=True, timeout=15)
    return {'app': a, 'at': now(), 'exit': r.returncode, 'result': r.stdout.strip(), 'error': r.stderr[:200]}
out = {'round': RND, 'at': now()}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as p: out['fronts'] = dict(p.map(front, F.items()))
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as p: out['https'] = list(p.map(https, APP))
(OUT / 'raw.json').write_text(json.dumps(out) + '\n')
s = {k: {'health': v['health'].get('status'), 'routes': [(len((r.get('json') or {}).get('deployments', {})), len((r.get('json') or {}).get('pending', [])), r.get('ms')) for r in v['routes']]} for k, v in out['fronts'].items()}
print(json.dumps({'round': RND, 'at': out['at'], 'summary': s, 'https': [(h['app'], h['result'], h['error'][:60]) for h in out['https']]}))
