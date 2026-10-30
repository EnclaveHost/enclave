#!/usr/bin/env python3
"""reproof.py (base-finality-proof-stage/r7; PREPARED; NOT run): the ROOT-ONLY live finality qualification / re-proof path that the
source units drive (enclave-base-finality-reproof.timer). After a launch's first start or any ordinary restart the readiness gates refuse
until a NEW proof for the running process is durably recorded; this runs exactly the reviewed steps, nothing else:
  1. finality_state status: already qualified AND recorded for the running process -> nothing to do (status republished)
  1a. r8: a DURABLE pending proof (an interrupted record: watermark landed, journal event not) is ADOPTED first (producer
      adopt_pending); a CURRENT qualified-but-unrecorded proof is RECORDED (record_finality). Only then, if still not current
      for this process, a NEW proof - so a newer proof is never recorded on top of an unadopted one (no journal mismatch)
  2. the harness's pinned capture module (load_capture: HOLD until A1_CAPTURE_REVIEWED) - an `initial` capture of the current
     anchor game, then a `recheck-capture` of exactly it, with the module's own reviewed Sources and pins (never a stub or receipt)
  3. finality_state qualify(write=True): harness gate_a1 + the shared admission ledger + the pinned core over the bound node
  4. the producer's record_finality: the finality-proof watermark entry + the launch journal's `bootstrapped` (recordedAs)
  5. finality_state status-publish
One run at a time (flock); capture pairs under a root 0700 directory, the newest KEEP kept. r10-ops-followup: every attempt ends with a
receipt (attempt.json + one fsynced line of the never-pruned attempts.jsonl history); a failed or interrupted attempt is renamed
failed-<stamp> and only the newest FAILED_KEEP keep their bytes; an attempt is never touched while active (marker + lock).
r2 (journal-aware): only KNOWN-failed attempts are retired - those that never passed their qualify barrier, or whose durable records
(_durable) are byte-identical to the barrier digest. Any other attempt is AMBIGUOUS: preserved in place, never renamed, pruned or deleted
by reproof (recovery policy: logs/claude-r10-ops-followup-r2.md). Exit: 0 done/nothing to do, 75 retry
later (no newer anchor game yet, a capture failed, the node is behind or restarting), 78 HOLD (a review flag is False), 1 refused."""
import datetime, fcntl, functools, hashlib, json, os, pathlib, shutil, stat, sys, types

FORMAT = 'enclave-base-finality-reproof/v1'
CONFIG_KEYS = {'format', 'launchDir', 'chainJson', 'rpcUrl', 'statusOut', 'node', 'depsRoot', 'workdir', 'capturesRoot', 'captureSources'}
FINALITY_STATE = (pathlib.Path('/opt/enclave-rpc/finality/src/finality_state.py'), '608565123278e1d877abffe02fc762aba3fccee6c89e249f3ee6d808b618704e')
PRODUCER = (pathlib.Path('/opt/enclave-rpc/base-launch/base_launch.py'), '5e567c93676a7f7fd48040a7f90ffae860f454a0a69efd8f3f1445a5b87b224b')   # production-bootstrap-wiring: produce creates finality/
KEEP, TEMPFAIL, HOLD = 4, 75, 78
FAILED_KEEP, HISTORY, IN_PROGRESS = 2, 'attempts.jsonl', '.in-progress'      # r10-ops-followup: bounded failed-attempt retention
QUALIFY_BARRIER, PRESERVED = '.qualify-barrier', ('ambiguous', 'qualified-unrecorded')   # r2: never removed by reproof
HOLD_CODES = {'hold_prototype', 'a1_capture_pending', 'hold_finality'}
RETRY_CODES = {'not_newer', 'same_game', 'stale_l1', 'not_post_anchor', 'capture', 'a1_stale', 'a1_stale_at_append', 'not_synced',
               'process_changed', 'process_binding', 'launch_changed', 'not_started', 'not_qualified'}


