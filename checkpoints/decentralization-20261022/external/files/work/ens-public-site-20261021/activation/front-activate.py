#!/usr/bin/env python3
"""front-activate.py - ROOT runs this ON one DigitalOcean front (staged by activate-front.sh), as root. It repairs the
EXISTING broken trustless block route of ipfs.enclave.host in the EXISTING enclave-bootstrap-tls Caddy. No new daemon,
port or service; nothing published, signed or sent.

  python3 front-activate.py --mode check     READ-ONLY on production paths: every precondition, the candidate Caddyfile built in a
                                             private temp dir, `caddy validate` + `caddy adapt` ROUTE-ORDER proof, extractor --check
  python3 front-activate.py --mode activate  check, then: backup -> blocks -> CAS install -> CAS reload -> health; any failed health
                                             check rolls back AUTOMATICALLY
  python3 front-activate.py --mode rollback  restore this run's backup (CAS: only if the live file is still this run's result),
                                             reload, verify, remove only the block files this run created (each sha-checked)

What --mode activate changes, in order (each step journaled in <run>/journal.jsonl):
  1. flock(2), non-blocking, on every peer lock the earlier activations use (+ this one's own): any held -> refuse, nothing changed;
  2. preconditions: the staged files are the pinned bytes; /etc/enclave-bootstrap-tls/Caddyfile is EXACTLY this host's pinned
     base sha256; the site CAR is the verified one; the https `ipfs.enclave.host {` block is unique and holds exactly one
     depth-1 `handle /ipfs/* {` line; the snippet marker is absent; the candidate validates and its compiled routes put the
     snippet's three routes BEFORE the generic /ipfs/* route (refused otherwise);
  3. backup: the live Caddyfile copied, create-only, to <run>/Caddyfile.before (opaque; never printed); blocks-dir pre-state;
  4. blocks: extract-site-blocks.mjs (pinned) writes /opt/enclave-site-blocks/ipfs/<cid> from the front's OWN verified site CAR
     (every block hash-checked; existing files must be byte-identical; temp file + rename); then every one of 9d's 487
     manifest blocks is re-hashed on disk;
  5. install: CAS (live == base) -> temp file in the same directory, fsync, same mode/owner, os.replace (atomic);
  6. reload: CAS (live == result) -> `systemctl reload enclave-bootstrap-tls` (graceful);
  7. health, through this front's own public :443 (the node provider -> this Caddy), HTTP/2: the probe path (HEAD+GET, 200,
     empty), the root block, a dag-pb child, a raw child (by ?format=raw AND by Accept), the CAR (unchanged bytes), an unrelated
     CID (same status as before: the generic route still handles it), /site-root and https://enclave.host/ (unchanged).
"""
import argparse, fcntl, hashlib, json, os, re, shutil, socket, subprocess, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
CF = '/etc/enclave-bootstrap-tls/Caddyfile'
CADDY = '/usr/local/lib/enclave-caddy/caddy'
RELOAD = ['systemctl', 'reload', 'enclave-bootstrap-tls']
LOCKS = ['/opt/enclave-site/.site-release.lock', '/etc/enclave-bootstrap-tls/directory-https.lock', '/etc/enclave-bootstrap-tls/platform-policy.lock',
         '/etc/enclave-bootstrap-tls/lease-relay.lock', '/etc/enclave-bootstrap-tls/ens-site-blocks.lock']
SITES, BLOCKS = '/opt/enclave-site', '/opt/enclave-site-blocks'
MARKER = '# --- trustless-gateway block serving for published sites'
P = json.load(open(os.path.join(HERE, 'pins.json')))
HOST = socket.gethostname()
if HOST not in P['hosts']:
    sys.exit(f'REFUSED: host {HOST} is not in pins.json')
H = P['hosts'][HOST]
ROOT = P['root']
CAR = f'{SITES}/{ROOT}/site.car'
JOURNAL = os.path.join(HERE, 'journal.jsonl')
sha = lambda b: hashlib.sha256(b).hexdigest()
fsha = lambda p: sha(open(p, 'rb').read())
now = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
def journal(event, **kw):
    with open(JOURNAL, 'a') as f: f.write(json.dumps({'at': now(), 'event': event, **kw}) + '\n')
class Refused(Exception): pass

# ---- preconditions ------------------------------------------------------------------------------------------------------
def staged_ok():
    for name, want in P['staged'].items():
        p = os.path.join(HERE, name)
        if os.path.islink(p) or not os.path.isfile(p) or fsha(p) != want: raise Refused(f'staged {name} is not the pinned {want[:16]}...')

