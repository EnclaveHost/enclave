#!/usr/bin/env python3
"""READ-ONLY fine series: every 15 s, 24 samples. The public route map (all labels with seconds-to-expiry, every pending id and
reason) and, whenever 59f1273d has a label, one verified HTTPS GET of its public /api/status at that label's address (TLS
verification ON; curl --resolve keeps SNI/hostname). Public GET/DNS only; writes JSON lines beside this file."""
import json, subprocess, time, datetime, pathlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / f"series2-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.jsonl"
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
api = subprocess.run(['dig', '+short', '+time=5', '+tries=1', 'A', 'api.enclave.host', '@9.9.9.9'], capture_output=True, text=True, timeout=15).stdout.split()[0]
for i in range(24):
    t0 = time.time(); rec = {'at': now()}
    try:
        r = subprocess.run(['curl', '-sS', '-m', '12', '--resolve', f'api.enclave.host:443:{api}', 'https://api.enclave.host/v1/network/routes'], capture_output=True, text=True, timeout=15)
        d = json.loads(r.stdout); upd = datetime.datetime.fromisoformat(d['updatedAt'].replace('Z', '+00:00')).timestamp()
        rec['updatedAt'] = d['updatedAt']
        rec['labels'] = {k: {'expiresInS': round(v['expiresAt'] / 1000 - upd, 1), 'addresses': v['addresses']} for k, v in sorted(d['labels'].items())}
        rec['pending'] = [[p['id'][2:10], p['reason']] for p in d.get('pending', [])]
    except Exception as e:
        rec['routesError'] = f'{type(e).__name__}: {e}'[:300]
    lab = rec.get('labels', {}).get('59f1273d')
    if lab:
        ip = lab['addresses'][0]
        c = subprocess.run(['curl', '-sS', '-m', '12', '-w', '\n%{http_code} %{ssl_verify_result}', '--resolve', f'59f1273d.app.enclave.host:443:{ip}',
                            'https://59f1273d.app.enclave.host/api/status'], capture_output=True, text=True, timeout=15)
        body, _, tail = c.stdout.rpartition('\n')
        rec['status59'] = {'ip': ip, 'curlRc': c.returncode, 'httpAndVerify': tail, 'body': body[:600], 'stderr': c.stderr[-200:]}
    with OUT.open('a') as f: f.write(json.dumps(rec) + '\n')
    s59 = rec.get('status59', {})
    print(rec['at'], 'labels', len(rec.get('labels', {})), 'pending', rec.get('pending'), '59:', s59.get('httpAndVerify', '-'), s59.get('body', '')[:120].replace('\n', ' '), flush=True)
    if i < 23: time.sleep(max(0, 15 - (time.time() - t0)))
print('SERIES2-DONE', OUT.name)