class Refused(Exception):
    def __init__(self, code, why):
        super().__init__(f'{code}: {why}'); self.code = code


def code_of(e):
    return getattr(e, 'code', None) or str(e).split(':', 1)[0]


def _read_root(p, cap=1 << 20, owner=0):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != owner or st.st_mode & 0o022:
            raise Refused('untrusted_file', f'{p} must be a root-owned regular file, not group/other writable')
        return f.read(cap)


def load_config(path, owner=0):
    c = json.loads(_read_root(path, owner=owner))
    if not isinstance(c, dict) or set(c) != CONFIG_KEYS or c['format'] != FORMAT or not all(isinstance(c[k], str) and c[k] for k in CONFIG_KEYS):
        raise Refused('bad_config', f'the re-proof config must be exactly {sorted(CONFIG_KEYS)} (no missing value)')
    return c


def _status(F, W, c, top, proc):
    return F.status(c['launchDir'], c['chainJson'], pathlib.Path(c['launchDir']) / 'finality', c['rpcUrl'], W=W, top=top, proc=proc)


def _prune(root, keep=KEEP):
    pairs = sorted(p for p in pathlib.Path(root).iterdir() if p.is_dir() and not p.is_symlink() and p.name[:1].isdigit() and not _held(p))
    for p in pairs[:-keep] if len(pairs) > keep else []:
        shutil.rmtree(p)


def _write_new(p, b):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, b); os.fsync(fd)
    finally:
        os.close(fd)


def _receipt(root, d, rec):
    """r10-ops-followup: the attempt's receipt, inside its directory AND appended (fsynced, 0600) to the root's history, which no prune
    ever touches (a few hundred bytes per attempt), so a removed attempt's outcome stays on record; then the attempt is no longer active"""
    b = json.dumps(rec, sort_keys=True, default=str).encode() + b'\n'
    if not os.path.lexists(d / 'attempt.json'):                                    # a crash after it: the first receipt stands
        _write_new(d / 'attempt.json', b)
    fd = os.open(root / HISTORY, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, b); os.fsync(fd)
    finally:
        os.close(fd)
    if os.path.lexists(d / IN_PROGRESS):
        os.unlink(d / IN_PROGRESS)


def _retire(root, d, rec):
    """a failed or interrupted attempt (nothing qualified, so nothing can adopt it): its receipt, then renamed out of the proof-pair
    namespace; only the newest FAILED_KEEP retired attempts keep their bytes (each is about 38 MB / 11.9k files)"""
    _receipt(root, d, rec); os.rename(d, root / f'failed-{d.name}')
    failed = sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink() and p.name.startswith('failed-'))
    for p in failed[:-FAILED_KEEP]:
        shutil.rmtree(p)


def _held(p):
    """r2: an attempt reproof must never remove: still in progress, or preserved (ambiguous / qualified-unrecorded)"""
    if os.path.lexists(p / IN_PROGRESS):
        return True
    try:
        return json.loads((p / 'attempt.json').read_bytes()).get('outcome') in PRESERVED
    except FileNotFoundError:
        return False                                                       # a recorded pair written before this change
    except (OSError, ValueError):
        return True                                                        # unreadable receipt: keep


def _durable(c, W, root):
    """r2: a digest of EVERY durable record a qualification or a record can write - the launch directory (finality journal, launch
    journal, launch record), the shared A1 admission ledger and the watermark store (finality_state.qualify/append, gate_a1 admission,
    base_launch.record_finality/adopt_pending read and write only these). Empty files (locks) carry no record and are skipped; the
    capture root, workdir and status file are not records. Taken at the qualify barrier and compared after a failure or a kill."""
    skip = [pathlib.Path(root), pathlib.Path(c['workdir']), pathlib.Path(c['statusOut'])]
    h = hashlib.sha256()
    for base in (c['launchDir'], getattr(W, 'A1_ADMISSION_LEDGER', None), getattr(W, 'BOOTSTRAP_WATERMARK', None)):
        p = pathlib.Path(str(base)) if base is not None else None
        files = [] if p is None else [p] if p.is_file() else sorted(x for x in p.rglob('*') if x.is_file()) if p.is_dir() else []
        h.update(f'{base}\0{len(files)}\0'.encode())
        for f in files:
            if any(f == s or s in f.parents for s in skip) or f.stat().st_size == 0:
                continue
            h.update(f'{f}\0'.encode() + hashlib.sha256(f.read_bytes()).digest())
    return h.hexdigest()


