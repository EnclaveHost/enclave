# Host side of the enclave-public-directory runtime upgrade. NOT run against a host by this workstream: root runs it via
# activate-runtime.py after review. Sent as `ssh <host> python3 -` with one prepended line `PARAMS = '<json>'`. Runs as root.
#
# Scope: ONLY the enclave-public-directory service. Writes exactly:
#   - the new bundle file (created once; an existing file must already hold the exact bytes);
#   - the effective drop-in (zz-authority-pins.conf), by compare-and-swap between the reviewed baseline and the new bytes;
#   - a write-once backup of the baseline drop-in (rollback-before-<tag>.txt, ignored by systemd: not *.conf);
#   - its own journal, durable initial verification baseline and lock files.
# It runs `systemctl daemon-reload` and `systemctl restart <unit>`. It NEVER writes, copies, restores or deletes the state
# directory (public records and replay floors), the config, Caddy, the provider or the tunnel. State is only READ to check
# continuity: records and floors may only move forward across the restart (the live service keeps writing meanwhile).
#
# PARAMS: mode status|apply|rollback; unit; dropin; base_dropin_sha256; new_dropin_b64; new_dropin_sha256; backup;
#   bundle_path; bundle_sha256; bundle_b64 (apply only); old_bundle_path; old_bundle_sha256; config_path; config_sha256;
#   node; state_dir; port; lock; journal; systemctl (argv prefix); critical_labels; run_id;
#   optional: active_timeout_s, health_timeout_s, routes_timeout_s, routes_needed (consecutive good readbacks), restart_cap
#
# States: active | baseline | rolled-back (old runtime running AND verified) | refused (nothing changed) |
#   rollback-refused-drift (drop-in changed by someone else: left untouched, NOT restored) |
#   rollback-unverified (restore attempted, old runtime not confirmed: outcome unknown, operator review) | error
import base64, fcntl, hashlib, http.client, json, os, re, socket, subprocess, sys, tempfile, time
from pathlib import Path

P = json.loads(PARAMS)  # noqa: F821  (prepended by the controller)
UNIT, DROPIN, BACKUP = P['unit'], Path(P['dropin']), Path(P['backup'])
BASE, NEW = P['base_dropin_sha256'], P['new_dropin_sha256']
NEW_BYTES = base64.b64decode(P['new_dropin_b64'])
BUNDLE, OLD_BUNDLE = Path(P['bundle_path']), Path(P['old_bundle_path'])
JOURNAL, LOCK = Path(P['journal']), Path(P['lock'])
BASELINE = Path(P.get('baseline', str(JOURNAL) + '.baseline.json'))
OLD_ARGV = [P['node'], str(OLD_BUNDLE), P['config_path']]
NEW_ARGV = [P['node'], str(BUNDLE), P['config_path']]
ACTIVE_T, HEALTH_T = float(P.get('active_timeout_s', 30)), float(P.get('health_timeout_s', 30))
ROUTES_T, ROUTES_N, CAP = float(P.get('routes_timeout_s', 120)), int(P.get('routes_needed', 3)), int(P.get('restart_cap', 2))


class Drift(Exception):
    pass


def sha(path):
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except (FileNotFoundError, IsADirectoryError):
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
    view, done = memoryview(data), 0
    while done < len(data):
        n = os.write(fd, view[done:])
        if n <= 0:
            raise OSError('write made no progress')
        done += n
    return done


def _replace(dst, data, expected_current, mode=0o644):
    """Temp file beside dst, full write + fsync, read-back length/digest check, then rename(2) over dst only if dst still
    hashes to expected_current ('absent' = must not exist). The temp file is removed on every failure."""
    want = hashlib.sha256(data).hexdigest()
    fd, tmp = tempfile.mkstemp(dir=str(dst.parent), prefix='.' + dst.name + '.')
    try:
        try:
            if _write_all(fd, data) != len(data):
                raise OSError('short write')
            os.fchmod(fd, mode); os.fsync(fd)
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


