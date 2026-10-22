# Host side of the directory-HTTPS activation. NOT run against a host in this round. The controller (activate.py) sends
# this program to `ssh <host> python3 -` prefixed with one line `PARAMS = '<json>'`. Runs as root on one host; writes only
# /etc/enclave-bootstrap-tls/Caddyfile (+ .directory-https-prepared, .before-directory-https, directory-https.journal.jsonl,
# directory-https.lock) and reloads enclave-bootstrap-tls (graceful `caddy reload` via its admin socket).
#
# PARAMS: {mode: status|apply|rollback, ip, base_sha256, result_sha256, result_b64 (apply only), caddyfile, caddy,
#          reload_argv, admin_socket, https_port, directory_port, ca_file (null = system trust), peer_locks, run_id,
#          verify_attempts (optional), verify_sleep_s (optional)}
#
# Writers and locks (what is and is not coordinated):
#   - this program: flock(2) on directory-https.lock, non-blocking; a second run refuses at once;
#   - site-release (scripts/site-release/root-state.mjs lockRoot): flock(2) on <release root>/.site-release.lock. It never
#     writes the Caddyfile but reloads Caddy. Every path in peer_locks is opened (created if absent - never truncated,
#     never unlinked, no symlink followed; its parent, the release root, must exist) and flock'ed non-blocking for the
#     whole run, even on first use, so a site release that starts later blocks. Held -> refuse before any change;
#   - any other writer (root's ad hoc editors take no lock): NOT coordinated by any lock. Protection is compare-and-swap:
#     every install, reload and rollback first re-reads the Caddyfile and proceeds only if it is exactly the bytes this
#     activation expects (baseline before install, result before reload/rollback). Anything else is refused and left
#     byte-for-byte untouched. A residual window remains between the final hash check and rename(2) (microseconds);
#     a concurrent unlocked writer inside it could still be lost - that is why root's other editors must not run during
#     an activation.
#
# States printed: active | rolled-back (restored config verified) | baseline | refused (nothing written) |
#   rollback-refused-drift (verification failed, file changed by someone else: left untouched, NOT restored) |
#   rollback-unverified (restore written but running config/legacy not confirmed: outcome unknown, operator review).
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
ATTEMPTS, SLEEP = int(P.get('verify_attempts', 3)), float(P.get('verify_sleep_s', 2))


class Drift(Exception):
    pass


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


def _write_all(fd, data):
    """Full-write loop: os.write may write fewer bytes than asked; repeat until every byte is written."""
    view, done = memoryview(data), 0
    while done < len(data):
        n = os.write(fd, view[done:])
        if n <= 0:
            raise OSError('write made no progress')
        done += n
    return done


def _replace(dst, data, expected_current):
    """Write `data` to a temp file beside dst, verify its exact length and digest by reading it back, then rename(2)
    it over dst - only if dst still hashes to `expected_current` ('absent' = dst must not exist). The temp file is
    removed on every failure, so a partial write can never replace dst. Raises Drift or OSError."""
    want = hashlib.sha256(data).hexdigest()
    fd, tmp = tempfile.mkstemp(dir=str(dst.parent), prefix='.' + dst.name + '.')
    try:
        try:
            if _write_all(fd, data) != len(data):
                raise OSError('short write')
            os.fchmod(fd, 0o644); os.fsync(fd)
        finally:
            os.close(fd)
        got = Path(tmp).read_bytes()
        if len(got) != len(data) or hashlib.sha256(got).hexdigest() != want:
            raise OSError('temp file does not hold the exact bytes (%d of %d)' % (len(got), len(data)))
        current = sha(dst)
        if current != (None if expected_current == 'absent' else expected_current):
            raise Drift('%s is %s, expected %s: not written' % (dst.name, current, expected_current))
        os.replace(tmp, dst)
        tmp = None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
    d = os.open(str(dst.parent), os.O_RDONLY); os.fsync(d); os.close(d)


def write_new(data, dst):
    """Create dst (prepared file / backup) only while it is absent."""
    _replace(dst, data, 'absent')


