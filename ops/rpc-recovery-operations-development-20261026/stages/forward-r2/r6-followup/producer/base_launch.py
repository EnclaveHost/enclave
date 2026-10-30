#!/usr/bin/env python3
"""base_launch.py r2: OFFLINE, ROOT-ONLY producer of the M10 bootstrap launch record plus the root side of the ONE-SHOT launch
journal consumed by the r2 wrapper (r2/wrapper/chain_service.py launch_lock / launch_handshake). PREPARED; NOT run.

`produce` is r1's, byte-for-byte in logic (see base-launch-producer-stage/producer/base_launch.py, kept unchanged): it reads ONLY
the completed A2-A4 workdir of the reviewed harness (a2-v2-release-bound a2a4.py, source pin below), re-validates it with THAT
module's own functions, and publishes a NEW directory atomically: launch.json (enclave-base-bootstrap-launch/v1) +
qualification/*. Root pins ONLY launch.json's sha256 in chain.json baseBootstrap.anchorLaunch {launchSha256}: the record is
immutable, so it is pinned once and never re-pinned per lifecycle step.

The r1 lifecycle.json / mark-started design is REPLACED (root review: a manual mark after the launch leaves a replay window;
before the launch it blocks every first start). The journal is consumed by the wrapper itself, under the shared lock, durably,
before it execs. Root operations here take the SAME lock and use the wrapper module's own journal functions (W), so there is
one implementation of the format, the hash chain and the durable append:
  arm                   (no journal) -> armed      fresh launch (now <= notAfter) AND the stopped DB unchanged at N; creates the
                                                   private root lock file and the journal; refuses if either exists
  [wrapper start]       armed|rearmed -> consumed  r2 wrapper, after every gate, before execve
  rearm                 consumed -> rearmed        fresh launch AND the stopped DB unchanged at N (the harness's own gate_static,
                                                   checkpoints, no header above N, header N authenticated, DB file identity
                                                   the one the launch record bound - before and after the reads)
  record-finality       consumed|bootstrapped -> bootstrapped: a CURRENT finality_state qualification N' > N appended as a
                        finality-proof watermark entry (r4; HOLD while FINALITY_PROOF_REVIEWED = False)
  permit-restart        bootstrapped|restarted -> restart-permitted: the STOPPED DB proven by the harness at/above the latest
                        recorded floor (r5); the wrapper consumes it as `restarted` (one ordinary start, no anchor)
  record-bootstrapped   HOLD (superseded by record-finality)
  rollback              any non-terminal -> rolled-back (terminal)
"""
import datetime, hashlib, importlib.util, json, os, pathlib, re, stat, sys

A2A4_SOURCE_SHA256 = 'abe223d6a0c6c203f7d76aaa4c68d25f8f7ecb74894e64dd838383abf6aeeadd'   # a2-v2-release-bound-prepared/stage/a2a4.py
A2A4_SOURCE = pathlib.Path('/opt/enclave-rpc/a2a4/a2a4.py')      # root installs the reviewed stage there (HOLD: not installed)
# Re-anchor recovery (base-reanchor-recovery-stage; PREPARED): configs with `reanchor` run the recovery harness copy (a superset
# that leaves the first-bootstrap path unchanged); first-bootstrap configs keep the reviewed harness above.
RECOVERY_A2A4_SHA256 = '710c34830157a8307d20f6b9481c4f5c8aeb6fb59f1db3dccb3e2cec5b024560'   # base-finality-proof-stage/r6/harness/a2a4.py
RECOVERY_A2A4_SOURCE = pathlib.Path('/opt/enclave-rpc/a2a4-recovery/a2a4.py')   # HOLD: not installed
HARNESS_BINARY_SHA256 = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'  # selection.BASE_BINARY_SHA256 (A2-A4 runs this)
BASE_RELEASE_SHA256 = '4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f'   # m7-m10-release-completed-0055
BASE_RELEASE_PATH = pathlib.Path('/opt/enclave-rpc/releases/base-m7m10-4a7c013a510f8816/base')
LAUNCH_FORMAT = 'enclave-base-bootstrap-launch/v1'                # == r2 wrapper LAUNCH_FORMAT
QUAL = {'m10LaunchSha256': 'm10-launch.json', 'a2Sha256': 'a2-authenticated.json', 'a4Sha256': 'a4-rebuilt.json',
        'bytecodesVerifiedSha256': 'bytecodes-verified.json'}
MAX_RECORD = 64 << 20
# HOLD (fail closed): an L2 block number/hash read from our own node is NOT finality evidence, and no reviewed proof that
# finality passed N exists. A reviewed design would need: a fresh A1-authenticated receipt (the harness's A1 gate rules) naming
# N' > N with its output root, and our node's header N' authenticated against that root (the harness's authenticate()), with
# N' a descendant of the anchor. Until such a validator is reviewed, `record-bootstrapped` refuses. Source constant, not config.
FINALITY_PROOF_REVIEWED = False
# r6 activation (base-finality-proof-stage/r6): a review flag is True only through its source constant OR the root-owned activation
# artifact that names THIS module's exact bytes for that flag (written only by install_verified.py `activate`, after qualification).
# The artifact is the deliberate, reviewable activation step: no source edit, so every byte pin stays valid. Absent -> False.
ACTIVATION_FILE = pathlib.Path('/etc/enclave-rpc/finality-activation.json')


