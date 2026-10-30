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
One run at a time (flock); capture pairs under a root 0700 directory, the newest KEEP kept. Exit: 0 done/nothing to do, 75 retry
later (no newer anchor game yet, a capture failed, the node is behind or restarting), 78 HOLD (a review flag is False), 1 refused."""
import datetime, fcntl, functools, hashlib, json, os, pathlib, shutil, stat, sys, types

FORMAT = 'enclave-base-finality-reproof/v1'
CONFIG_KEYS = {'format', 'launchDir', 'chainJson', 'rpcUrl', 'statusOut', 'node', 'depsRoot', 'workdir', 'capturesRoot', 'captureSources'}
FINALITY_STATE = (pathlib.Path('/opt/enclave-rpc/finality/src/finality_state.py'), '2fb4b6a854f6e4f187a25a01dfb34fd5682d6d58faa42aa5dc21ec5d7b4f8b0c')
PRODUCER = (pathlib.Path('/opt/enclave-rpc/base-launch/base_launch.py'), 'd7289489e7b9fb5a79f751135ece3b142a2d60f099dc9e9bdc730bc338077b2b')
KEEP, TEMPFAIL, HOLD = 4, 75, 78
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
    pairs = sorted(p for p in pathlib.Path(root).iterdir() if p.is_dir() and not p.is_symlink() and p.name[:1].isdigit())
    for p in pairs[:-keep] if len(pairs) > keep else []:
        shutil.rmtree(p)


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
        for mode, out, initial in (('initial', d / 'initial', None), ('recheck-capture', d / 'recheck', d / 'initial')):
            ok, res = cap(mode, out, initial)
            if not ok:
                raise Refused('capture', f'{mode} capture failed: {str((res or {}).get("error") or res)[:200]}')
        q = F.qualify(c['launchDir'], c['chainJson'], fdir, {'initialOut': str(d / 'initial'), 'recheckOut': str(d / 'recheck')}, c['rpcUrl'],
                      W=W, R=R, node=c['node'], deps_root=c['depsRoot'], workdir=c['workdir'], write=True, top=top, proc=proc)
        r = P.record_finality(c['launchDir'], c['chainJson'], fdir, c['rpcUrl'], W=W, F=Fp, owner=F.OWNER, top=top, watermark=W.BOOTSTRAP_WATERMARK)
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
