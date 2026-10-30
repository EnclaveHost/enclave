#!/usr/bin/env python3
"""base_launch.py: OFFLINE, ROOT-ONLY producer of the M10 bootstrap launch evidence and the explicit lifecycle transitions
consumed by the candidate wrapper (base-wrapper-integration-stage/src/chain_service.py bootstrap_anchor_args).
PREPARED; NOT run.

`produce` reads ONLY the completed A2-A4 workdir of the reviewed harness (a2-v2-release-bound a2a4.py, source pin below)
and re-validates it with THAT module's own functions:
  - load_config, A1_INITIAL_SHA256, MAINNET, journal_digest, _trusted_sha (root-owned download receipt), MANIFEST_SHA;
  - check_bytecode_receipt, bytecode_gap_closed, OPEN_GAPS;
plus the record relationships that step_release established (A2 anchor = A4 = m10-launch anchor at N, A1 gate =
config N/root/game and the pinned initial receipt, A3 checkpoints at N, the bytecode receipt bound to this A4, the journal,
the download receipt and the snapshot manifest, DB file identity unchanged since the scan). It also requires a fresh,
successful `release` run record, the staged release binary (4a7c013a..., fixed path, root-owned, no symlinks), and the
wrapper's offline coverage binding for that binary (the snapshot manifest must be the one A2-A4 pinned).
Nothing is fabricated: a missing or inconsistent input refuses with a coded reason.

Output: a NEW directory published atomically (rename of a fully written sibling), never overwritten:
  launch.json (enclave-base-bootstrap-launch/v1) + qualification/{m10-launch,a2-authenticated,a4-rebuilt,bytecodes-verified}.json
  (byte-exact copies). Root then pins its sha256 in chain.json baseBootstrap.anchorLaunch (a reviewed manual step).

Lifecycle (lifecycle.json, enclave-base-bootstrap-lifecycle/v1; hash-chained history, atomic replace):
  init                  -> anchor-pending   (only while the launch record is fresh: now <= notAfter)
  mark-started          anchor-pending -> anchor-started    (after the FIRST anchored start was issued; the wrapper then
                                                             refuses to start, so the anchor is never replayed blindly)
  rearm                 anchor-started -> anchor-pending    (only with STOPPED-DB evidence via the harness's own runner:
                                                             units stopped, every stage checkpoint == N, header N
                                                             authenticates to the anchor hash, no header above N)
  record-bootstrapped   anchor-started -> bootstrapped      HOLD: no reviewed finality proof (see FINALITY_PROOF_REVIEWED)
  rollback              any non-terminal -> rolled-back     (terminal: every later transition refuses)
"""
import datetime, hashlib, importlib.util, json, os, pathlib, re, stat, sys

A2A4_SOURCE_SHA256 = 'abe223d6a0c6c203f7d76aaa4c68d25f8f7ecb74894e64dd838383abf6aeeadd'   # a2-v2-release-bound-prepared/stage/a2a4.py
A2A4_SOURCE = pathlib.Path('/opt/enclave-rpc/a2a4/a2a4.py')      # root installs the reviewed stage there (HOLD: not installed)
HARNESS_BINARY_SHA256 = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'  # selection.BASE_BINARY_SHA256 (A2-A4 runs this)
BASE_RELEASE_SHA256 = '4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f'   # m7-m10-release-completed-0055
BASE_RELEASE_PATH = pathlib.Path('/opt/enclave-rpc/releases/base-m7m10-4a7c013a510f8816/base')
LAUNCH_FORMAT = 'enclave-base-bootstrap-launch/v1'                # == wrapper candidate LAUNCH_FORMAT
LIFECYCLE_FORMAT = 'enclave-base-bootstrap-lifecycle/v1'          # == wrapper candidate LIFECYCLE_FORMAT
QUAL = {'m10LaunchSha256': 'm10-launch.json', 'a2Sha256': 'a2-authenticated.json', 'a4Sha256': 'a4-rebuilt.json',
        'bytecodesVerifiedSha256': 'bytecodes-verified.json'}
MAX_RECORD = 64 << 20
# HOLD (fail closed): an L2 block number/hash read from our own node is NOT finality evidence, and no reviewed proof that
# finality passed N exists. A reviewed design would need: a fresh A1-authenticated receipt (the harness's A1 gate rules) naming
# N' > N with its output root, and our node's header N' authenticated against that root (the harness's authenticate()), with
# N' a descendant of the anchor. Until such a validator is reviewed, `record-bootstrapped` refuses. Source constant, not config.
FINALITY_PROOF_REVIEWED = False
TERMINAL = {'rolled-back'}
TRANSITIONS = {('anchor-pending', 'anchor-started'), ('anchor-started', 'anchor-pending'), ('anchor-started', 'bootstrapped')}