def reviewed(name):
    if globals().get(name) is True:
        return True
    try:
        fd = os.open(ACTIVATION_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return False
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            return False
        try:
            doc = json.loads(f.read(1 << 16))
        except ValueError:
            return False
    try:
        me = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    except (OSError, NameError):
        return False
    return isinstance(doc, dict) and doc.get('format') == 'enclave-finality-activation/v1' and (doc.get('flags') or {}).get(name) == me


# r4 (base-finality-proof-stage/r4): the post-anchor finality tool, executed from exactly its pinned bytes (HOLD: not installed).
FINALITY_STATE_SHA256 = 'ed31bf92d686ab328d683ea99dab3876d9c96301d3ef4605a99cb1f3a8f8d75c'   # base-finality-proof-stage/r6/src/finality_state.py
FINALITY_STATE_SOURCE = pathlib.Path('/opt/enclave-rpc/finality/src/finality_state.py')
SELECTION_SHA256 = 'e6c312f4007f6d747197a6569eaeb36c8c949a0819be49738ce6a0723b999532'   # selection.py beside BOTH harnesses (identical)
WRAPPER_SHA256 = '4fc3b970e4ec062eeb66ef90c5bd1b14149a9bdcff135e7720708e7c544df8ae'   # base-finality-proof-stage/r6/wrapper/chain_service.py
WRAPPER_SOURCE = pathlib.Path('/opt/enclave-rpc/chain_service.py')


class Refused(Exception):
    pass


def refuse(code, why):
    raise Refused(f'{code}: {why}')


sha = lambda b: hashlib.sha256(b).hexdigest()


def load_a2a4(path=A2A4_SOURCE, pin=A2A4_SOURCE_SHA256):
    """The reviewed harness module, exactly the pinned bytes (its own selection.py beside it)."""
    p = pathlib.Path(path); b, sb = _read_bytes(p), _read_bytes(p.parent / 'selection.py')
    if sha(b) != pin or sha(sb) != SELECTION_SHA256:
        refuse('a2a4_source', f'{p} (or its selection.py) is not the reviewed A2-A4 harness {pin[:12]}...')
    _exec_bytes('selection', sb, p.parent / 'selection.py')         # r6: executed from the verified bytes (no path import, no .pyc)
    return _exec_bytes('a2a4_reviewed', b, p)


def _read_bytes(p):
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        refuse('source', f'{p} unreadable ({type(e).__name__})')
    try:
        chunks = []
        while (c := os.read(fd, 1 << 20)):
            chunks.append(c)
    finally:
        os.close(fd)
    return b''.join(chunks)


def _exec_bytes(name, b, path):
    import types
    m = types.ModuleType(name); m.__file__ = str(path); sys.modules[name] = m
    exec(compile(b, str(path), 'exec'), m.__dict__)
    return m


def load_finality(path=FINALITY_STATE_SOURCE, pin=FINALITY_STATE_SHA256, owner=0, top='/'):
    """The reviewed post-anchor finality tool, exactly the pinned bytes (root-owned path, no symlink)."""
    p = pathlib.Path(path)
    secure_path(p, owner, top=top)
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        refuse('finality_source', f'{p} unreadable ({type(e).__name__})')
    try:
        chunks = []
        while (c := os.read(fd, 1 << 20)):
            chunks.append(c)
    finally:
        os.close(fd)
    _b = b''.join(chunks)
    if sha(_b) != pin:
        refuse('finality_source', f'{p} is not the reviewed finality tool {pin[:12]}...')
    m = importlib.util.module_from_spec(importlib.util.spec_from_file_location('finality_state_reviewed', p))
    exec(compile(_b, str(p), 'exec'), m.__dict__)
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


def _initial_ok(A, c, g):
    """First bootstrap: the source pin, exactly as before. Re-anchor: the receipt A2 used is the configured one, and the harness's
    own initial_pin() binds it (source pin, or the pending capture-binding verifier; HOLD otherwise)."""
    if c.get('reanchor') is None:
        return g.get('initialSha256') == A.A1_INITIAL_SHA256
    try:
        if c['a1Mode'] == 'capture-recheck':                 # r3: the binding A2 recorded, re-verified (nothing admitted here)
            bound, _sr, ini, _rk = A.capture_binding(c)
            return g.get('initialCapture') == bound and g.get('initialSha256') == bound['evidenceSha256'] == sha(ini)
        if g.get('initialSha256') != c.get('a1InitialSha256'):
            return False
        A.initial_pin(c)                                      # same-anchor re-anchor: the source pin only
    except A.Refused as e:
        refuse('a1', str(e))
    return True


def _predecessor(name, archive, ra, N, anchor, owner, top, W):
    """The archived, terminally rolled-back predecessor of a re-anchor launch -> its binding for launch.json."""
    if not (isinstance(name, str) and re.fullmatch(r'[0-9a-f]{64}', name)) or archive is None or W is None:
        refuse('lineage', 'a re-anchor launch needs its archived predecessor launchSha256, the archive and the wrapper module')
    d = pathlib.Path(archive) / name
    if os.path.islink(d) or not os.path.isdir(d):
        refuse('lineage', 'the named predecessor is not an archived launch directory')
    secure_path(d, owner, leaf='dir', top=top)
    lb, prev = read_record(d / 'launch.json')
    if sha(lb) != name or prev.get('format') != LAUNCH_FORMAT:
        refuse('lineage', 'the archived predecessor launch record is not the named one')
    pn = int(str(prev.get('anchor', '0:')).split(':')[0])
    if pn != ra['predecessorN']:
        refuse('lineage', 'reanchor.predecessorN is not the predecessor launch anchor')
    if not (pn < N or prev['anchor'] == anchor):
        refuse('lineage', 'the anchor would move backward (or change at the same height)')
    entries = _journal(d, name, owner, top, W)
    if entries[-1][1]['event'] != 'rolled-back':
        refuse('lineage', 'the predecessor launch is not rolled back')
    pred = {'launchSha256': name, 'rolledBackEntrySha256': entries[-1][0], 'anchor': prev['anchor']}
    try:
        W.launch_lineage({'anchor': anchor, 'predecessor': pred}, archive, owner, top)
    except AssertionError as e:
        refuse('lineage', str(e))
    return pred


def produce(cfg_path, out_dir, *, A, coverage, release_path=BASE_RELEASE_PATH, release_sha=BASE_RELEASE_SHA256,
            harness_binary_sha=HARNESS_BINARY_SHA256, owner=0, top='/', now=None, predecessor=None, archive=None, W=None,
            watermark=None):
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
    if not _initial_ok(A, c, g) or str(g.get('N')) != str(N) or str(g.get('outputRoot', '')).lower() != c['outputRoot'] \
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
    # --- re-anchor: exactly one archived, rolled-back predecessor with a non-decreasing anchor; first bootstrap: none ---
    if (c.get('reanchor') is None) != (predecessor is None):
        refuse('lineage', 'a re-anchor launch needs exactly its archived predecessor; a first-bootstrap launch has none')
    pred = _predecessor(predecessor, archive, c['reanchor'], N, anchor, owner, top, W) if predecessor is not None else None
    wm = None
    if c.get('reanchor') is not None:                           # r2: bind the accepted authenticated-finality watermark
        if c['reanchor']['watermarkStore'] != str(watermark or W.BOOTSTRAP_WATERMARK):
            refuse('watermark', "the harness watermark store is not the wrapper's")
        try:
            wm = A.gate_watermark(c, None, a4['blockHash'])
        except A.Refused as e:
            refuse('watermark', str(e))
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
    if pred is not None:
        launch['predecessor'] = pred
    if wm is not None:
        launch['watermark'] = wm
    if g.get('initialCapture') is not None:
        launch['a1Capture'] = {'initialCapture': g['initialCapture']}   # the reviewed record of the capture A2 accepted
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


# ---- one-shot launch journal (root side; W = the r2 wrapper module: its lock, verifier and durable append) ------------------
def _launch(d, owner, top):
    secure_path(d, owner, leaf='dir', top=top)
    lb, launch = read_record(d / 'launch.json')
    if launch.get('format') != LAUNCH_FORMAT or not re.fullmatch(r'[1-9][0-9]{0,18}:0x[0-9a-f]{64}', str(launch.get('anchor', ''))):
        refuse('launch', 'not a launch record')
    return sha(lb), launch


def _fresh(launch, now):
    if now > _ts(launch.get('notAfter'), 'launch notAfter'):
        refuse('stale_launch', 'the launch record expired: a fresh A1 recheck, release and launch record (new directory) are required')


def _locked(d, owner, top, W):
    try:
        return W.launch_lock(d, owner, top)
    except AssertionError as e:
        refuse('lock', str(e))


def _journal(d, lsha, owner, top, W):
    try:
        return W.journal_entries(d / 'journal', owner, lsha, top)
    except AssertionError as e:
        refuse('journal', str(e))


def _append(d, lsha, entries, event, evidence, owner, top, now, W):
    try:
        after = W.journal_append(d / 'journal', owner, lsha, entries, event, evidence, now.isoformat(), top)
    except AssertionError as e:
        refuse('journal', str(e))
    return {'event': event, 'seq': len(after), 'entrySha256': after[-1][0]}


def bound_config(launch, cfg_path, A):
    """r6: arm, rearm and restart permits prove the DB ONLY with the exact harness config the launch record bound (configSha256) and
    the harness's pinned base binary: never a caller-supplied config or tool."""
    if sha(_read_bytes(pathlib.Path(cfg_path))) != (launch.get('bindings') or {}).get('configSha256'):
        refuse('config', 'the harness config is not the one the launch record bound (configSha256)')
    c = A.load_config(str(cfg_path))
    # r2: BOTH the launch record's binding AND the production code pin (never only the record): a launch made with any other
    # harness_binary_sha (tests, an older/foreign producer) cannot arm/rearm/permit against the production pin
    b = (launch.get('bindings') or {}).get('harnessBinarySha256')
    if not (c.get('baseBinarySha256') == b == HARNESS_BINARY_SHA256):
        refuse('binary_pin', 'the config, the launch record binding (harnessBinarySha256) and the production pin HARNESS_BINARY_SHA256 differ')
    return c


def stopped_db_unchanged_at_n(launch, cfg_path, *, A):
    """The REAL harness, never bypassed: the DB file identity the launch record bound (the bytecode scan's), then the harness's
    own gate_static (units stopped, pins, download receipt, layout), every stage checkpoint == N, no header above N, header N
    authenticating to the anchor hash, then the identity again. Any difference refuses: the anchor is never replayed."""
    c = bound_config(launch, cfg_path, A); w = pathlib.Path(c['workdir'])
    n, h = launch['anchor'].split(':')
    b = launch.get('bindings') or {}
    if int(n) != c['N'] or b.get('datadir') != c['datadir']:
        refuse('db', 'the config is for another N or datadir than the launch record')
    want = (b.get('dbIdentity') or {}).get('mdbx')

    def same():
        st = os.stat(pathlib.Path(c['datadir'], 'db', 'mdbx.dat'))
        if want is None or {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns} != want:
            refuse('db_changed', 'the DB file is not the one the launch record bound: never (re)armed (rollback, re-download)')
    same()
    base = A.Base(c, [], w)
    A.gate_static(c, base)
    cps = A.head_checkpoints(c, base)
    if any(v != c['N'] for v in cps.values()):
        refuse('head_advanced', f'stage checkpoints {cps} are not all at N: the head moved; the anchor is never replayed')
    above = base.run('db', '--datadir', c['datadir'], '--config', c['rethConfig'], 'get', 'static-file', 'headers', str(c['N'] + 1))
    if above.stdout.strip():
        refuse('head_advanced', 'a header above N exists: the anchor is never replayed')
    if A.authenticate(c, A.read_header(c, base, c['N']))['blockHash'] != h:
        refuse('db', 'header N does not authenticate to the anchor hash')
    same()
    return {'reason': 'stopped DB unchanged at N', 'checkpoints': cps, 'headerN': h, 'mdbx': want}


def _record_watermark(lsha, launch, cfg_path, A, W, watermark, owner, top, now):
    """Under the launch lock, before the journal genesis: the watermark is still what produce bound (or this launch's own entry,
    from an interrupted arm), then this launch's anchor is appended as an accepted authenticated-finality entry."""
    wmb = launch['watermark']; c = A.load_config(str(cfg_path)); store = pathlib.Path(watermark or W.BOOTSTRAP_WATERMARK)
    if c.get('reanchor') is None or c['reanchor']['watermarkStore'] != str(store):
        refuse('watermark', "the harness watermark store is not the wrapper's")
    led = c['reanchor'].get('admissionLedger')
    if led is not None and led != str(W.A1_ADMISSION_LEDGER):
        refuse('a1_ledger', "the harness admission ledger is not the wrapper's shared A1_ADMISSION_LEDGER (finality would not see its admissions)")
    try:
        es = W.watermark_entries(store, owner, top)
    except AssertionError as e:
        refuse('watermark', str(e))
    n, h = launch['anchor'].split(':'); n = int(n)
    if es and es[-1][1]['kind'] == 'launch-anchor' and es[-1][1]['ref'] == lsha and (es[-1][1]['number'], es[-1][1]['blockHash']) == (n, h):
        return es[-1][0]                                          # recorded by an interrupted arm: idempotent
    if wmb.get('legacy') is True:
        if es:
            refuse('watermark', 'produced as legacy (no watermark), but an accepted watermark exists now: re-produce')
        if not os.path.lexists(store):
            os.mkdir(store, 0o755); _fsync_dir(store.parent)
        secure_path(store, owner, leaf='dir', top=top)
    elif not es or es[-1][0] != wmb.get('entrySha256'):
        refuse('watermark', 'the accepted authenticated-finality watermark changed since produce: re-produce (it is never discarded)')
    try:
        return W.watermark_append(store, owner, es, n, h, 'launch-anchor', lsha, now.isoformat(), top)[-1][0]
    except AssertionError as e:
        refuse('watermark', str(e))


def record_finality(*a, **k):
    """The only other watermark writer (kind finality-proof): a reviewed acceptance of finality past the anchor. HOLD."""
    if not reviewed('FINALITY_PROOF_REVIEWED'):
        refuse('hold_finality', 'HOLD: no reviewed finality-proof acceptance writes the watermark (FINALITY_PROOF_REVIEWED is False)')
    return _record_finality(*a, **k)


def _record_finality(d, chain_json, finality_dir, rpc_url, *, W, F, owner=0, top='/', now=None, watermark=None):
    """r4. Under the launch lock, a STARTED launch (consumed|bootstrapped) whose finality_state status is CURRENT - the last finality
    entry `qualified` for THIS journal head and THIS bound process (release sha, mdbx dev/ino, pid/starttime) - gets that entry's
    fresh (N', hash) as a finality-proof watermark entry (ref = the finality entry sha), then the journal event `bootstrapped`
    naming it. The status is re-read right before EACH append (identity at append). Watermark rules are checked FIRST (never
    regressing, one block per height, only this launch's proofs after its anchor); a first-bootstrap launch's first proof
    creates the store and sets the floor. An interrupted record (watermark entry landed, journal event did not) is ADOPTED by
    re-running with the same qualification - never left as a trap and never re-appended."""
    now = now or datetime.datetime.now(datetime.timezone.utc); d = pathlib.Path(d)
    lsha, launch = _launch(d, owner, top)
    if getattr(F, 'OWNER', None) != owner:
        refuse('finality', 'the finality tool trusts another owner than this launch')
    first = launch.get('predecessor') is None and launch.get('watermark') is None
    store = pathlib.Path(watermark or W.BOOTSTRAP_WATERMARK); n0 = int(launch['anchor'].split(':')[0])
    fd = _locked(d, owner, top, W)
    try:
        entries = _journal(d, lsha, owner, top, W)
        last = entries[-1][1]
        if last['event'] not in ('consumed', 'bootstrapped', 'restarted'):
            refuse('transition', f'finality is recorded only for a started launch (journal state {last["event"]!r})')

        def current():
            try:
                pinned = F.load_launch(d, chain_json, top)['launchSha256']
                s = F.status(d, chain_json, finality_dir, rpc_url, W=W, top=top)
                q = F.entries(finality_dir, lsha, top)
            except F.Refused as e:
                refuse('finality', str(e))
            if pinned != lsha:
                refuse('launch_pin', "root's chain.json pins another launch than this directory")
            if s.get('qualified') is not True or not q or q[-1].get('event') != 'qualified' or q[-1].get('sha') != s.get('entrySha256'):
                refuse('not_qualified', f'post-anchor finality is not current: {s.get("state")}')
            fresh = q[-1]['evidence']['fresh']; n, h = fresh.get('N'), fresh.get('blockHash')
            if type(n) is not int or n != s.get('freshN') or n <= n0 or not re.fullmatch(r'0x[0-9a-f]{64}', str(h)) \
                    or not re.fullmatch(r'[0-9a-f]{64}', str(s['entrySha256'])):
                refuse('not_qualified', 'the qualified point is not a well-formed block above the launch anchor')
            return n, h, s['entrySha256'], q[-1]['seq']
        if last['event'] == 'bootstrapped':
            try:
                q = F.entries(finality_dir, lsha, top)
            except F.Refused as e:
                refuse('finality', str(e))
            if q and q[-1].get('sha') == last['evidence'].get('finalityEntrySha256'):
                return {'watermarkEntrySha256': last['evidence']['watermarkEntrySha256'], 'number': last['evidence']['number'], 'appended': False}
        n, h, ref, fseq = current()
        if not os.path.lexists(store):
            if not first:
                refuse('watermark', 'a re-anchor launch needs its existing watermark store')
            os.mkdir(store, 0o755); _fsync_dir(store.parent)
        secure_path(store, owner, leaf='dir', top=top)
        try:
            es = W.watermark_entries(store, owner, top)
        except AssertionError as e:
            refuse('watermark', str(e))
        adopted = None
        try:
            W.launch_finality(launch, lsha, entries, store, owner, top)
        except AssertionError as e:
            t = es[-1][1] if es else None
            if t is None or (t['kind'], t['ref'], t['number'], t['blockHash']) != ('finality-proof', ref, n, h):
                refuse('watermark', str(e))
            try:                                   # exactly this qualification's entry, the only one not yet named: adopt it
                W.launch_finality(launch, lsha, entries + [(None, {'event': 'bootstrapped', 'evidence': {'watermarkEntrySha256': es[-1][0]}})],
                                  store, owner, top)
            except AssertionError:
                refuse('watermark', str(e))
            adopted = es[-1][0]
        if adopted is None:
            if es and n == es[-1][1]['number'] and h != es[-1][1]['blockHash']:
                refuse('watermark_conflict', f'the watermark holds another block at {n}: contradiction, nothing recorded')
            if es and n <= es[-1][1]['number']:
                refuse('watermark_below', f'the qualified point {n} is not above the accepted watermark {es[-1][1]["number"]}')
            if current() != (n, h, ref, fseq):
                refuse('not_qualified', 'the qualification changed before the watermark append')
            try:
                es = W.watermark_append(store, owner, es, n, h, 'finality-proof', ref, now.isoformat(), top)
            except AssertionError as e:
                refuse('watermark', str(e))
        wsha = adopted or es[-1][0]
        if current() != (n, h, ref, fseq):
            refuse('not_qualified', 'the qualification changed before the journal append (re-run record-finality to adopt)')
        j = _append(d, lsha, entries, 'bootstrapped', {'watermarkEntrySha256': wsha, 'finalityEntrySha256': ref, 'finalitySeq': fseq, 'number': n, 'blockHash': h},
                    owner, top, now, W)
        return {'watermarkEntrySha256': wsha, 'number': n, 'journal': j, 'appended': adopted is None, 'adopted': adopted is not None}
    finally:
        os.close(fd)


def permit_restart(d, cfg_path, *, A, W, owner=0, top='/', now=None, watermark=None):
    """r5: bootstrapped|restarted -> restart-permitted, ONLY with the STOPPED DB proven at or above its latest recorded finality floor
    by the REAL harness: the launch's DB file (dev/ino), gate_static (units stopped, pins, layout), EVERY stage checkpoint >= the
    floor height, the DB header at the floor height hashing to the floor block, the file unchanged during the reads. Inode presence
    is not enough: a DB rolled back IN PLACE below the floor (same inode, fewer blocks) refuses `below_floor`, another block at the
    floor refuses `floor_conflict`. The permit records the file's exact identity (dev, ino, size, mtime); the wrapper consumes it
    only if nothing wrote the DB since. The persistent floor is never lowered here."""
    now = now or datetime.datetime.now(datetime.timezone.utc); d = pathlib.Path(d)
    lsha, launch = _launch(d, owner, top)
    store = pathlib.Path(watermark or W.BOOTSTRAP_WATERMARK)
    fd = _locked(d, owner, top, W)
    try:
        entries = _journal(d, lsha, owner, top, W)
        if entries[-1][1]['event'] not in ('bootstrapped', 'restarted'):
            refuse('transition', f'a restart permit is only for a bootstrapped launch (journal state {entries[-1][1]["event"]!r})')
        try:
            own = W.launch_finality(launch, lsha, entries, store, owner, top)
        except AssertionError as e:
            refuse('watermark', str(e))
        if not own:
            refuse('watermark', 'no recorded finality floor for this launch')
        fsha, fe = own[-1]; fn, fh = fe['number'], fe['blockHash']
        c = bound_config(launch, cfg_path, A); b = launch.get('bindings') or {}
        if b.get('datadir') != c['datadir']:
            refuse('db', 'the config is for another datadir than the launch record')
        want = (b.get('dbIdentity') or {}).get('mdbx') or {}

        def ident():
            st = os.stat(pathlib.Path(c['datadir'], 'db', 'mdbx.dat'))
            if (st.st_dev, st.st_ino) != (want.get('dev'), want.get('ino')):
                refuse('db_changed', 'the DB file is not the one the launch record bound (rollback + re-anchor)')
            return {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns}
        before = ident()
        try:
            base = A.Base(c, [], pathlib.Path(c['workdir']))
            A.gate_static(c, base)
            cps = A.head_checkpoints(c, base)
            if any(type(v) is not int or v < fn for v in cps.values()):
                refuse('below_floor', f'stage checkpoints {cps} are below the recorded finality floor {fn}: the DB was rolled back (in place '
                       'or restored); never served - rollback + re-anchor at or above the floor')
            got = A.header_hash(c, A.read_header(c, base, fn))
        except A.Refused as e:
            refuse('stopped_db', str(e))
        if got != fh:
            refuse('floor_conflict', f'the DB header at the floor height {fn} is not the recorded finality block: another chain')
        if ident() != before:
            refuse('db_changed', 'the DB file changed during the checks (the node is not stopped)')
        evidence = {'floor': {'entrySha256': fsha, 'number': fn, 'blockHash': fh}, 'checkpoints': cps, 'mdbx': before}
        return _append(d, lsha, entries, 'restart-permitted', evidence, owner, top, now, W)
    finally:
        os.close(fd)


def permit_restart_auto(d, cfg_path, *, A, W, owner=0, top='/', now=None, watermark=None):
    """r6, for the unattended enclave-base-restart-permit.service (Before= the base unit): bootstrapped|restarted -> the SAME checked
    permit_restart (no human step); restart-permitted or a pending anchored start -> nothing to do; anything else (consumed without
    finality, finality-terminal, rolled-back) refuses: the base unit then stays down, never serving an unproven DB."""
    lsha, _launch_rec = _launch(pathlib.Path(d), owner, top)
    fd = _locked(pathlib.Path(d), owner, top, W)
    try:
        state = _journal(pathlib.Path(d), lsha, owner, top, W)[-1][1]['event']
    finally:
        os.close(fd)
    if state in ('restart-permitted', 'armed', 'rearmed'):
        return {'event': None, 'state': state, 'note': 'nothing to permit'}
    if state not in ('bootstrapped', 'restarted'):
        refuse('not_restartable', f'journal state {state!r}: no unattended restart (root rollback / re-anchor)')
    return permit_restart(d, cfg_path, A=A, W=W, owner=owner, top=top, now=now, watermark=watermark)


def quarantine(d, cfg_path, *, A, owner=0, top='/', W):
    """r6: isolate the datadir of a TERMINALLY rolled-back launch (e.g. permit-restart refused below_floor): an atomic rename to
    <datadir>.quarantine-<launchSha256[:16]>, root-only 0700. Nothing serves it again; the persistent floor is not touched; a new
    launch needs a DB at or above the floor (a newer snapshot, then the full A2-A4 re-anchor at a fresh A1 anchor >= the floor)."""
    d = pathlib.Path(d); lsha, launch = _launch(d, owner, top)
    fd = _locked(d, owner, top, W)
    try:
        if _journal(d, lsha, owner, top, W)[-1][1]['event'] != 'rolled-back':
            refuse('transition', 'only the datadir of a rolled-back launch is quarantined')
        c = bound_config(launch, cfg_path, A); src = pathlib.Path(c['datadir']); dst = src.with_name(f'{src.name}.quarantine-{lsha[:16]}')
        if src != pathlib.Path((launch.get('bindings') or {}).get('datadir', '')) or os.path.lexists(dst) or not src.is_dir() or src.is_symlink():
            refuse('quarantine', f'{src} is not the launch datadir, or {dst} exists')
        os.rename(src, dst); os.chmod(dst, 0o700); _fsync_dir(dst.parent)
        return {'quarantined': str(dst), 'launchSha256': lsha}
    finally:
        os.close(fd)


def arm(d, cfg_path, *, A, W, owner=0, top='/', now=None, archive=None, watermark=None):
    """Genesis: the private root lock file, then the journal with its first entry `armed`. Exactly once per launch directory
    (an arm interrupted before its first entry landed may be repeated: no entry means nothing was ever armed)."""
    now = now or datetime.datetime.now(datetime.timezone.utc); d = pathlib.Path(d)
    lsha, launch = _launch(d, owner, top)
    _fresh(launch, now)
    try:
        W.launch_lineage(launch, archive, owner, top)              # predecessor chain + archive coverage (first bootstrap: empty)
    except AssertionError as e:
        refuse('lineage', str(e))
    if launch.get('predecessor') is not None and not isinstance(launch.get('watermark'), dict):
        refuse('watermark', 'a re-anchor launch must bind the authenticated-finality watermark')
    if launch.get('predecessor') is None and launch.get('watermark') is None:
        try:                                                      # r6: the floor is GLOBAL, also for a newly created first launch
            floor = W.watermark_entries(pathlib.Path(watermark or W.BOOTSTRAP_WATERMARK), owner, top)
        except AssertionError as e:
            refuse('watermark', str(e))
        if floor:
            refuse('watermark_exists', f'an accepted finality floor ({floor[-1][1]["number"]}) exists: a first-bootstrap launch is never '
                   'armed; produce a re-anchor launch at or above it')
    if not os.path.lexists(d / 'journal.lock'):
        os.close(os.open(d / 'journal.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600))
        _fsync_dir(d)
    fd = _locked(d, owner, top, W)                                       # validates the lock file (private, owner, no symlink)
    try:
        jd = d / 'journal'
        if os.path.lexists(jd):
            secure_path(jd, owner, leaf='dir', top=top)
            if any(not W.JOURNAL_PARTIAL.fullmatch(n) for n in os.listdir(jd)):
                refuse('armed', 'this launch directory was already armed: only rearm (after consumed) or rollback')
        evidence = stopped_db_unchanged_at_n(launch, cfg_path, A=A)
        if launch.get('watermark') is not None:
            evidence = dict(evidence, watermarkEntrySha256=_record_watermark(lsha, launch, cfg_path, A, W, watermark, owner, top, now))
        if not os.path.lexists(jd):
            os.mkdir(jd, 0o755); _fsync_dir(d)
        return _append(d, lsha, [], 'armed', evidence, owner, top, now, W)
    finally:
        os.close(fd)


def rearm(d, cfg_path, *, A, W, owner=0, top='/', now=None):
    """consumed -> rearmed ONLY with the stopped DB proven unchanged at N (a start that never ran, or ran without touching it)."""
    now = now or datetime.datetime.now(datetime.timezone.utc); d = pathlib.Path(d)
    lsha, launch = _launch(d, owner, top)
    fd = _locked(d, owner, top, W)
    try:
        entries = _journal(d, lsha, owner, top, W)
        last = entries[-1][1]['event']
        if last == 'rolled-back':
            refuse('rolled_back', 'the launch was rolled back: nothing transitions out of it (a new launch directory is required)')
        if last != 'consumed':
            refuse('transition', f'rearm only after a consumed start (journal state {last!r})')
        _fresh(launch, now)
        evidence = stopped_db_unchanged_at_n(launch, cfg_path, A=A)
        return _append(d, lsha, entries, 'rearmed', evidence, owner, top, now, W)
    finally:
        os.close(fd)


def record_bootstrapped(d, proof, *, owner=0, top='/', now=None):
    if not reviewed('FINALITY_PROOF_REVIEWED'):
        refuse('hold_finality', 'HOLD: no reviewed proof that finality passed N (an own-node head or label is not finality); '
               'needs a fresh A1-authenticated receipt N\' > N plus header N\' authenticated against it')
    raise AssertionError('unreachable while FINALITY_PROOF_REVIEWED is False')


def rollback(d, reason, *, W, owner=0, top='/', now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc); d = pathlib.Path(d)
    if not (isinstance(reason, str) and 0 < len(reason) <= 500):
        refuse('evidence', 'rollback needs a short root reason')
    lsha, _ = _launch(d, owner, top)
    fd = _locked(d, owner, top, W)
    try:
        entries = _journal(d, lsha, owner, top, W)
        if entries[-1][1]['event'] == 'rolled-back':
            refuse('rolled_back', 'the launch was already rolled back (terminal)')
        return _append(d, lsha, entries, 'rolled-back', {'reason': reason, 'recovery': 're-download (A2-A4 procedure)'},
                       owner, top, now, W)
    finally:
        os.close(fd)


def retire(d, archive, *, W, owner=0, top='/'):
    """Move a terminally rolled-back launch directory to archive/<launchSha256> (atomic rename on the same filesystem) so a
    re-anchor launch can name it. Never for a live launch; never overwrites."""
    d, archive = pathlib.Path(d), pathlib.Path(archive)
    lsha, _ = _launch(d, owner, top)
    fd = _locked(d, owner, top, W)
    try:
        if _journal(d, lsha, owner, top, W)[-1][1]['event'] != 'rolled-back':
            refuse('retire', 'only a rolled-back launch is retired')
        if not os.path.lexists(archive):
            os.mkdir(archive, 0o755); _fsync_dir(archive.parent)
        secure_path(archive, owner, leaf='dir', top=top)
        if os.path.lexists(archive / lsha) or archive.stat().st_dev != d.stat().st_dev:
            refuse('retire', 'already archived, or the archive is on another filesystem (no atomic rename)')
        os.rename(d, archive / lsha)
        _fsync_dir(archive); _fsync_dir(d.parent)
        return {'retired': lsha, 'to': str(archive / lsha)}
    finally:
        os.close(fd)


def _installed_wrapper():
    b = _read_bytes(WRAPPER_SOURCE)                                   # r6: the INSTALLED wrapper, exactly its pinned bytes
    if sha(b) != WRAPPER_SHA256:
        refuse('wrapper', f'{WRAPPER_SOURCE} is not the reviewed r6 wrapper {WRAPPER_SHA256[:12]}...')
    W = _exec_bytes('chain_service', b, WRAPPER_SOURCE)
    if not hasattr(W, 'launch_handshake'):
        refuse('wrapper', 'the installed chain_service.py is not the r2 handshake wrapper')
    return W


def _r5_wrapper(W):
    if not all(hasattr(W, k) for k in ('launch_finality', 'A1_ADMISSION_LEDGER')) or 'finality-terminal' not in W.JOURNAL_NEXT:
        refuse('wrapper', 'the installed chain_service.py is not the finality r6 wrapper')


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    cmds = {'produce', 'arm', 'rearm', 'record-bootstrapped', 'record-finality', 'permit-restart', 'permit-restart-auto', 'quarantine',
            'rollback', 'retire'}
    if len(argv) < 3 or argv[1] not in cmds:
        print(__doc__); return 2
    try:
        if argv[1] == 'produce':                                         # produce <a2a4-config> <new-out-dir> [<predecessor-sha>]
            ra = 'reanchor' in json.loads(pathlib.Path(argv[2]).read_bytes())
            A = load_a2a4(RECOVERY_A2A4_SOURCE, RECOVERY_A2A4_SHA256) if ra else load_a2a4(); W = _installed_wrapper()
            cov = W.coverage_activation(W.CONFIG, W.ROOT / 'manifest.json', (W.MANIFEST.get('binaries') or {}).get('base'))
            r = produce(argv[2], argv[3], A=A, coverage=cov, predecessor=argv[4] if len(argv) > 4 else None,
                        archive=W.BOOTSTRAP_ARCHIVE, W=W, watermark=W.BOOTSTRAP_WATERMARK)
            r['next'] = 'pin chain.json baseBootstrap.anchorLaunch {launchSha256} (reviewed manual step), then arm'
        elif argv[1] in ('arm', 'rearm'):                                # arm|rearm <launch-dir> <a2a4-config>
            ra = 'reanchor' in json.loads(pathlib.Path(argv[3]).read_bytes())
            A = load_a2a4(RECOVERY_A2A4_SOURCE, RECOVERY_A2A4_SHA256) if ra else load_a2a4(); W = _installed_wrapper()
            r = arm(argv[2], argv[3], A=A, W=W, archive=W.BOOTSTRAP_ARCHIVE, watermark=W.BOOTSTRAP_WATERMARK) if argv[1] == 'arm' \
                else rearm(argv[2], argv[3], A=A, W=W)
        elif argv[1] == 'retire':                                        # retire <launch-dir>
            W = _installed_wrapper(); r = retire(argv[2], W.BOOTSTRAP_ARCHIVE, W=W)
        elif argv[1] == 'record-bootstrapped':
            r = record_bootstrapped(argv[2], None)
        elif argv[1] == 'record-finality':                               # record-finality <launch-dir> <chain.json> <rpc-url>
            if len(argv) != 5:
                print(__doc__); return 2
            W = _installed_wrapper(); _r5_wrapper(W)
            r = record_finality(argv[2], argv[3], pathlib.Path(argv[2]) / 'finality', argv[4], W=W, F=load_finality(), watermark=W.BOOTSTRAP_WATERMARK)
        elif argv[1] in ('permit-restart', 'permit-restart-auto', 'quarantine'):   # <cmd> <launch-dir> <a2a4-config>
            if len(argv) != 4:
                print(__doc__); return 2
            ra = 'reanchor' in json.loads(_read_bytes(pathlib.Path(argv[3])))
            A = load_a2a4(RECOVERY_A2A4_SOURCE, RECOVERY_A2A4_SHA256) if ra else load_a2a4(); W = _installed_wrapper(); _r5_wrapper(W)
            if argv[1] == 'quarantine':
                r = quarantine(argv[2], argv[3], A=A, W=W)
            else:
                r = (permit_restart_auto if argv[1] == 'permit-restart-auto' else permit_restart)(argv[2], argv[3], A=A, W=W, watermark=W.BOOTSTRAP_WATERMARK)
        else:                                                            # rollback <launch-dir> <reason>
            r = rollback(argv[2], argv[3], W=_installed_wrapper())
    except (Refused, OSError, KeyError, IndexError) as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(json.dumps({'ok': True, **r}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