def _sweep(root, now, c, W):
    """under the lock (no attempt is active): an attempt still marked in progress was cut off by a crash or kill (no receipt).
    Before its qualify barrier nothing durable can name it: retired. After the barrier it is retired ONLY if every durable record is
    byte-identical to the barrier digest; any difference (a qualification, an admission, a record - or any other writer since) makes
    it AMBIGUOUS: its receipt is written and its bytes stay in place, never renamed or deleted (recovery policy: the report)"""
    cur = None
    for p in sorted(root.iterdir()):
        if not (p.is_dir() and not p.is_symlink() and p.name[:1].isdigit() and os.path.lexists(p / IN_PROGRESS)):
            continue
        rec = {'outcome': 'interrupted', 'attempt': p.name, 'at': now.isoformat(), 'phase': 'before-qualify-barrier'}
        if os.path.lexists(p / QUALIFY_BARRIER):
            cur = cur or _durable(c, W, root)
            if (p / QUALIFY_BARRIER).read_text().strip() != cur:
                _receipt(root, p, {**rec, 'outcome': 'ambiguous', 'phase': 'after-qualify-barrier, durable records changed'}); continue
            rec['phase'] = 'after-qualify-barrier, durable records unchanged'
        _retire(root, p, rec)


def _settle(root, d, rec, q, before, c, W):
    """r2: an attempt that raised in THIS process. Qualified (q), or ANY durable change since its barrier (qualify may append and then
    raise before q is bound) -> preserved with its receipt; otherwise known failed -> retired. A SIGKILL skips this: _sweep decides."""
    if q:
        _receipt(root, d, {**rec, 'outcome': 'qualified-unrecorded', 'seq': q.get('seq')})
    elif before is not None and _durable(c, W, root) != before:
        _receipt(root, d, {**rec, 'outcome': 'ambiguous', 'phase': 'after-qualify-barrier, durable records changed'})
    else:
        _retire(root, d, rec)