def swap(expected, data):
    """Compare-and-swap the Caddyfile: replace it with `data` only if it still hashes to `expected`. Raises Drift."""
    _replace(CF, data, expected)


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
        super().__init__(IP, timeout=20, context=ssl.create_default_context(cafile=P.get('ca_file')))

    def connect(self):
        raw = socket.create_connection(('127.0.0.1', P['https_port']), timeout=20)
        self.sock = self._context.wrap_socket(raw, server_hostname=IP)


def https(method, path, headers=None, body=None):
    c = IPConn()
    c.request(method, path, body=body, headers={'Host': IP, **(headers or {})}); r = c.getresponse(); data = r.read()
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
            out[p] = {'status': s, 'directoryShaped': b'public record not found' in b or b'not a public-record path' in b}
        except Exception as e:
            out[p] = {'error': type(e).__name__}
    return out


def verify(pre):
    """Local readback with the route active. Raises on any mismatch. -> evidence dict."""
    ev = {}
    if running_has_route() is not True:
        raise RuntimeError('running config lacks the directory route')
    ev['runningConfigHasRoute'] = True
    last = None
    for attempt in range(ATTEMPTS):
        try:
            s, h, b = https('GET', '/v1/network/records', {'Origin': ORIGIN}); ds, db = direct('/v1/network/records'); last = s
            if s == 200 and ds == 200:
                snap, dsnap = json.loads(b), json.loads(db)
                ids = sorted(x['record']['record']['providerId'] for x in snap.get('providers', []))
                dids = sorted(x['record']['record']['providerId'] for x in dsnap.get('providers', []))
                if snap.get('version') == 1 and h.get('access-control-allow-origin') == '*' and ids == dids:
                    ev['records'] = {'status': s, 'acao': '*', 'providers': len(ids), 'equalsLocalDirectory': True}
                    break
        except Exception as e:
            last = type(e).__name__
        time.sleep(SLEEP)
    else:
        raise RuntimeError('HTTPS /v1/network/records is not the local directory (last %s)' % last)
    s, h, b = https('GET', '/v1/network/providers', {'Origin': ORIGIN})
    if s != 200 or h.get('access-control-allow-origin') != '*' or 'providers' not in json.loads(b):
        raise RuntimeError('HTTPS /v1/network/providers readback failed (%s)' % s)
    ev['providers'] = {'status': s, 'acao': '*'}
    s, h, _ = https('OPTIONS', '/v1/network/providers', {'Origin': ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'})
    if s != 204 or h.get('access-control-allow-origin') != '*' or h.get('access-control-allow-methods') != 'GET, POST':
        raise RuntimeError('preflight readback failed (%s)' % s)
    ev['preflight'] = {'status': s}
    # A POST the local directory refuses without writing (the control API has no /v1/network/management handler).
    s, h, b = https('POST', '/v1/network/management', {'Origin': ORIGIN, 'Content-Type': 'application/json'}, b'{}')
    if s != 400 or h.get('access-control-allow-origin') != '*' or b'error' not in b:
        raise RuntimeError('POST readback did not reach the local directory (%s)' % s)
    ev['postRefusedByDirectory'] = {'status': s}
    for attempt in range(ATTEMPTS):
        post = legacy_probe()
        if all(post[p].get('status') == pre[p].get('status') and not post[p].get('directoryShaped') for p in LEGACY):
            break
        time.sleep(SLEEP)
    else:
        raise RuntimeError('legacy routes changed: before %s after %s' % (pre, post))
    ev['legacy'] = post
    return ev


def verify_restored(pre):
    """After a rollback: the file is the baseline, the running config has no route, legacy answers as before."""
    state = {'file': sha(CF), 'running': running_has_route(), 'legacy': legacy_probe()}
    state['verified'] = (state['file'] == BASE and state['running'] is False and
                         all(not v.get('directoryShaped') and 'status' in v and (pre is None or v['status'] == pre[p].get('status'))
                             for p, v in state['legacy'].items()))
    return state


def validate(path):
    with tempfile.TemporaryDirectory() as t:
        env = dict(os.environ, XDG_DATA_HOME=t + '/data', XDG_CONFIG_HOME=t + '/config', HOME=t)
        r = subprocess.run([P['caddy'], 'validate', '--config', str(path), '--adapter', 'caddyfile'], capture_output=True, text=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError('caddy validate failed: ' + r.stderr[-1200:])


def reload_if(expected):
    """Reload only while the file is exactly `expected` (never activate someone else's bytes). -> (rc, stderr)"""
    if sha(CF) != expected:
        raise Drift('Caddyfile is %s before reload, expected %s: not reloaded' % (sha(CF), expected))
    r = subprocess.run(P['reload_argv'], capture_output=True, text=True, timeout=120)
    return r.returncode, (r.stderr or '')[-600:]


def rollback(reason, pre=None):
    """Restore the baseline only if the file is still exactly this activation's result. -> state dict (never raises Drift)."""
    journal('rollback-start', reason=reason[:500])
    if sha(BACKUP) != BASE:
        journal('rollback-refused', why='backup missing or not the baseline', backup=sha(BACKUP))
        return {'state': 'rollback-refused-drift', 'why': 'backup missing or not the baseline', 'file': sha(CF), 'running': running_has_route()}
    try:
        swap(RESULT, BACKUP.read_bytes())
    except Drift as e:
        journal('rollback-refused', why=str(e), file=sha(CF))
        return {'state': 'rollback-refused-drift', 'why': str(e), 'file': sha(CF), 'running': running_has_route()}
    journal('restored-file', result=RESULT)
    try:
        journal('reload', result=BASE, rollback=True)
        rc, err = reload_if(BASE)
    except Drift as e:
        journal('rollback-unverified', why=str(e)); return {'state': 'rollback-unverified', 'why': str(e), 'file': sha(CF), 'running': running_has_route()}
    st = verify_restored(pre)
    st['reloadRc'] = rc
    journal('rollback-done' if st['verified'] else 'rollback-unverified', **{k: v for k, v in st.items() if k != 'legacy'})
    return {'state': 'rolled-back' if st['verified'] else 'rollback-unverified', **st}


def status():
    return {'file': sha(CF), 'isBase': sha(CF) == BASE, 'isResult': sha(CF) == RESULT, 'prepared': sha(PREPARED), 'backup': sha(BACKUP),
            'runningHasRoute': running_has_route(), 'journalTail': journal_entries()[-6:]}


def reload_attempts_unverified():
    n = 0
    for e in journal_entries():
        if e.get('result') == RESULT and e['event'] == 'reload' and not e.get('rollback'):
            n += 1
        if e['event'] in ('verified', 'rollback-done'):
            n = 0
    return n


def activate_and_verify(pre, reconcile):
    journal('reload', result=RESULT, reconcile=reconcile)
    try:
        rc, err = reload_if(RESULT)
    except Drift as e:
        journal('refused', why=str(e)); return {'state': 'refused', 'error': str(e)}
    try:
        if rc:
            raise RuntimeError('reload failed: ' + err)
        ev = verify(pre)
    except Exception as e:
        return {'error': str(e)[:500], **rollback(str(e), pre)}
    journal('verified', result=RESULT, reconciled=reconcile)
    return {'state': 'active', 'reloaded': True, 'evidence': ev}


def apply():
    cur = sha(CF)
    if cur == RESULT:
        if running_has_route() is True:
            ev = verify(legacy_probe())
            journal('verified', result=RESULT, reconciled=True)
            return {'state': 'active', 'reloaded': False, 'evidence': ev}
        if reload_attempts_unverified() >= 2:
            journal('refused', why='reload cap'); return {'state': 'refused', 'error': 'two unverified reloads already recorded for this result: operator review, no further reload'}
        # The file is the result but the baseline config is still running: its legacy answers are the reference.
        return activate_and_verify(legacy_probe(), True)
    if cur != BASE:
        return {'state': 'refused', 'error': 'Caddyfile drifted from the reviewed baseline (%s): nothing changed' % cur}
    if running_has_route() is True:
        return {'state': 'refused', 'error': 'baseline file but the running config has the route: operator review'}
    data = base64.b64decode(P['result_b64'])
    if hashlib.sha256(data).hexdigest() != RESULT:
        return {'state': 'refused', 'error': 'result bytes do not match the reviewed hash'}
    if sha(PREPARED) not in (None, RESULT):
        return {'state': 'refused', 'error': 'a different prepared file exists: operator review'}
    if sha(BACKUP) not in (None, BASE):
        return {'state': 'refused', 'error': 'existing backup is not the baseline: refused, never overwritten'}
    if sha(PREPARED) is None:
        write_new(data, PREPARED)
    validate(PREPARED)
    journal('validated', result=RESULT)
    pre = legacy_probe()
    if sha(BACKUP) is None:
        write_new(CF.read_bytes(), BACKUP)
        if sha(BACKUP) != BASE:
            BACKUP.unlink(); return {'state': 'refused', 'error': 'Caddyfile changed while backing up: nothing installed'}
        journal('backup', sha=BASE)
    try:
        swap(BASE, PREPARED.read_bytes())
    except Drift as e:
        journal('refused', why=str(e)); return {'state': 'refused', 'error': str(e)}
    journal('installed', result=RESULT)
    return activate_and_verify(pre, False)


def do_rollback():
    cur = sha(CF)
    if cur == BASE:
        if running_has_route() is True:
            # File restored earlier but the reload was never confirmed: one reload of the (unchanged) baseline.
            journal('reload', result=BASE, rollback=True)
            try:
                rc, err = reload_if(BASE)
            except Drift as e:
                return {'state': 'rollback-unverified', 'why': str(e)}
            st = verify_restored(None)
            journal('rollback-done' if st['verified'] else 'rollback-unverified', file=st['file'], running=st['running'])
            return {'state': 'rolled-back' if st['verified'] else 'rollback-unverified', 'reloaded': True, **st}
        return {'state': 'baseline', 'reloaded': False, **verify_restored(None)}
    if cur != RESULT:
        return {'state': 'refused', 'error': 'Caddyfile is neither baseline nor result (%s): nothing changed' % cur}
    return rollback('operator rollback', legacy_probe())


def locked(path):
    """Open (creating if absent, never truncating, never following a symlink) and flock(2) a lock file for the whole run.
    The same inode protocol as site-release's lockRoot (open 'a+', flock -x). The parent must exist. Never unlinked."""
    parent = Path(path).parent
    if not parent.is_dir():
        raise FileNotFoundError('lock root %s is missing' % parent)
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    f = os.fdopen(fd, 'a')
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close(); raise
    return f


def main():
    mode = P['mode']; held = []
    try:
        held.append(locked(LOCK))
        for peer in P.get('peer_locks', []):
            held.append(locked(peer))
    except BlockingIOError:
        print(json.dumps({'ip': IP, 'mode': mode, 'state': 'refused', 'error': 'lock held by another run (own or site-release)', 'after': status()}, sort_keys=True))
        sys.exit(1)
    except FileNotFoundError as e:
        print(json.dumps({'ip': IP, 'mode': mode, 'state': 'refused', 'error': str(e), 'after': status()}, sort_keys=True))
        sys.exit(1)
    try:
        out = {'status': lambda: {'state': 'status', **status()}, 'apply': apply, 'rollback': do_rollback}[mode]()
    except Exception as e:
        out = {'state': 'error', 'error': (type(e).__name__ + ': ' + str(e))[:800]}
    if mode != 'status':
        out['after'] = status()
    print(json.dumps({'ip': IP, 'mode': mode, 'peerLocksHeld': len(held) - 1, **out}, sort_keys=True))
    sys.exit(0 if out['state'] in ('active', 'baseline', 'status', 'rolled-back') and not (mode == 'apply' and out['state'] != 'active') else 1)


if not globals().get('NO_MAIN'):   # unit tests exec this file with NO_MAIN to reach the helpers
    main()
