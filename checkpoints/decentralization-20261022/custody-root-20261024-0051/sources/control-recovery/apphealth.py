# ACTUAL application health, the ONE definition used by activate.py (pre-cutover baseline, renewal phase) and by
# verify-operational.py (the gate). A status code alone is never health (a 404 or an error page is not the app).
#   kind "json-ping"  (EyesOff /ping): HTTP 200, JSON body with ok === true AND pong === true;
#   kind "html"       (image-generator /): HTTP 200, text/html, >= minBytes, and - when the pre-cutover baseline had one -
#                     the SAME <title> (the app's identity as the previous control served it).
# Specs live in apps-health.json, which activate.py writes from the pre-cutover baseline.
import json, re, ssl, urllib.error, urllib.request

CTX = ssl.create_default_context()

def fetch(url, timeout=12):
    req = urllib.request.Request(url, headers={'user-agent': 'enclave-activation-health/1', 'cache-control': 'no-cache'})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, (r.headers.get('content-type') or '').lower(), r.read(1 << 20)
    except urllib.error.HTTPError as e: return e.code, '', b''
    except Exception as e: return None, '', type(e).__name__.encode()

def title_of(body):
    m = re.search(rb'<title[^>]*>(.*?)</title>', body, re.I | re.S)
    return re.sub(r'\s+', ' ', m.group(1).decode('utf-8', 'replace')).strip() if m else None

def check(spec, timeout=12):
    """-> (ok, detail). Fails closed on anything but the app's own healthy answer."""
    st, ctype, body = fetch(spec['url'], timeout)
    if st != 200: return False, f"HTTP {st}{'' if st else ' ' + body.decode(errors='replace')[:60]}"
    if spec['kind'] == 'json-ping':
        try: j = json.loads(body)
        except Exception: return False, 'not JSON'
        return (True, 'ok/pong') if isinstance(j, dict) and j.get('ok') is True and j.get('pong') is True else (False, f'ping body {str(j)[:80]}')
    if spec['kind'] == 'html':
        if 'text/html' not in ctype: return False, f'content-type {ctype or "none"}'
        if len(body) < int(spec.get('minBytes', 1024)): return False, f'{len(body)} bytes'
        if spec.get('title') is not None and title_of(body) != spec['title']: return False, f'title {title_of(body)!r} is not {spec["title"]!r}'
        return True, f'html {len(body)}B' + (f' title {spec["title"]!r}' if spec.get('title') is not None else ' (no title in the baseline)')
    return False, f'unknown health kind {spec.get("kind")}'

def load_specs(path, ids=None):
    specs = json.loads(open(path).read())
    for i, s in specs.items():
        assert re.fullmatch(r'0x[0-9a-f]{64}', i) and s['kind'] in ('json-ping', 'html'), i
        assert s['url'].startswith(('https://', 'http://127.0.0.1')), s['url']
    if ids is not None: assert set(specs) == set(ids), 'health specs must cover exactly the apps'
    return specs