def locate(text):
    """The unique https `ipfs.enclave.host {` site block and its unique depth-1 `handle /ipfs/* {` line -> line index to insert at."""
    lines = text.split('\n'); depth = 0; starts = []
    for i, l in enumerate(lines):
        t = l.strip()
        if depth == 0 and re.fullmatch(r'(https://)?ipfs\.enclave\.host(:443)?\s*\{', t): starts.append(i)
        depth += t.count('{') - t.count('}')
    if depth != 0: raise Refused('the Caddyfile braces do not balance: refused (ambiguous structure)')
    if len(starts) != 1: raise Refused(f'expected exactly one https `ipfs.enclave.host {{` site block, found {len(starts)}: refused')
    s = starts[0]; d = 0; generic = []; end = None
    for j in range(s, len(lines)):
        t = lines[j].strip()
        if j > s and d == 1 and re.fullmatch(r'handle\s+/ipfs/\*\s*\{', t): generic.append(j)
        d += t.count('{') - t.count('}')
        if d == 0: end = j; break
    if len(generic) != 1: raise Refused(f'expected exactly one depth-1 `handle /ipfs/* {{` in the ipfs.enclave.host block, found {len(generic)}: refused')
    if MARKER in '\n'.join(lines[s:end + 1]): raise Refused('the snippet marker is already inside the block (an earlier activation?): refused, not inserted twice')
    return lines, generic[0]

def candidate(base_text):
    lines, at = locate(base_text)
    snippet = open(os.path.join(HERE, 'snippet.caddy')).read().rstrip('\n').split('\n')
    return '\n'.join(lines[:at] + snippet + lines[at:])

def caddy_env(t):
    return dict(os.environ, XDG_DATA_HOME=t + '/data', XDG_CONFIG_HOME=t + '/config', HOME=t)

def validate_and_order(path):
    """caddy validate, then caddy adapt: in the server routes for ipfs.enclave.host, the probe route and both site-block routes
    must come BEFORE the generic /ipfs/* route (Caddy sorts handle blocks; this proves the compiled order)."""
    with tempfile.TemporaryDirectory() as t:
        r = subprocess.run([CADDY, 'validate', '--config', path, '--adapter', 'caddyfile'], capture_output=True, text=True, env=caddy_env(t), timeout=180)
        if r.returncode: raise Refused('caddy validate failed: ' + r.stderr[-800:])
        a = subprocess.run([CADDY, 'adapt', '--config', path, '--adapter', 'caddyfile'], capture_output=True, text=True, env=caddy_env(t), timeout=180)
        if a.returncode: raise Refused('caddy adapt failed: ' + a.stderr[-800:])
    cfg = json.loads(a.stdout)
    found = []
    def walk(routes, under_host):
        for r in routes or []:
            hosts = [h for m in r.get('match', []) for h in m.get('host', [])]
            here = under_host or ('ipfs.enclave.host' in hosts)
            if here and not under_host:
                for h in r.get('handle', []):
                    if h.get('handler') == 'subroute': found.append(h.get('routes', []))
            for h in r.get('handle', []):
                if h.get('handler') == 'subroute' and not here: walk(h.get('routes', []), False)
    for srv in cfg.get('apps', {}).get('http', {}).get('servers', {}).values(): walk(srv.get('routes', []), False)
    # the https site block is the one whose subroute holds the generic /ipfs/* route (the plain-http redirect block for the
    # same name compiles to a different server and holds no /ipfs route)
    found = [f for f in found if any(m.get('path') == ['/ipfs/*'] for r in f for m in r.get('match', []))]
    if len(found) != 1: raise Refused(f'compiled config: expected exactly one ipfs.enclave.host subroute holding the generic /ipfs/* route, found {len(found)}')
    order = []
    for i, r in enumerate(found[0]):
        for m in r.get('match', []):
            if m.get('path') == ['/ipfs/*']: order.append(('generic', i))
            if m.get('path') == ['/ipfs/bafkqaaa']: order.append(('probe', i))
            if (m.get('path_regexp') or {}).get('pattern') == '^/ipfs/baf[ky][a-z2-7]{55}$': order.append(('siteBlock', i))
    kinds = [k for k, _ in order]
    if kinds.count('generic') != 1 or kinds.count('probe') != 1 or kinds.count('siteBlock') != 2:
        raise Refused(f'compiled config: unexpected route set {order}')
    g = dict(order)['generic']
    if any(i >= g for k, i in order if k != 'generic'): raise Refused(f'compiled config: a snippet route is NOT before the generic /ipfs/* route {order}: refused')
    return order