def run(c, *, F, W, R, P, capture_fn=None, top='/', proc='/proc', now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc); root = pathlib.Path(c['capturesRoot'])
    if not root.is_dir() or root.is_symlink() or os.stat(root).st_mode & 0o077:
        raise Refused('captures_root', f'{root} must be an existing private (0700) directory')
    lk = os.open(root / '.reproof.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        try:
            fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('busy', 'another re-proof is running')
        _sweep(root, now, c, W)
        s = _status(F, W, c, top, proc)
        if s.get('qualified') is True and s.get('recordedAs'):
            return {'action': 'none', 'state': s['state'], 'published': F.publish_status(s, c['statusOut'], top=top)}
        fdir = pathlib.Path(c['launchDir']) / 'finality'
        Fp = types.SimpleNamespace(OWNER=F.OWNER, Refused=F.Refused, load_launch=F.load_launch, entries=F.entries,
                                   status=functools.partial(F.status, proc=proc))
        adopted = P.adopt_pending(c['launchDir'], fdir, W=W, F=Fp, owner=F.OWNER, top=top, watermark=W.BOOTSTRAP_WATERMARK)
        if adopted or s.get('qualified') is True:
            if not adopted:                                                        # current for THIS process, never recorded
                P.record_finality(c['launchDir'], c['chainJson'], fdir, c['rpcUrl'], W=W, F=Fp, owner=F.OWNER, top=top, watermark=W.BOOTSTRAP_WATERMARK)
            s = _status(F, W, c, top, proc)
            if s.get('qualified') is True and s.get('recordedAs'):
                return {'action': 'adopted' if adopted else 'recorded', 'state': s['state'], 'published': F.publish_status(s, c['statusOut'], top=top)}
        C = R.load_capture()                                                       # HOLD until the capture module is reviewed
        # production-capture-closure: the root-reviewed guest Sources (never the module's workstation defaults)
        cap = capture_fn or (lambda mode, out, initial=None: C.capture(mode, str(out), src=C.Sources.from_settings(c['captureSources'], initial_capture=initial)))
        d = root / now.strftime('%Y%m%dT%H%M%S%fZ'); os.mkdir(d, 0o700)
        _write_new(d / IN_PROGRESS, b'')                                             # active until its receipt; a kill leaves it for _sweep
        q = before = None
        try:
            for mode, out, initial in (('initial', d / 'initial', None), ('recheck-capture', d / 'recheck', d / 'initial')):
                ok, res = cap(mode, out, initial)
                if not ok:
                    raise Refused('capture', f'{mode} capture failed: {str((res or {}).get("error") or res)[:200]}')
            before = _durable(c, W, root); _write_new(d / QUALIFY_BARRIER, before.encode())   # r2: the barrier; a proof may land after it
            dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
            q = F.qualify(c['launchDir'], c['chainJson'], fdir, {'initialOut': str(d / 'initial'), 'recheckOut': str(d / 'recheck')}, c['rpcUrl'],
                          W=W, R=R, node=c['node'], deps_root=c['depsRoot'], workdir=c['workdir'], write=True, top=top, proc=proc)
            r = P.record_finality(c['launchDir'], c['chainJson'], fdir, c['rpcUrl'], W=W, F=Fp, owner=F.OWNER, top=top, watermark=W.BOOTSTRAP_WATERMARK)
        except BaseException as e:
            rec = {'outcome': 'failed', 'attempt': d.name, 'code': code_of(e), 'error': str(e)[:500], 'at': now.isoformat()}
            try:
                _settle(root, d, rec, q, before, c, W)
            except OSError:
                pass                                     # the marker stays: the next run retires it under the lock; the refusal stands
            raise
        _receipt(root, d, {'outcome': 'recorded', 'attempt': d.name, 'seq': q['seq'], 'freshN': q['fresh']['N'], 'recorded': r.get('watermarkEntrySha256'), 'at': now.isoformat()})
        pub = F.publish_status(_status(F, W, c, top, proc), c['statusOut'], top=top)
        _prune(root)
        return {'action': 'reproved', 'seq': q['seq'], 'freshN': q['fresh']['N'], 'recorded': r.get('watermarkEntrySha256'), 'published': pub}
    finally:
        os.close(lk)


def _exec_pinned(name, path, pin):
    b = _read_root(path, 8 << 20)
    if hashlib.sha256(b).hexdigest() != pin:
        raise Refused('source_pin', f'{path} is not the reviewed {pin[:12]}...')
    m = types.ModuleType(name); m.__file__ = str(path); sys.modules[name] = m
    exec(compile(b, str(path), 'exec'), m.__dict__)
    return m


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    if len(argv) != 2:
        print(__doc__); return 2
    try:
        c = load_config(argv[1])
        F = _exec_pinned('finality_state', *FINALITY_STATE); W = F.load_wrapper(); R = F.load_harness()
        P = _exec_pinned('base_launch', *PRODUCER)
        r = run(c, F=F, W=W, R=R, P=P)
    except Exception as e:                                                         # every refusal class maps to one exit code
        k = code_of(e); rc = HOLD if k in HOLD_CODES else TEMPFAIL if k in RETRY_CODES else 1
        print(json.dumps({'ok': False, 'code': k, 'refused': str(e)[:500], 'exit': rc})); return rc
    print(json.dumps({'ok': True, **r}, default=str)); return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
