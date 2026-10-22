#!/usr/bin/env python3
"""READ-ONLY, PUBLIC, UNAUTHENTICATED probe for cron 0x38f368d6's storage path (no secret, no signature, no TLS bypass):
  - DNS of the cron and storage hostnames: system resolver, 1.1.1.1, 8.8.8.8, and every authoritative NS of the zone;
  - the storage app ef514ed3 through each of the four fronts (curl --resolve, normal certificate verification):
    GET /healthz, and an UNSIGNED GET and HEAD of the cron state object path (an S3 API must refuse these: 403);
  - the cron app itself through each front.
The public config (CID-verified) gives bucket/key; they stay in memory: only status, timings, and S3 <Code> are written."""
import base64, concurrent.futures as cf, hashlib, json, re, socket, subprocess, urllib.parse, urllib.request, datetime, pathlib
CFG = 'bafkreigf7ewh5mzjv6zmgzyhz7kvcrlonvhhmezprjmb3i5xd2vb4seyey'
FRONTS = ['134.199.235.187', '134.209.248.172', '146.190.246.39', '165.245.191.129']
CRON, STORE = '38f368d6.app.enclave.host', 'ef514ed3.app.enclave.host'
out = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}

raw = urllib.request.urlopen(urllib.request.Request('https://ipfs.enclave.host/ipfs/' + CFG + '?format=raw', headers={'User-Agent': 'cron-diagnosis'}), timeout=60).read(1 << 20)
d = base64.b32decode(CFG[1:].upper() + '=' * (-len(CFG[1:]) % 8))
assert d[4:] == hashlib.sha256(raw).digest(), 'config CID mismatch'
st = json.loads(raw)['storage']
assert st['endpoint'].rstrip('/') == 'https://' + STORE, 'storage endpoint is not ef514ed3'
path = '/' + urllib.parse.quote(st['bucket'], safe='') + '/' + urllib.parse.quote(st['key'], safe='/')
out['storage'] = {'endpoint': st['endpoint'], 'region': st['region'], 'bucketLen': len(st['bucket']), 'keyLen': len(st['key']),
                  'keySha256': hashlib.sha256(st['key'].encode()).hexdigest()[:16], 'accessKeyIsRef': str(st.get('access_key', '')).startswith('$')}

def dig(name, server=None, qtype='A'):
    cmd = ['dig', '+time=4', '+tries=1', '+short' if server is None else '+noall', name, qtype] + ([] if server is None else ['+answer', '+comments', '@' + server])
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    status = re.search(r'status: (\w+)', r.stdout); aa = ' aa' in (re.search(r'flags:([^;]*);', r.stdout) or [None, ''])[1] if server else None
    ans = re.findall(r'\sIN\s+A\s+([\d.]+)', r.stdout) if server else r.stdout.split()
    return {'status': status.group(1) if status else ('NOERROR' if ans else 'no answer/timeout'), 'answers': ans, **({'aa': aa} if server else {})}
ns = [x.rstrip('.') for x in subprocess.run(['dig', '+short', 'app.enclave.host', 'NS', '@1.1.1.1'], capture_output=True, text=True, timeout=15).stdout.split()]
nsip = {n: (subprocess.run(['dig', '+short', n, 'A', '@1.1.1.1'], capture_output=True, text=True, timeout=15).stdout.split() or [None])[0] for n in ns}
dns = {}
for name in (CRON, STORE):
    try: sysr = sorted({a[4][0] for a in socket.getaddrinfo(name, 443, socket.AF_INET)})
    except Exception as e: sysr = f'{type(e).__name__}: {e}'[:80]
    dns[name] = {'system': sysr, '1.1.1.1': dig(name, '1.1.1.1'), '8.8.8.8': dig(name, '8.8.8.8'),
                 'authoritative': {n: (dig(name, ip) if ip else 'no NS address') for n, ip in nsip.items()}}
out['dns'] = {'appZoneNS': nsip, 'names': dns}

def curl(ip, host, method, p, max_time=75):
    cmd = ['curl', '-sS', '--max-time', str(max_time), '--resolve', f'{host}:443:{ip}', '-o', '-', '-w', '\n%{http_code} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{ssl_verify_result}',
           '-H', 'User-Agent: cron-diagnosis'] + (['-I'] if method == 'HEAD' else []) + [f'https://{host}{p}']
    r = subprocess.run(cmd, capture_output=True, timeout=max_time + 15)
    body, _, meta = r.stdout.rpartition(b'\n')
    m = meta.decode().split()
    code = re.search(rb'<Code>([A-Za-z]{1,60})</Code>', body[:4096])
    res = {'ip': ip, 'method': method, 'path': p if host == CRON or p == '/healthz' else '<state object>', 'rc': r.returncode, 'http': m[0] if m else None,
           'connect_s': m[1] if len(m) > 1 else None, 'tls_s': m[2] if len(m) > 2 else None, 'ttfb_s': m[3] if len(m) > 3 else None, 'total_s': m[4] if len(m) > 4 else None,
           'verify': m[5] if len(m) > 5 else None, 'error': r.stderr.decode(errors='replace')[:160]}
    if code: res['s3Code'] = code.group(1).decode()
    if m and m[0] == '200' and p not in ('/healthz', '/'): res['WARNING'] = 'unsigned read returned 200 (body discarded)'
    if host == CRON and body: res['body'] = body[:160].decode(errors='replace')
    return res
jobs = [(ip, STORE, 'GET', '/healthz') for ip in FRONTS] + [(ip, STORE, 'GET', path) for ip in FRONTS] + [(ip, STORE, 'HEAD', path) for ip in FRONTS] + [(ip, CRON, 'GET', '/') for ip in FRONTS]
with cf.ThreadPoolExecutor(8) as ex: out['http'] = list(ex.map(lambda j: curl(*j), jobs))
pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(out, indent=1) + '\n')
print(json.dumps(out, indent=1))
