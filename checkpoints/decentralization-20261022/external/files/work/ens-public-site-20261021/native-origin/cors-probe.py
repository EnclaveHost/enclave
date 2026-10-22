#!/usr/bin/env python3
"""READ-ONLY: the live API's CORS answer per Origin, on public paths only (GET /v1/attestation as the homepage sends it,
GET /health, OPTIONS preflight). Records status, time and ONLY access-control-*/vary headers. Usage: cors-probe.py out.json"""
import json, subprocess, sys, time, tempfile
ORIGINS = [None, 'https://enclave.host', 'https://enclavehost.eth', 'https://enclavehost.eth.link', 'https://enclavehost.eth.limo']
API = 'https://api.enclave.host'
def req(method, path, origin, extra=()):
    with tempfile.NamedTemporaryFile() as h:
        cmd = ['curl', '-sS', '--max-time', '20', '-X', method, '-o', '/dev/null', '-D', h.name, '-w', '%{http_code} %{time_total}',
               '-H', 'Accept: application/json', *(['-H', f'Origin: {origin}'] if origin else []), *extra, API + path]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        heads = [l.strip() for l in open(h.name, encoding='latin-1') if l.lower().startswith(('access-control-', 'vary:'))]
    code, t = (r.stdout.split() + ['000', '0'])[:2]
    return {'method': method, 'path': path, 'origin': origin, 'status': int(code), 'seconds': float(t), 'headers': heads, 'err': r.stderr.strip()[:160]}
out = []
for o in ORIGINS:
    out.append(req('GET', '/v1/attestation', o))
    out.append(req('GET', '/health', o))
    if o: out.append(req('OPTIONS', '/v1/attestation', o, ['-H', 'Access-Control-Request-Method: GET', '-H', 'Access-Control-Request-Headers: authorization,content-type']))
for x in out:
    acao = next((h for h in x['headers'] if h.lower().startswith('access-control-allow-origin')), 'NO ACAO')
    print(f"{x['method']:7} {x['path']:16} {str(x['origin']):30} {x['status']} {x['seconds']:.2f}s  {acao}")
json.dump({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'results': out}, open(sys.argv[1], 'w'), indent=1)