def extractor(check):
    r = subprocess.run([P['node'], os.path.join(HERE, 'extract-site-blocks.mjs'), '--sites', SITES, '--out', BLOCKS, '--cid', ROOT] + (['--check'] if check else []),
                       capture_output=True, text=True, timeout=600)
    if r.returncode: raise Refused('extract-site-blocks failed: ' + (r.stderr or r.stdout)[-600:])
    return json.loads(r.stdout.strip().split('\n')[-1])

def manifest_on_disk():
    m = json.load(open(os.path.join(HERE, 'blocks-manifest.json')))
    bad = [b['cid'] for b in m['blocks'] if not os.path.isfile(f"{BLOCKS}/ipfs/{b['cid']}") or os.path.islink(f"{BLOCKS}/ipfs/{b['cid']}") or fsha(f"{BLOCKS}/ipfs/{b['cid']}") != b['sha256']]
    if bad or len(m['blocks']) != P['blocks']: raise Refused(f'{len(bad)} manifest blocks absent or different on disk (first {bad[:3]})')
    return len(m['blocks'])

# ---- health, through this front's own public :443 ------------------------------------------------------------------------------
HTTPS_PORT = 443          # production: the front's public :443 (the node provider -> this Caddy)
CURL_TLS = []             # production: default certificate verification (tests point this at their own CA)
def http(path, method='GET', accept=None, host='ipfs.enclave.host'):
    """One HTTP/2 request -> {status, http, bytes, sha256, ctype, server, contentLength}. For HEAD the body is discarded
    (/dev/null) and `bytes` is curl's own %{size_download} (0 unless the server wrongly sent a body): with -I, curl would
    otherwise write the response HEADERS into the -o file. The headers always come from -D, separately."""
    with tempfile.NamedTemporaryFile() as body, tempfile.NamedTemporaryFile() as hdr:
        out = '/dev/null' if method == 'HEAD' else body.name
        cmd = ['curl', '-sS', '--http2', '--max-time', '40', *CURL_TLS, '--resolve', f"{host}:{HTTPS_PORT}:{H['publicIp']}", '-o', out, '-D', hdr.name,
               '-w', '%{http_code} %{http_version} %{size_download}', *(['-I'] if method == 'HEAD' else []),
               *(['-H', f'Accept: {accept}'] if accept else []), f"https://{host}{'' if HTTPS_PORT == 443 else f':{HTTPS_PORT}'}{path}"]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        code, ver, size = (r.stdout.split() + ['000', '0', '0'])[:3]
        heads = open(hdr.name, 'rb').read().decode('latin-1').lower()
        hv = lambda n: (re.search(rf'^{n}:\s*(.+?)\r?$', heads, re.M) or [None, ''])[1]
        b = b'' if method == 'HEAD' else open(body.name, 'rb').read()
        return {'status': int(code), 'http': ver, 'bytes': int(size), 'sha256': sha(b), 'ctype': hv('content-type'), 'server': hv('server'),
                'contentLength': hv('content-length')}

def snapshot():
    c = P['checks']
    return {'other': http(f"/ipfs/{c['otherCid']}?format=raw", accept='application/vnd.ipld.raw'), 'siteRoot': http('/site-root'),
            'apex': http('/', host='enclave.host'), 'car': http(f'/ipfs/{ROOT}?format=car', accept='application/vnd.ipld.car')}

