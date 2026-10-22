# Host side of the directory-HTTPS activation. NOT run in this round. The controller (activate.py) sends this program to
# `ssh <host> python3 -` prefixed with one line `PARAMS = '<json>'`. Runs as root on one host; touches only
# /etc/enclave-bootstrap-tls/Caddyfile (+ .directory-https-prepared, .before-directory-https, directory-https.journal.jsonl,
# directory-https.lock) and reloads enclave-bootstrap-tls (graceful `caddy reload` via its admin socket).
#
# PARAMS: {mode: status|apply|rollback, ip, base_sha256, result_sha256, result_b64 (apply only), caddyfile, caddy,
#          reload_argv, admin_socket, https_port, directory_port, ca_file (null = system trust), run_id}
#
# Guarantees:
#   - before-hash guard: apply only from the exact reviewed baseline, or reconciles an already-installed exact result;
#     any other file content is refused untouched (drift);
#   - the prepared file is verified by hash and `caddy validate`d before anything changes;
#   - the backup is written once and never overwritten (an existing backup must equal the baseline);
#   - install is an atomic rename; at most ONE reload per invocation, and a result whose journal already shows two
#     unverified reload attempts is refused for operator review (no blind reload loops);
#   - after reload: running config, local HTTPS readback (directory answers; legacy unchanged); any failure rolls back to
#     the backup (atomic), reloads once and verifies the baseline is running again;
#   - unknown outcome (connection lost): re-running status/apply reconciles from the file hash + the running config.
import base64, fcntl, hashlib, http.client, json, os, socket, ssl, subprocess, sys, tempfile, time
from pathlib import Path

P = json.loads(PARAMS)  # noqa: F821  (prepended by the controller)
CF = Path(P['caddyfile'])
PREPARED = CF.with_name(CF.name + '.directory-https-prepared')
BACKUP = CF.with_name(CF.name + '.before-directory-https')
JOURNAL = CF.with_name('directory-https.journal.jsonl')
LOCK = CF.with_name('directory-https.lock')
IP, BASE, RESULT = P['ip'], P['base_sha256'], P['result_sha256']
GRAMMAR = '^/v1/network/(providers|qualifications|routes|records|management|policy/0x[0-9a-f]{64})$'
ORIGIN = 'https://independent-dashboard.example'


def sha(path):
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def journal(event, **kw):
    line = json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'run': P['run_id'], 'event': event, **kw}, sort_keys=True)
    with open(JOURNAL, 'a') as f:
        f.write(line + '\n'); f.flush(); os.fsync(f.fileno())


def journal_entries():
    try:
        return [json.loads(l) for l in JOURNAL.read_text().splitlines() if l.strip()]
    except FileNotFoundError:
        return []


def atomic_copy(src_bytes, dst):
    fd, tmp = tempfile.mkstemp(dir=str(dst.parent), prefix='.' + dst.name + '.')
    try:
        os.write(fd, src_bytes); os.fchmod(fd, 0o644); os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, dst)
    d = os.open(str(dst.parent), os.O_RDONLY); os.fsync(d); os.close(d)


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=10); self.path_ = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); self.sock.settimeout(10); self.sock.connect(self.path_)


def running_has_route():
    """True/False from the live config (admin socket); None when the admin endpoint cannot be read."""
    try:
        c = UnixHTTP(P['admin_socket']); c.request('GET', '/config/apps/http', headers={'Host': 'localhost'})
        r = c.getresponse(); body = r.read().decode()
        if r.status != 200:
            return None
        text = json.dumps(json.loads(body))
        return GRAMMAR in text and '"local_address": "127.0.0.2"' in text
    except Exception:
        return None


class IPConn(http.client.HTTPSConnection):
    """https://<ip>/ as a client sees it, dialed at 127.0.0.1:<https_port>; certificate verified for the IP (no SNI)."""
    def __init__(self):
        ctx = ssl.create_default_context(cafile=P.get('ca_file'))
        super().__init__(IP, timeout=20, context=ctx)

    def connect(self):
        raw = socket.create_connection(('127.0.0.1', P['https_port']), timeout=20)
        self.sock = self._context.wrap_socket(raw, server_hostname=IP)


def https(method, path, headers=None, body=None):
    c = IPConn(); h = {'Host': IP, **(headers or {})}
    c.request(method, path, body=body, headers=h); r = c.getresponse(); data = r.read()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, data