class Refused(Exception):
    pass


def refuse(code, why):
    raise Refused(f'{code}: {why}')


sha = lambda b: hashlib.sha256(b).hexdigest()


def load_a2a4(path=A2A4_SOURCE, pin=A2A4_SOURCE_SHA256):
    """The reviewed harness module, exactly the pinned bytes (its own selection.py beside it)."""
    p = pathlib.Path(path)
    if sha(p.read_bytes()) != pin:
        refuse('a2a4_source', f'{p} is not the reviewed A2-A4 harness {pin[:12]}...')
    sys.path.insert(0, str(p.parent))
    spec = importlib.util.spec_from_file_location('a2a4_reviewed', p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def secure_path(path, owner, leaf='file', top='/'):
    """No symlink in any component from `top` down, every component owned by `owner` and not group/other writable."""
    top, p = pathlib.Path(top), pathlib.Path(path)
    if not (p.is_absolute() and '..' not in p.parts and (p == top or top in p.parents)):
        refuse('path', f'{p} is not a plain path under {top}')
    cur, st = top, None
    for part in [None] + list(p.relative_to(top).parts):
        cur = cur / part if part else cur
        st = os.lstat(cur)
        if stat.S_ISLNK(st.st_mode) or st.st_uid != owner or st.st_mode & 0o022:
            refuse('path', f'{cur} is a symlink, not owned by {owner}, or group/other writable')
    if not (stat.S_ISREG if leaf == 'file' else stat.S_ISDIR)(st.st_mode):
        refuse('path', f'{p} is not a regular {leaf}')


def read_record(p):
    """Exact bytes of a harness record: a regular, non-symlink file within bounds (no following, no truncation)."""
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        refuse('record_missing', f'{pathlib.Path(p).name} unreadable ({type(e).__name__})')
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_RECORD:
            refuse('record_invalid', f'{pathlib.Path(p).name} is not a bounded regular file')
        b = os.read(fd, MAX_RECORD + 1)
    finally:
        os.close(fd)
    try:
        return b, json.loads(b)
    except ValueError:
        refuse('record_invalid', f'{pathlib.Path(p).name} is not JSON')


def latest_release_run(w):
    """The NEWEST run record of any step must be a successful `release` (no step may have run after it)."""
    recs = sorted(w.glob('run-*-*.json'), key=lambda p: p.name.rsplit('-', 1)[-1])
    if not recs:
        refuse('release_run', 'no harness run records')
    last = recs[-1]
    b, rec = read_record(last)
    if not last.name.startswith('run-release-') or rec.get('step') != 'release' or rec.get('ok') is not True or 'refused' in rec:
        refuse('release_run', f'the newest harness run ({last.name}) is not a successful release')
    return b, rec


def _ts(s, what):
    try:
        t = datetime.datetime.fromisoformat(s)
    except (TypeError, ValueError):
        refuse('time', f'{what} is not an ISO timestamp')
    if t.tzinfo is None:
        refuse('time', f'{what} has no timezone')
    return t


def produce(cfg_path, out_dir, *, A, coverage, release_path=BASE_RELEASE_PATH, release_sha=BASE_RELEASE_SHA256,
            harness_binary_sha=HARNESS_BINARY_SHA256, owner=0, top='/', now=None):
    """-> {'launchSha256', 'dir'}; refuses unless every binding holds (see module docstring)."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    cfg_bytes = pathlib.Path(cfg_path).read_bytes()
    c = A.load_config(str(cfg_path))                                     # the harness's own strict config parser
    w = pathlib.Path(c['workdir']); N = c['N']
    if c['baseBinarySha256'] != harness_binary_sha:
        refuse('harness_binary', 'the A2-A4 config does not pin the reviewed harness base binary')
    run_b, run = latest_release_run(w)
    files = {k: read_record(w / f) for k, f in QUAL.items()}
    a3_b, a3 = read_record(w / 'a3-unwound.json')
    (m10_b, m10), (a2_b, a2), (a4_b, a4), (bv_b, bv) = (files[k] for k in ('m10LaunchSha256', 'a2Sha256', 'a4Sha256', 'bytecodesVerifiedSha256'))
    anchor = f'{N}:{a4.get("blockHash")}'
    # --- A2 / A4 / A3 at exactly N (what step_a2..a4 recorded) ---
    au = a2.get('anchor') or {}
    if au.get('number') != N or au.get('blockHash') != a4.get('blockHash') or a4.get('verifiedStateAt') != N or a4.get('stateRoot') != au.get('stateRoot'):
        refuse('a2_a4', 'A2 anchor, A4 rebuild and N disagree')
    if not re.fullmatch(r'0x[0-9a-f]{64}', str(a4.get('blockHash'))):
        refuse('a2_a4', 'A4 block hash is not lower-case 0x + 64 hex')
    cps = a3.get('checkpoints') or {}
    if set(cps) != {'headers', 'bodies', 'execution', 'merkle-execute', 'finish'} or any(v != N for k, v in cps.items() if k != 'merkle-execute') \
            or not cps['merkle-execute'] <= N:
        refuse('a3', 'A3 checkpoints are not at N')
    # --- A1 (the gate result A2 recorded; release re-bound it with bind_a1) ---
    g = a2.get('a1Gate') or {}
    if g.get('initialSha256') != A.A1_INITIAL_SHA256 or str(g.get('N')) != str(N) or str(g.get('outputRoot', '')).lower() != c['outputRoot'] \
            or str(g.get('game', '')).lower() != c['game'] or str(g.get('asr', '')).lower() != A.MAINNET['asr'] or not isinstance(g.get('l1Finalized'), int):
        refuse('a1', 'the A1 gate recorded by A2 is not the pinned initial receipt / planned N, root, game, ASR')
    # --- bytecode gap: closed ONLY by the harness's own rule, for THIS A4, journal, download receipt, manifest ---
    if bv.get('a4Sha256') != sha(a4_b) or bv.get('journal') != A.journal_digest(w) or bv.get('manifestSha256') != A.MANIFEST_SHA \
            or bv.get('downloadReceiptSha256') != A._trusted_sha(c['downloadReceipt'], 'receipt', 1 << 20):
        refuse('bytecodes_stale', 'bytecode verification is not bound to this A4, journal, manifest and download receipt')
    raw_b = (w / 'cmd' / str(bv.get('receiptFile', ''))).read_bytes() if (w / 'cmd' / str(bv.get('receiptFile', ''))).is_file() else b''
    if sha(raw_b) != bv.get('receiptSha256') or json.loads(raw_b or b'null') != bv.get('result'):
        refuse('bytecodes_stale', 'the stored checker receipt differs from the bound one')
    gaps = [x for x in A.OPEN_GAPS if not (x == 'bytecodes-content-unverified' and A.bytecode_gap_closed(c, bv))]
    if gaps or A.check_bytecode_receipt(c, bv['result']) != 'v2':
        refuse('open_gaps', f'derivation stays blocked: {gaps or ["bytecode receipt is not v2"]}')
    ident = bv.get('identity') or {}
    st = os.stat(pathlib.Path(c['datadir'], 'db', 'mdbx.dat'))
    if ident.get('headerN') != a4['blockHash'] or ident.get('mdbx') != {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns}:
        refuse('db_changed', 'the datadir changed since the bytecode scan (or is another DB)')
    # --- the release record of the harness ---
    if m10.get('bootstrapAnchor') != anchor or m10.get('bytecodes') != {k: bv[k] for k in ('checkerSha256', 'receiptSha256', 'receiptVersion')}:
        refuse('m10_launch', 'm10-launch.json is not the release of these records')
    rel_at = _ts(run.get('finishedAt'), 'release finishedAt')
    max_age = c['a1MaxAgeSec']
    if not datetime.timedelta(0) <= now - rel_at <= datetime.timedelta(seconds=max_age):
        refuse('stale_release', f'the release ran {int((now - rel_at).total_seconds())} s ago (max a1MaxAgeSec {max_age}): re-run release')
    # --- the binary that will run, and its coverage requalification ---
    secure_path(release_path, owner, top=top)
    if sha(pathlib.Path(release_path).read_bytes()) != release_sha:
        refuse('release_binary', 'the staged release binary is not the reviewed artifact')
    ev = (coverage or {}).get('evidence') or {}
    if set(ev) != {'receiptSha256', 'verdictSha256', 'originSha256', 'snapshotManifestSha256'} or ev['snapshotManifestSha256'] != A.MANIFEST_SHA:
        refuse('coverage', 'coverage acceptance (wrapper coverage_activation for the release) is absent or names another snapshot manifest')
    # --- publish atomically: a fully written sibling directory renamed into place; never overwrite ---
    out = pathlib.Path(out_dir)
    secure_path(out.parent, owner, leaf='dir', top=top)
    if os.path.lexists(out):
        refuse('exists', f'{out} exists: launch evidence is never overwritten (rollback, then a new directory)')
    launch = {'format': LAUNCH_FORMAT, 'anchor': anchor, 'baseReleaseSha256': release_sha,
              'qualification': {k: sha(files[k][0]) for k in QUAL},
              'bindings': {'a2a4SourceSha256': A2A4_SOURCE_SHA256, 'harnessBinarySha256': harness_binary_sha, 'configSha256': sha(cfg_bytes),
                           'a3Sha256': sha(a3_b), 'releaseRunSha256': sha(run_b), 'datadir': c['datadir'], 'dbIdentity': ident,
                           'a1': {k: g[k] for k in ('initialSha256', 'N', 'outputRoot', 'game', 'asr', 'l1Finalized', 'l1Hash', 'a1At')},
                           'bytecodes': m10['bytecodes'], 'journal': bv['journal'], 'downloadReceiptSha256': bv['downloadReceiptSha256'],
                           'snapshotManifestSha256': A.MANIFEST_SHA, 'coverage': ev},
              'producedAt': now.isoformat(), 'notAfter': (rel_at + datetime.timedelta(seconds=max_age)).isoformat()}
    tmp = out.parent / f'.{out.name}.partial-{os.getpid()}'
    os.mkdir(tmp, 0o755); os.mkdir(tmp / 'qualification', 0o755)
    for k, f in QUAL.items():
        _write_new(tmp / 'qualification' / f, files[k][0])
    lb = json.dumps(launch, indent=1, sort_keys=True).encode()
    _write_new(tmp / 'launch.json', lb)
    _fsync_dir(tmp / 'qualification'); _fsync_dir(tmp)
    os.rename(tmp, out)                                                   # atomic publish (refused above if `out` existed)
    _fsync_dir(out.parent)
    return {'launchSha256': sha(lb), 'dir': str(out)}


def _write_new(p, b):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        os.write(fd, b); os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_dir(d):
    fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


# ---- lifecycle --------------------------------------------------------------------------------------------------------------
def _current(d, owner, top):
    secure_path(d, owner, leaf='dir', top=top)
    lb, launch = read_record(d / 'launch.json')
    if launch.get('format') != LAUNCH_FORMAT:
        refuse('launch', 'not a launch record')
    hist = sorted((d / 'lifecycle-history').glob('*.json')) if (d / 'lifecycle-history').is_dir() else []
    if not (d / 'lifecycle.json').exists():
        if hist:
            refuse('lifecycle_tamper', 'history exists without a current lifecycle')
        return sha(lb), launch, None, None, []
    cb, cur = read_record(d / 'lifecycle.json')
    if not hist or read_record(hist[-1])[0] != cb:
        refuse('lifecycle_tamper', 'lifecycle.json is not the last recorded transition')
    prev = None
    for i, h in enumerate(hist, 1):                                      # the hash chain from the first transition
        hb, hd = read_record(h)
        if hd.get('seq') != i or hd.get('prevSha256') != prev or hd.get('launchSha256') != sha(lb) or hd.get('format') != LIFECYCLE_FORMAT:
            refuse('lifecycle_tamper', f'lifecycle history broken at {h.name}')
        prev = sha(hb)
    return sha(lb), launch, cb, cur, hist


def _transition(d, state, evidence, owner, top, now, allowed_from):
    lsha, launch, cb, cur, hist = _current(d, owner, top)
    frm = cur.get('state') if cur else None
    if frm in TERMINAL:
        refuse('rolled_back', 'the lifecycle was rolled back: nothing transitions out of it (a new launch directory is required)')
    if frm not in allowed_from:
        refuse('transition', f'{frm!r} -> {state!r} is not an allowed transition')
    doc = {'format': LIFECYCLE_FORMAT, 'launchSha256': lsha, 'state': state, 'seq': len(hist) + 1, 'prevSha256': sha(cb) if cb else None,
           'at': now.isoformat(), 'evidence': evidence}
    b = json.dumps(doc, indent=1, sort_keys=True).encode()
    hd = d / 'lifecycle-history'
    if not hd.exists():
        os.mkdir(hd, 0o755)
    _write_new(hd / f'{doc["seq"]:04d}-{state}.json', b)                 # immutable audit copy first
    tmp = d / f'.lifecycle.partial-{os.getpid()}'
    _write_new(tmp, b); os.replace(tmp, d / 'lifecycle.json'); _fsync_dir(hd); _fsync_dir(d)
    return {'state': state, 'lifecycleSha256': sha(b)}


def lifecycle_init(d, *, owner=0, top='/', now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc); d = pathlib.Path(d)
    _, launch, *_ = _current(d, owner, top)
    if now > _ts(launch.get('notAfter'), 'launch notAfter'):
        refuse('stale_launch', 'the launch record expired before the initial activation: re-run A1 and release, then produce again')
    return _transition(d, 'anchor-pending', {'reason': 'initial activation'}, owner, top, now, allowed_from={None})


def mark_started(d, note, *, owner=0, top='/', now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if not (isinstance(note, str) and 0 < len(note) <= 500):
        refuse('evidence', 'mark-started needs a short root note (which start was issued)')
    return _transition(pathlib.Path(d), 'anchor-started', {'note': note}, owner, top, now, allowed_from={'anchor-pending'})


def rearm(d, cfg_path, *, A, owner=0, top='/', now=None):
    """anchor-started -> anchor-pending ONLY if the STOPPED DB is still exactly at the anchor (the harness's own runner)."""
    now = now or datetime.datetime.now(datetime.timezone.utc); d = pathlib.Path(d)
    _, launch, *_ = _current(d, owner, top)
    c = A.load_config(str(cfg_path)); w = pathlib.Path(c['workdir'])
    n, h = launch['anchor'].split(':')
    if int(n) != c['N']:
        refuse('rearm', 'the config is for another N')
    base = A.Base(c, [], w)
    A.gate_static(c, base)            # the harness's own pre-DB gates (units stopped, pins, download receipt, layout); never bypassed
    cps = A.head_checkpoints(c, base)
    if any(v != c['N'] for v in cps.values()):
        refuse('head_advanced', f'stage checkpoints {cps} are not all at N: the head moved; the anchor is never replayed')
    above = base.run('db', '--datadir', c['datadir'], '--config', c['rethConfig'], 'get', 'static-file', 'headers', str(c['N'] + 1))
    if above.stdout.strip():
        refuse('head_advanced', 'a header above N exists: the anchor is never replayed')
    if A.authenticate(c, A.read_header(c, base, c['N']))['blockHash'] != h:
        refuse('rearm', 'header N does not authenticate to the anchor hash')
    return _transition(d, 'anchor-pending', {'reason': 'stopped DB verified at N', 'checkpoints': cps}, owner, top, now, allowed_from={'anchor-started'})


def record_bootstrapped(d, proof, *, owner=0, top='/', now=None):
    if not FINALITY_PROOF_REVIEWED:
        refuse('hold_finality', 'HOLD: no reviewed proof that finality passed N (an own-node head or label is not finality); '
               'needs a fresh A1-authenticated receipt N\' > N plus header N\' authenticated against it')
    raise AssertionError('unreachable while FINALITY_PROOF_REVIEWED is False')


def rollback(d, reason, *, owner=0, top='/', now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if not (isinstance(reason, str) and 0 < len(reason) <= 500):
        refuse('evidence', 'rollback needs a short root reason')
    return _transition(pathlib.Path(d), 'rolled-back', {'reason': reason, 'recovery': 're-download (A2-A4 procedure)'}, owner, top, now,
                       allowed_from={'anchor-pending', 'anchor-started', 'bootstrapped'})


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    cmds = {'init', 'mark-started', 'rearm', 'record-bootstrapped', 'rollback', 'produce'}
    if len(argv) < 3 or argv[1] not in cmds:
        print(__doc__); return 2
    try:
        if argv[1] == 'produce':                                         # produce <a2a4-config> <new-out-dir>
            A = load_a2a4()
            sys.path.insert(0, '/opt/enclave-rpc')
            import chain_service as W                                     # the INSTALLED wrapper (its own module-level config)
            cov = W.coverage_activation(W.CONFIG, W.ROOT / 'manifest.json', (W.MANIFEST.get('binaries') or {}).get('base'))
            r = produce(argv[2], argv[3], A=A, coverage=cov)
        elif argv[1] == 'init':
            r = lifecycle_init(argv[2])
        elif argv[1] == 'mark-started':
            r = mark_started(argv[2], argv[3])
        elif argv[1] == 'rearm':
            r = rearm(argv[2], argv[3], A=load_a2a4())
        elif argv[1] == 'record-bootstrapped':
            r = record_bootstrapped(argv[2], None)
        else:
            r = rollback(argv[2], argv[3])
    except (Refused, OSError, KeyError) as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(json.dumps({'ok': True, **r, 'next': 're-pin chain.json baseBootstrap.anchorLaunch to these sha256 values (reviewed manual step)'}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