def health(before):
    c, out, fails = P['checks'], {}, []
    def want(name, got, **exp):
        out[name] = got
        for k, v in exp.items():
            if got.get(k) != v: fails.append(f'{name}: {k}={got.get(k)!r}, expected {v!r}')
    for m in ('HEAD', 'GET'):
        want(f'probe_{m}', http('/ipfs/bafkqaaa?format=raw', m, 'application/vnd.ipld.raw'), status=200, http='2', bytes=0, ctype='application/vnd.ipld.raw')
        if out[f'probe_{m}'].get('contentLength') not in ('0', ''): fails.append(f"probe_{m}: content-length {out[f'probe_{m}']['contentLength']!r}, expected 0")
    want('root_raw', http(f'/ipfs/{ROOT}?format=raw', accept='application/vnd.ipld.raw'), status=200, http='2', sha256=c['rootSha256'])
    want('child_dagpb_raw', http(f"/ipfs/{c['dagPbChild']['cid']}?format=raw", accept='application/vnd.ipld.raw'), status=200, http='2', sha256=c['dagPbChild']['sha256'], ctype='application/vnd.ipld.raw')
    want('child_raw', http(f"/ipfs/{c['rawChild']['cid']}?format=raw", accept='application/vnd.ipld.raw'), status=200, http='2', sha256=c['rawChild']['sha256'], ctype='application/vnd.ipld.raw')
    want('child_raw_by_accept', http(f"/ipfs/{c['rawChild']['cid']}", accept='application/vnd.ipld.raw'), status=200, sha256=c['rawChild']['sha256'])
    want('car', http(f'/ipfs/{ROOT}?format=car', accept='application/vnd.ipld.car'), status=200, sha256=c['carSha256'], bytes=c['carBytes'])
    after = snapshot()
    for k in ('other', 'siteRoot', 'apex'): out[f'{k}_before'], out[f'{k}_after'] = before[k], after[k]
    # /site-root is a static file: unchanged status and bytes
    if (after['siteRoot']['status'], after['siteRoot']['sha256']) != (before['siteRoot']['status'], before['siteRoot']['sha256']): fails.append('site-root changed')
    # the apex page may be dynamic: same status class over HTTP/2
    if after['apex']['status'] // 100 != before['apex']['status'] // 100 or after['apex']['http'] != '2': fails.append(f"apex: {after['apex']['status']} after, {before['apex']['status']} before")
    # an unrelated CID is still the GENERIC route's: never answered as a site block (its upstream may itself be up or down)
    if after['other']['status'] == 0: fails.append('unrelated CID: no HTTP answer')
    if after['other']['status'] == 200 and after['other']['ctype'] == 'application/vnd.ipld.raw' and after['other']['server'] == before['other']['server'] and before['other']['status'] != 200:
        fails.append('unrelated CID: answered 200 raw after the change, not before (it must stay with the generic route)')
    return out, fails

# ---- install / reload / rollback ------------------------------------------------------------------------------------------------
def atomic_write(path, data, like):
    st = os.stat(like); d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix='.Caddyfile.ens-', dir=d)
    try:
        os.write(fd, data); os.fsync(fd); os.close(fd)
        os.chmod(tmp, st.st_mode & 0o7777); os.chown(tmp, st.st_uid, st.st_gid)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
        raise
def reload_if(expected):
    if fsha(CF) != expected: raise Refused(f'the Caddyfile is {fsha(CF)[:16]}... before reload, expected {expected[:16]}...: not reloaded')
    r = subprocess.run(RELOAD, capture_output=True, text=True, timeout=180)
    if r.returncode: raise RuntimeError('reload failed: ' + r.stderr[-400:])
    time.sleep(3)