def direct(path):
    c = http.client.HTTPConnection('127.0.0.1', P['directory_port'], timeout=15)
    c.request('GET', path); r = c.getresponse(); return r.status, r.read()


LEGACY = ['/native/status', '/recovery-health', '/health']


def legacy_probe():
    out = {}
    for p in LEGACY:
        try:
            s, h, b = https('GET', p)
            out[p] = {'status': s, 'directoryShaped': b'public record not found' in b}
        except Exception as e:
            out[p] = {'error': type(e).__name__}
    return out


def verify(pre):
    """Local readback after a reload. Raises on any mismatch. -> evidence dict."""
    ev = {}
    if running_has_route() is not True:
        raise RuntimeError('running config lacks the directory route')
    ev['runningConfigHasRoute'] = True
    for attempt in range(3):
        s, h, b = https('GET', '/v1/network/records', {'Origin': ORIGIN})
        ds, db = direct('/v1/network/records')
        if s == 200 and ds == 200:
            snap, dsnap = json.loads(b), json.loads(db)
            ids = sorted(x['record']['providerId'] for x in snap.get('providers', []))
            dids = sorted(x['record']['providerId'] for x in dsnap.get('providers', []))
            if snap.get('version') == 1 and h.get('access-control-allow-origin') == '*' and ids == dids:
                ev['records'] = {'status': s, 'acao': '*', 'providers': len(ids), 'equalsLocalDirectory': True}
                break
        time.sleep(2)
    else:
        raise RuntimeError('HTTPS /v1/network/records is not the local directory (status %s)' % s)
    s, h, b = https('GET', '/v1/network/providers', {'Origin': ORIGIN})
    if s != 200 or h.get('access-control-allow-origin') != '*' or 'providers' not in json.loads(b):
        raise RuntimeError('HTTPS /v1/network/providers readback failed (%s)' % s)
    ev['providers'] = {'status': s, 'acao': '*'}
    s, h, _ = https('OPTIONS', '/v1/network/providers', {'Origin': ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'})
    if s != 204 or h.get('access-control-allow-origin') != '*' or h.get('access-control-allow-methods') != 'GET, POST':
        raise RuntimeError('preflight readback failed (%s)' % s)
    ev['preflight'] = {'status': s}
    # A POST the local directory refuses without writing: the control API has no /v1/network/management handler.
    s, h, b = https('POST', '/v1/network/management', {'Origin': ORIGIN, 'Content-Type': 'application/json'}, b'{}')
    if s != 400 or h.get('access-control-allow-origin') != '*' or b'error' not in b:
        raise RuntimeError('POST readback did not reach the local directory (%s)' % s)
    ev['postRefusedByDirectory'] = {'status': s}
    for attempt in range(3):
        post = legacy_probe()
        if all(post[p].get('status') == pre[p].get('status') and not post[p].get('directoryShaped') for p in LEGACY):
            break
        time.sleep(2)
    else:
        raise RuntimeError('legacy routes changed: before %s after %s' % (pre, post))
    ev['legacy'] = post
    return ev


def validate(path):
    with tempfile.TemporaryDirectory() as t:
        env = dict(os.environ, XDG_DATA_HOME=t + '/data', XDG_CONFIG_HOME=t + '/config', HOME=t)
        r = subprocess.run([P['caddy'], 'validate', '--config', str(path), '--adapter', 'caddyfile'], capture_output=True, text=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError('caddy validate failed: ' + r.stderr[-1200:])


def reload():
    r = subprocess.run(P['reload_argv'], capture_output=True, text=True, timeout=120)
    return r.returncode, (r.stderr or '')[-600:]


def rollback(reason):
    journal('rollback-start', reason=reason[:500])
    if sha(BACKUP) != BASE:
        journal('rollback-impossible', backup=sha(BACKUP)); raise RuntimeError('backup missing or not the baseline: operator review')
    atomic_copy(BACKUP.read_bytes(), CF)
    rc, err = reload()
    state = {'file': sha(CF), 'running': running_has_route(), 'reloadRc': rc}
    journal('rollback-done' if state['file'] == BASE and state['running'] is False else 'rollback-unverified', **state)
    return state


def status():
    return {'file': sha(CF), 'isBase': sha(CF) == BASE, 'isResult': sha(CF) == RESULT, 'prepared': sha(PREPARED), 'backup': sha(BACKUP),
            'runningHasRoute': running_has_route(), 'journalTail': journal_entries()[-6:]}


def reload_attempts_unverified():
    n = 0
    for e in journal_entries():
        if e.get('result') != RESULT:
            continue
        if e['event'] == 'reload':
            n += 1
        if e['event'] in ('verified', 'rollback-done'):
            n = 0
    return n


def apply():
    cur = sha(CF)
    if cur == RESULT:
        running = running_has_route()
        if running is True:
            ev = verify_reconciled()
            journal('verified', result=RESULT, reconciled=True)
            return {'state': 'active', 'reloaded': False, 'evidence': ev}
        if reload_attempts_unverified() >= 2:
            raise RuntimeError('two unverified reloads already recorded for this result: operator review, no further reload')
        journal('reload', result=RESULT, reconcile=True)
        rc, err = reload()
        try:
            if rc:
                raise RuntimeError('reload failed: ' + err)
            ev = verify_reconciled()
        except Exception as e:
            st = rollback(str(e)); return {'state': 'rolled-back', 'error': str(e)[:500], 'rollback': st}
        journal('verified', result=RESULT, reconciled=True)
        return {'state': 'active', 'reloaded': True, 'evidence': ev}
    if cur != BASE:
        raise RuntimeError('Caddyfile drifted from the reviewed baseline (%s): refused, nothing changed' % cur)
    if running_has_route() is True:
        raise RuntimeError('baseline file but the running config has the route: operator review')
    data = base64.b64decode(P['result_b64'])
    if hashlib.sha256(data).hexdigest() != RESULT:
        raise RuntimeError('result bytes do not match the reviewed hash')
    if sha(PREPARED) not in (None, RESULT):
        raise RuntimeError('a different prepared file exists: operator review')
    if sha(PREPARED) is None:
        atomic_copy(data, PREPARED)
    validate(PREPARED)
    journal('validated', result=RESULT)
    pre = legacy_probe()
    if sha(BACKUP) is None:
        atomic_copy(CF.read_bytes(), BACKUP); journal('backup', sha=BASE)
    elif sha(BACKUP) != BASE:
        raise RuntimeError('existing backup is not the baseline: refused, never overwritten')
    if sha(CF) != BASE:
        raise RuntimeError('Caddyfile changed during preparation: refused')
    atomic_copy(PREPARED.read_bytes(), CF)
    journal('installed', result=RESULT)
    try:
        journal('reload', result=RESULT)
        rc, err = reload()
        if rc:
            raise RuntimeError('reload failed: ' + err)
        ev = verify(pre)
    except Exception as e:
        st = rollback(str(e)); return {'state': 'rolled-back', 'error': str(e)[:500], 'rollback': st}
    journal('verified', result=RESULT)
    return {'state': 'active', 'reloaded': True, 'evidence': ev}


def verify_reconciled():
    # Pre-change legacy statuses are unknown after a lost connection: require legacy routes not served by the directory.
    pre = legacy_probe()
    return verify(pre)


def do_rollback():
    cur = sha(CF)
    if cur == BASE:
        running = running_has_route()
        if running is True:
            journal('reload', result=RESULT, rollbackReconcile=True)
            rc, err = reload()
            return {'state': 'baseline', 'reloaded': True, 'running': running_has_route(), 'rc': rc}
        return {'state': 'baseline', 'reloaded': False, 'running': running}
    if cur != RESULT:
        raise RuntimeError('Caddyfile is neither baseline nor result (%s): refused' % cur)
    return {'state': 'rolled-back', 'rollback': rollback('operator rollback')}


def main():
    with open(LOCK, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(json.dumps({'error': 'another activation run holds the lock'}))
        mode = P['mode']
        try:
            out = {'status': status, 'apply': apply, 'rollback': do_rollback}[mode]()
            if mode != 'status':
                out['after'] = status()
            print(json.dumps({'ip': IP, 'mode': mode, **out}, sort_keys=True))
        except Exception as e:
            print(json.dumps({'ip': IP, 'mode': mode, 'error': str(e)[:800], 'after': status()}, sort_keys=True)); sys.exit(1)


main()