def systemctl(*args, timeout=90):
    r = subprocess.run([*P['systemctl'], *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr[-400:]


def unit_state():
    rc, out, err = systemctl('show', UNIT, '-p', 'ExecStart', '-p', 'MainPID', '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts')
    props = dict(l.split('=', 1) for l in out.splitlines() if '=' in l)
    m = re.search(r'argv\[\]=([^;]*);', props.get('ExecStart', ''))
    argv = m.group(1).split() if m else None
    pid = int(props.get('MainPID') or 0)
    try:
        cmdline = Path('/proc/%d/cmdline' % pid).read_bytes().split(b'\0')[:-1] if pid else []
        cmdline = [c.decode() for c in cmdline]
    except FileNotFoundError:
        cmdline = []
    return {'loadedArgv': argv, 'pid': pid, 'active': props.get('ActiveState'), 'sub': props.get('SubState'), 'cmdline': cmdline}


def get(path, timeout=10, method='GET', body=None):
    c = http.client.HTTPConnection('127.0.0.1', P['port'], timeout=timeout)
    c.request(method, path, body=body, headers={'Content-Type': 'application/json'} if body is not None else {})
    r = c.getresponse(); data = r.read()
    try:
        return r.status, json.loads(data)
    except Exception:
        return r.status, None


def state_snapshot():
    """READ-ONLY view of the state directory: record ids/sequence numbers and every replay floor."""
    d = Path(P['state_dir'])
    rec = json.loads((d / 'public-records.json').read_text())
    if rec.get('version') != 1:
        raise RuntimeError('unsupported state version')
    floors = {}
    if (d / 'route-floors').is_dir():
        for f in sorted((d / 'route-floors').glob('*.json')):
            floors[f.name] = json.loads(f.read_text())
    return {'providers': {k: v['record']['record']['issuedAt'] for k, v in rec.get('providers', {}).items()},
            'providerExpiry': {k: v['record']['record']['expiresAt'] for k, v in rec.get('providers', {}).items()},
            'policies': {k: v['envelope']['policy']['nonce'] for k, v in rec.get('policies', {}).items()},
            'policyOwners': {k: v['owner'].lower() for k, v in rec.get('policies', {}).items()},
            'policyHashes': {k: hashlib.sha256(json.dumps(v['envelope']['policy'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                             for k, v in rec.get('policies', {}).items()},
            'publications': {k: v['bundle']['record']['sequence'] for k, v in rec.get('publications', {}).items()},
            'managementFloors': rec.get('managementFloors') or {}, 'floors': floors, 'keys': sorted(rec.keys())}


def floor_key(v):
    """(epoch, sequence) of a route floor file, whatever extra fields it carries."""
    if isinstance(v, dict):
        return (v.get('epoch', 0) or 0, v.get('sequence', 0) or 0)
    return (0, 0)


def continuity(pre, post):
    """Records and floors only move forward. -> list of problems (empty = continuous)."""
    now = int(time.time() * 1000); problems = []
    for k, issued in pre['providers'].items():
        if pre['providerExpiry'][k] > now + 5000 and post['providers'].get(k, -1) < issued:
            problems.append('provider %s went back or vanished' % k[:12])
    for k, n in pre['policies'].items():
        if k not in post['policies']:
            problems.append('policy %s vanished' % k[:12])
            continue
        if pre.get('policyOwners', {}).get(k) != post.get('policyOwners', {}).get(k):
            continue  # A different owner has an independent policy nonce.
        if post['policies'][k] < n:
            problems.append('policy %s nonce %s -> %s' % (k[:12], n, post['policies'].get(k)))
        elif post['policies'][k] == n and pre.get('policyHashes', {}).get(k) != post.get('policyHashes', {}).get(k):
            problems.append('policy %s equivocated at its old nonce' % k[:12])
    for k, f in pre['floors'].items():
        if k not in post['floors'] or floor_key(post['floors'][k]) < floor_key(f):
            problems.append('route floor %s went back or vanished' % k[:14])
            continue
        newer = post['floors'][k]
        if newer.get('epoch') == f.get('epoch') and newer.get('publicKey') != f.get('publicKey'):
            problems.append('route floor %s changed key in the same epoch' % k[:14])
        if floor_key(newer) == floor_key(f) and newer.get('hash') != f.get('hash'):
            problems.append('route floor %s changed hash at the same position' % k[:14])
    for runner, old in pre['managementFloors'].items():
        newer = post['managementFloors'].get(runner)
        if not newer:
            problems.append('management floor %s vanished' % runner[:12])
            continue
        if old.get('version') != 1 or newer.get('version') != 1 or not isinstance(old.get('operators'), dict) or not isinstance(newer.get('operators'), dict):
            problems.append('management floor %s has an unknown format' % runner[:12])
            continue
        for operator, floor in old['operators'].items():
            new_floor = newer['operators'].get(operator)
            if not new_floor or new_floor.get('sequence', -1) < floor['sequence']:
                problems.append('management operator floor went back or vanished')
            elif new_floor['sequence'] == floor['sequence'] and new_floor.get('hash') != floor.get('hash'):
                problems.append('management operator floor changed hash at the same sequence')
    return problems


def wait_runtime(argv):
    """The unit is active with a NEW main process running exactly `argv`. -> state or raises."""
    deadline = time.time() + ACTIVE_T
    while time.time() < deadline:
        u = unit_state()
        if u['active'] == 'active' and u['cmdline'] == argv and u['loadedArgv'] == argv:
            return u
        time.sleep(1)
    raise RuntimeError('unit not running %s (state %s)' % (argv[1], unit_state()))


def wait_health():
    deadline, last = time.time() + HEALTH_T, None
    while time.time() < deadline:
        try:
            s, b = get('/health')
            if s == 200 and b == {'ok': True, 'service': 'enclave-public-directory', 'version': 1}:
                return
            last = s
        except Exception as e:
            last = type(e).__name__
        time.sleep(1)
    raise RuntimeError('health not ok (last %s)' % last)


def routes_ok(pre_routes):
    """Consecutive bounded readbacks: every critical label and every still-live baseline route must survive."""
    validate_routes_baseline(pre_routes)
    need = P['critical_labels']
    floor = max(1, P.get('minimum_routes', 1))
    good, deadline, last = 0, time.time() + ROUTES_T, None
    while time.time() < deadline:
        t = time.time()
        try:
            s, b = get('/v1/network/routes', timeout=8)
            live_ids = [k for k, v in pre_routes['deployments'].items()
                        if isinstance(v, dict) and v.get('expiresAt', 0) > time.time() * 1000 + 5000]
            ok = s == 200 and isinstance(b, dict) and all(l in b.get('labels', {}) for l in need) and len(b.get('deployments', {})) >= floor and all(k in b.get('deployments', {}) for k in live_ids) and time.time() - t < 8
            last = {'status': s, 'deployments': len((b or {}).get('deployments', {})), 'labels': need and [l in (b or {}).get('labels', {}) for l in need]}
        except Exception as e:
            ok, last = False, type(e).__name__
        good = good + 1 if ok else 0
        if good >= ROUTES_N:
            return {'deployments': last['deployments'], 'criticalLabels': need, 'floor': floor}
        time.sleep(2)
    raise RuntimeError('route map not restored: %s' % last)


def verify_new(pre):
    problems = preconditions(require_new=True)
    if problems:
        raise Drift('; '.join(problems))
    u = wait_runtime(NEW_ARGV); wait_health()
    s, snap = get('/v1/network/records', timeout=15)
    if s != 200 or not isinstance(snap, dict) or snap.get('version') != 1 or not isinstance(snap.get('management'), list):
        raise RuntimeError('records readback is not the new runtime (status %s, management %s)' % (s, type((snap or {}).get('management')).__name__))
    s, b = get('/v1/network/management', method='POST', body='{}')
    if s != 400 or not isinstance(b, dict) or 'error' not in b:
        raise RuntimeError('invalid management record not refused with 400 (got %s)' % s)
    problems = continuity(pre['state'], state_snapshot())
    if problems:
        raise RuntimeError('state continuity: ' + '; '.join(problems[:5]))
    routes = routes_ok(pre['routes'])
    return {'pid': u['pid'], 'managementHandler': True, 'invalidManagement': 400, 'continuity': 'forward', 'routes': routes,
            'providersServed': len(snap['providers']), 'policiesServed': len(snap['policies'])}


def verify_old(pre):
    problems = preconditions()
    if problems:
        raise Drift('; '.join(problems))
    u = wait_runtime(OLD_ARGV); wait_health()
    s, snap = get('/v1/network/records', timeout=15)
    if s != 200 or not isinstance(snap, dict) or snap.get('version') != 1:
        raise RuntimeError('records not served after rollback (%s)' % s)
    problems = continuity(pre['state'], state_snapshot()) if pre else []
    if problems:
        raise RuntimeError('state continuity: ' + '; '.join(problems[:5]))
    routes = routes_ok(pre['routes'] if pre else None)
    return {'pid': u['pid'], 'routes': routes}


def restart(argv_expected, tag):
    journal('restart', target=tag)
    rc, out, err = systemctl('restart', UNIT, timeout=120)
    if rc:
        raise RuntimeError('systemctl restart failed: ' + err)
    return wait_runtime(argv_expected)


def reload_and_check(argv_expected):
    rc, out, err = systemctl('daemon-reload')
    if rc:
        raise RuntimeError('daemon-reload failed: ' + err)
    loaded = unit_state()['loadedArgv']
    if loaded != argv_expected:
        raise RuntimeError('effective ExecStart after daemon-reload is %s, expected %s' % (loaded, argv_expected))


def rollback(reason, pre):
    """Restore the baseline drop-in only if it is still exactly our new drop-in; old runtime must then be verified."""
    journal('rollback-start', reason=reason[:500])
    if sha(BACKUP) != BASE:
        journal('rollback-refused', why='backup missing or not the baseline'); return {'state': 'rollback-refused-drift', 'why': 'backup missing or not the baseline'}
    try:
        _replace(DROPIN, BACKUP.read_bytes(), NEW)
    except Drift as e:
        journal('rollback-refused', why=str(e), dropin=sha(DROPIN)); return {'state': 'rollback-refused-drift', 'why': str(e), 'dropin': sha(DROPIN)}
    journal('restored-dropin')
    try:
        reload_and_check(OLD_ARGV)
        restart(OLD_ARGV, 'old')
        ev = verify_old(pre)
    except Exception as e:
        journal('rollback-unverified', why=str(e)[:500]); return {'state': 'rollback-unverified', 'why': str(e)[:500], 'unit': unit_state()}
    journal('rollback-done', pid=ev['pid'])
    return {'state': 'rolled-back', 'verified': True, 'evidence': ev}


def restarts_unverified():
    n = 0
    for e in journal_entries():
        if e['event'] == 'restart' and e.get('target') == 'new':
            n += 1
        if e['event'] in ('verified', 'rollback-done'):
            n = 0
    return n


def preconditions(require_new=False):
    problems = []
    if sha(OLD_BUNDLE) != P['old_bundle_sha256']: problems.append('old bundle hash differs')
    if sha(P['config_path']) != P['config_sha256']: problems.append('config hash differs')
    if require_new and sha(BUNDLE) != P['bundle_sha256']: problems.append('new bundle hash differs')
    r = subprocess.run([P['node'], '--version'], capture_output=True, text=True)
    if not r.stdout.startswith('v22.'): problems.append('node is %s, expected v22.x' % r.stdout.strip())
    return problems


def validate_routes_baseline(routes):
    if not isinstance(routes, dict) or not isinstance(routes.get('deployments'), dict) or not isinstance(routes.get('labels'), dict):
        raise RuntimeError('healthy route baseline unavailable')
    if len(routes['deployments']) < max(1, P.get('minimum_routes', 1)) or any(l not in routes['labels'] for l in P['critical_labels']):
        raise RuntimeError('healthy route baseline lacks required deployments or labels')


def pre_snapshot():
    snap = {'state': state_snapshot()}
    s, b = get('/v1/network/routes', timeout=15)
    if s != 200:
        raise RuntimeError('healthy route baseline unavailable: HTTP %s' % s)
    validate_routes_baseline(b)
    snap['routes'] = b
    return snap


def baseline_context():
    return {**{k: P[k] for k in ('unit', 'dropin', 'base_dropin_sha256', 'new_dropin_sha256',
                             'bundle_path', 'bundle_sha256', 'old_bundle_path', 'old_bundle_sha256',
                             'config_path', 'config_sha256', 'state_dir', 'critical_labels')},
            'minimum_routes': P.get('minimum_routes', 1)}


def save_baseline(pre):
    data = (json.dumps({'version': 1, 'context': baseline_context(), 'pre': pre}, sort_keys=True) + '\n').encode()
    _replace(BASELINE, data, sha(BASELINE) or 'absent', mode=0o600)
    journal('baseline', sha256=hashlib.sha256(data).hexdigest())


def load_baseline():
    if not BASELINE.exists() or BASELINE.stat().st_size > 8 * 1024 * 1024:
        raise RuntimeError('durable initial baseline missing or oversized; outcome unverified')
    data = BASELINE.read_bytes()
    events = [e for e in journal_entries() if e['event'] == 'baseline']
    if not events or events[-1].get('sha256') != hashlib.sha256(data).hexdigest():
        raise RuntimeError('durable initial baseline is not journal-bound; outcome unverified')
    doc = json.loads(data)
    if doc.get('version') != 1 or doc.get('context') != baseline_context():
        raise RuntimeError('durable initial baseline belongs to a different activation')
    validate_routes_baseline(doc['pre']['routes'])
    return doc['pre']


def status():
    u = unit_state()
    return {'dropin': sha(DROPIN), 'isBase': sha(DROPIN) == BASE, 'isNew': sha(DROPIN) == NEW, 'backup': sha(BACKUP), 'bundle': sha(BUNDLE),
            'loadedArgv': u['loadedArgv'], 'running': u['cmdline'], 'active': u['active'], 'pid': u['pid'], 'preconditionProblems': preconditions(),
            'journalTail': journal_entries()[-6:]}


def apply():
    cur = sha(DROPIN)
    if cur == NEW:
        problems = preconditions(require_new=True)
        if problems:
            return {'state': 'refused', 'error': '; '.join(problems)}
        u = unit_state()
        pre = load_baseline()
        if u['loadedArgv'] == NEW_ARGV and u['cmdline'] == NEW_ARGV and u['active'] == 'active':
            ev = verify_new(pre); journal('verified', reconciled=True)
            return {'state': 'active', 'restarted': False, 'evidence': ev}
        if restarts_unverified() >= CAP:
            return {'state': 'refused', 'error': '%d unverified restarts already recorded: operator review, no further restart' % CAP}
        try:
            reload_and_check(NEW_ARGV); restart(NEW_ARGV, 'new'); ev = verify_new(pre)
        except Exception as e:
            return {'error': str(e)[:500], **rollback(str(e), pre)}
        journal('verified', reconciled=True)
        return {'state': 'active', 'restarted': True, 'evidence': ev}
    if cur != BASE:
        return {'state': 'refused', 'error': 'drop-in drifted from the reviewed baseline (%s): nothing changed' % cur}
    u = unit_state()
    if u['loadedArgv'] != OLD_ARGV or u['cmdline'] != OLD_ARGV or u['active'] != 'active':
        return {'state': 'refused', 'error': 'unit is not running the reviewed old runtime: %s' % u}
    problems = preconditions()
    if problems:
        return {'state': 'refused', 'error': '; '.join(problems)}
    data = base64.b64decode(P['bundle_b64'])
    if hashlib.sha256(data).hexdigest() != P['bundle_sha256'] or hashlib.sha256(NEW_BYTES).hexdigest() != NEW:
        return {'state': 'refused', 'error': 'bundle or drop-in bytes do not match the reviewed hashes'}
    if sha(BUNDLE) not in (None, P['bundle_sha256']):
        return {'state': 'refused', 'error': 'a different file exists at the bundle path: operator review'}
    if sha(BACKUP) not in (None, BASE):
        return {'state': 'refused', 'error': 'existing backup is not the baseline drop-in: never overwritten'}
    try:
        pre = pre_snapshot()
    except Exception as e:
        return {'state': 'refused', 'error': 'initial verification failed: ' + str(e)[:500]}
    save_baseline(pre)
    if sha(BUNDLE) is None:
        BUNDLE.parent.mkdir(mode=0o755, exist_ok=True)
        _replace(BUNDLE, data, 'absent')
    # Load check: import the module (its main guard does not start a server under -e) with the real node.
    r = subprocess.run([P['node'], '--input-type=module', '-e', 'const m=await import(process.argv[1]);if(typeof m.runDirectory!=="function")process.exit(3)', 'file://' + str(BUNDLE)],
                       capture_output=True, text=True, timeout=60)
    if r.returncode:
        return {'state': 'refused', 'error': 'bundle load check failed: ' + r.stderr[-400:]}
    journal('bundle-ready', sha=P['bundle_sha256'])
    if sha(BACKUP) is None:
        _replace(BACKUP, DROPIN.read_bytes(), 'absent')
        if sha(BACKUP) != BASE:
            BACKUP.unlink(); return {'state': 'refused', 'error': 'drop-in changed while backing up: nothing installed'}
        journal('backup', sha=BASE)
    try:
        _replace(DROPIN, NEW_BYTES, BASE)
    except Drift as e:
        journal('refused', why=str(e)); return {'state': 'refused', 'error': str(e)}
    journal('installed', dropin=NEW)
    try:
        reload_and_check(NEW_ARGV)
    except Exception as e:
        # Not restarted: the old runtime is still running. Restore the drop-in (only if still ours) and reload.
        try:
            _replace(DROPIN, BACKUP.read_bytes(), NEW); systemctl('daemon-reload')
            journal('refused', why='daemon-reload: ' + str(e)[:300], restored=True)
            return {'state': 'refused', 'error': str(e)[:500], 'restoredDropin': True, 'unit': unit_state()}
        except Drift as d:
            journal('rollback-refused', why=str(d)); return {'state': 'rollback-refused-drift', 'why': str(d)}
    try:
        restart(NEW_ARGV, 'new')
        ev = verify_new(pre)
    except Exception as e:
        return {'error': str(e)[:500], **rollback(str(e), pre)}
    journal('verified')
    return {'state': 'active', 'restarted': True, 'evidence': ev}


def do_rollback():
    cur = sha(DROPIN)
    problems = preconditions()
    if problems:
        return {'state': 'rollback-refused-drift', 'why': '; '.join(problems)}
    pre = load_baseline()
    if cur == NEW:
        return rollback('operator rollback', pre)
    if cur != BASE:
        return {'state': 'refused', 'error': 'drop-in is neither baseline nor new (%s): nothing changed' % cur}
    u = unit_state()
    if u['loadedArgv'] == OLD_ARGV and u['cmdline'] == OLD_ARGV and u['active'] == 'active':
        try:
            return {'state': 'baseline', 'restarted': False, 'evidence': verify_old(pre)}
        except Exception as e:
            return {'state': 'rollback-unverified', 'why': str(e)[:500], 'unit': u}
    # Baseline drop-in but the old runtime is not what runs (an earlier restore whose restart was never confirmed).
    try:
        reload_and_check(OLD_ARGV); restart(OLD_ARGV, 'old'); ev = verify_old(pre)
    except Exception as e:
        journal('rollback-unverified', why=str(e)[:500]); return {'state': 'rollback-unverified', 'why': str(e)[:500], 'unit': unit_state()}
    journal('rollback-done', pid=ev['pid'])
    return {'state': 'rolled-back', 'verified': True, 'restarted': True, 'evidence': ev}


def main():
    mode = P['mode']
    try:
        lock = open(LOCK, 'a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'mode': mode, 'state': 'refused', 'error': 'runtime lock held by another run'}, sort_keys=True)); sys.exit(1)
    try:
        out = {'status': lambda: {'state': 'status', **status()}, 'apply': apply, 'rollback': do_rollback}[mode]()
    except Exception as e:
        out = {'state': 'error', 'error': (type(e).__name__ + ': ' + str(e))[:800]}
    if mode != 'status':
        try:
            out['after'] = status()
        except Exception as e:
            out['after'] = {'error': str(e)[:200]}
    print(json.dumps({'mode': mode, **out}, sort_keys=True))
    ok = out['state'] in ('status', 'active') if mode != 'rollback' else out['state'] in ('rolled-back', 'baseline')
    sys.exit(0 if ok else 1)


if not globals().get('NO_MAIN'):   # unit tests exec this file with NO_MAIN to reach the helpers
    main()