def rollback(receipt):
    """Restore Caddyfile.before only while the live file is exactly this run's result; remove only the block files this run created."""
    base, result = receipt['baseSha256'], receipt['resultSha256']
    live = fsha(CF)
    if live == result:
        before = open(os.path.join(HERE, 'Caddyfile.before'), 'rb').read()
        if sha(before) != base: raise Refused('the backup is not the recorded base: refused')
        atomic_write(CF, before, CF); journal('restored', sha=base)
        reload_if(base); journal('reloaded', sha=base)
    elif live == base: journal('already-base')
    else: raise Refused(f'the live Caddyfile is {live[:16]}..., neither this run\'s result nor its base: another writer changed it, nothing restored')
    removed = 0
    for cid, s in receipt.get('createdBlocks', {}).items():
        p = f'{BLOCKS}/ipfs/{cid}'
        if os.path.isfile(p) and not os.path.islink(p) and fsha(p) == s: os.unlink(p); removed += 1
    for d in (f'{BLOCKS}/ipfs', BLOCKS):
        if receipt.get('blocksDirCreated') and os.path.isdir(d) and not os.listdir(d): os.rmdir(d)
    journal('blocks-removed', count=removed)
    return {'state': 'rolled-back', 'caddyfile': fsha(CF), 'blocksRemoved': removed}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--mode', choices=['check', 'activate', 'rollback'], required=True); a = ap.parse_args()
    if os.geteuid() != 0: sys.exit('REFUSED: run as root')
    staged_ok()
    held = []
    for l in LOCKS:
        if not os.path.isdir(os.path.dirname(l)): raise Refused(f'lock directory {os.path.dirname(l)} is absent')
        fd = os.open(l, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise Refused(f'{l} is held by another activation or site release: refused, nothing changed')
        held.append(fd)
    rec_path = os.path.join(HERE, 'receipt.json')
    if a.mode == 'rollback':
        if not os.path.isfile(rec_path): raise Refused('no receipt in this run directory: nothing of this run to roll back')
        print(json.dumps(rollback(json.load(open(rec_path))))); return
    base_bytes = open(CF, 'rb').read()
    if sha(base_bytes) != H['baseSha256']:
        raise Refused(f'the live Caddyfile is {sha(base_bytes)[:16]}..., not this host\'s pinned base {H["baseSha256"][:16]}...: refused (re-run the preflight and re-pin after review)')
    if fsha(CAR) != P['checks']['carSha256']: raise Refused('the site CAR is not the verified one')
    cand = candidate(base_bytes.decode('utf-8')).encode('utf-8')
    with tempfile.TemporaryDirectory(dir='/root') as t:
        cpath = os.path.join(t, 'Caddyfile.candidate'); open(cpath, 'wb').write(cand)
        order = validate_and_order(cpath)
    plan = extractor(check=True)
    report = {'host': HOST, 'baseSha256': H['baseSha256'], 'resultSha256': sha(cand), 'routeOrder': order, 'extractCheck': plan}
    if a.mode == 'check':
        print(json.dumps({'state': 'CHECK_OK', **report})); return
    if os.path.exists(rec_path): raise Refused('this run directory already holds a receipt: use a new run directory (or --mode rollback)')
    journal('begin', **report)
    before = snapshot(); journal('baseline', **{k: {kk: v[kk] for kk in ('status', 'server', 'sha256')} for k, v in before.items()})
    # 3. backup (create-only, opaque)
    bpath = os.path.join(HERE, 'Caddyfile.before')
    with open(bpath, 'xb') as f: f.write(base_bytes)
    os.chmod(bpath, 0o600)
    if fsha(bpath) != H['baseSha256']: raise Refused('the backup does not re-read as the base')
    dir_existed = os.path.isdir(BLOCKS)
    pre = set(os.listdir(f'{BLOCKS}/ipfs')) if os.path.isdir(f'{BLOCKS}/ipfs') else set()
    receipt = {**report, 'blocksDirCreated': not dir_existed, 'createdBlocks': {}, 'state': 'begun'}
    json.dump(receipt, open(rec_path, 'x')); journal('backup', sha=H['baseSha256'])
    try:
        # 4. blocks
        try: summary = extractor(check=False)
        finally:  # recorded even when the extractor fails part-way, so the rollback removes exactly what this run wrote
            for c in (set(os.listdir(f'{BLOCKS}/ipfs')) - pre if os.path.isdir(f'{BLOCKS}/ipfs') else ()):
                if re.fullmatch(r'\.baf[a-z2-7]+\.\d+\.tmp', c): os.unlink(f'{BLOCKS}/ipfs/{c}')  # the extractor's own temp names
            receipt['createdBlocks'] = {c: fsha(f'{BLOCKS}/ipfs/{c}') for c in set(os.listdir(f'{BLOCKS}/ipfs')) - pre
                                        if not c.startswith('.')} if os.path.isdir(f'{BLOCKS}/ipfs') else {}
            json.dump(receipt, open(rec_path, 'w'))
        journal('blocks', summary=summary, created=len(receipt['createdBlocks']))
        manifest_on_disk()
        # 5. install (CAS) 6. reload (CAS)
        if fsha(CF) != H['baseSha256']: raise Refused('the Caddyfile changed during the run: not installed')
        atomic_write(CF, cand, CF)
        if fsha(CF) != receipt['resultSha256']: raise RuntimeError('the installed Caddyfile is not the candidate')
        journal('installed', sha=receipt['resultSha256'])
        reload_if(receipt['resultSha256']); journal('reloaded', sha=receipt['resultSha256'])
        # 7. health
        res, fails = health(before)
        receipt['health'] = res; receipt['healthFailures'] = fails
        if fails: raise RuntimeError('health checks failed: ' + '; '.join(fails[:6]))
        receipt['state'] = 'ACTIVE'; json.dump(receipt, open(rec_path, 'w')); journal('active')
        print(json.dumps({'state': 'ACTIVE', 'host': HOST, 'resultSha256': receipt['resultSha256'], 'createdBlocks': len(receipt['createdBlocks']), 'health': 'all passed'}))
    except Exception as e:
        journal('failed', error=str(e)[:600])
        receipt['state'] = 'FAILED'; receipt['error'] = str(e)[:600]; json.dump(receipt, open(rec_path, 'w'))
        rb = rollback(receipt)
        receipt['rollback'] = rb; json.dump(receipt, open(rec_path, 'w'))
        print(json.dumps({'state': 'FAILED_ROLLED_BACK', 'host': HOST, 'error': str(e)[:400], 'rollback': rb})); sys.exit(1)

if __name__ == '__main__':
    try: main()
    except Refused as e: print(json.dumps({'state': 'REFUSED', 'host': HOST, 'why': str(e)})); sys.exit(2)
