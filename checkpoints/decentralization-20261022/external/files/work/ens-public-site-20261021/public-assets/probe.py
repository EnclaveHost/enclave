#!/usr/bin/env python3
"""Read-only: GET each listed site path once through a public gateway; record status, headers, bytes, sha256 and compare
with content/export/files-manifest.json (9d's verified export). Usage: probe.py <base-url> <out.json> [path ...]"""
import hashlib, json, os, subprocess, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
M = {f['path']: f for f in json.load(open(os.path.join(HERE, '../content/export/files-manifest.json')))['files']}
base, out, paths = sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3:]
res = []
for p in paths:
    with tempfile.NamedTemporaryFile() as b, tempfile.NamedTemporaryFile() as h:
        t = time.time()
        r = subprocess.run(['curl', '-sS', '--compressed', '--max-time', '45', '-o', b.name, '-D', h.name, '-w', '%{http_code} %{http_version} %{size_download}',
                            '-H', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
                            '-H', 'Accept: text/css,*/*;q=0.1' if p.endswith('.css') else 'Accept: */*', f'{base}/{p}'], capture_output=True, text=True, timeout=60)
        code, ver, size = (r.stdout.split() + ['000', '0', '0'])[:3]
        heads = [l.strip() for l in open(h.name, 'rb').read().decode('latin-1').split('\n') if l.strip()]
        data = open(b.name, 'rb').read()
    key = p.split('?')[0] or 'index.html'
    # a directory serves its index.html; an extensionless page is the site's _redirects rewrite to <page>.html
    want = M.get(key) or M.get(key.rstrip('/') + '/index.html') or M.get(key + '.html')
    res.append({'path': p, 'status': int(code), 'http': ver, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'seconds': round(time.time() - t, 2),
                'curlErr': r.stderr.strip()[:200], 'headers': heads[:40],
                'expected': want and {'bytes': want['bytes'], 'sha256': want['sha256'], 'cid': want['cid']},
                'match': bool(want) and hashlib.sha256(data).hexdigest() == want['sha256'],
                'head': data[:160].decode('utf-8', 'replace') if not (want and hashlib.sha256(data).hexdigest() == want['sha256']) else ''})
    print(f"{res[-1]['status']} h{ver} {len(data):>7}B match={res[-1]['match']} {res[-1]['seconds']}s {p}", flush=True)
json.dump({'base': base, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'results': res}, open(out, 'w'), indent=1)
