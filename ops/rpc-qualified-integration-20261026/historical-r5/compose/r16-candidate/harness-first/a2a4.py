#!/usr/bin/env python3
"""A2-A4 harness: authenticate header N against the A1 output root, unwind the Base reth datadir OFFLINE-STOPPED to exactly N,
rebuild the state commitment at N and compare it with the authenticated header-N state root, BEFORE derivation may start.

PREPARED ONLY. Root runs it inside the RPC guest, as the service user, with the Base node STOPPED, after root review and after
the snapshot download finished. It never starts a node, never touches consensus/admin config, never deletes anything it did
not create. Every step is fail-closed and records evidence under <workdir>/ (0700, never reused).

  a2a4.py plan      CONFIG   read-only: every gate, the exact commands that WOULD run (nothing mutates)
  a2a4.py a2        CONFIG   read header N from the datadir and authenticate it (read-only)
  a2a4.py a3        CONFIG   chunked unwind to exactly N (MUTATES the datadir; needs inPlaceReviewed)
  a2a4.py a4        CONFIG   merkle drop + full rebuild at N (MUTATES; checks state root == authenticated N)
  a2a4.py release   CONFIG   final gates + fresh A1 re-check -> writes the M10 launch record (or refuses)

A1 evidence (gate_a1; a1-a2-integration PREPARED copy, see README.md there). This harness has no light client: it CANNOT re-verify
Helios. Every A1 file is therefore a TRUSTED ROOT-PRODUCED record: read once from an open root-owned, not group/other-writable
regular file (no symlink), sha-pinned or provenance-bound, and checked by the pinned JS gate (a1gate/, reusing the reviewed
loadInitialReceipt). The labels helios-call / mpt-proof are the root runner's record of how a value was obtained, not a proof.
  a1Mode fresh-initial          (default) a fresh INITIAL `A1-authenticated` receipt naming exactly the planned N/root/game
  a1Mode original-game-recheck  the PINNED initial receipt (A1_INITIAL_SHA256 == a1InitialSha256) + the root-reviewed recheck
                                receipt of THAT receipt (sha == a1RecheckSha256) + its run-recheck.py run record; N/root/game
                                stay the INITIAL values: the latest anchor (and any descendant) is an observation only

Pinned-source semantics (base v1.5.1 -> base-reth 2.5.2 7134be3; see PROCEDURE.md for file:line):
  - `base reth stage unwind --datadir D --config F to-block T`  (non-offline: truncates headers/bodies/static files and lowers
    ChainState finalized/safe; Distance guard only; commits per stage step: NO rollback)
  - v2 storage (HashedAccounts/HashedStorages ARE canonical state): hashing stages are no-ops/destructive -> refused here;
    the state commitment is checked by `stage drop merkle` + `stage run merkle --from 0 --to N --commit --skip-unwind`
    (from==0 -> full rebuild; validate_state_root against header N; mismatch -> exit 1)
  - `db get` exits 0 with EMPTY output on a missing key -> every read here requires non-empty, parsed output.
"""
import base64, datetime, fcntl, hashlib, json, os, pathlib, re, shutil, signal, stat, subprocess, sys, tempfile, time, types
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import selection as SEL

MAINNET = {'l1ChainId': 1, 'l2ChainId': 8453, 'portal': '0x49048044d57e1c92a77f79988d21fa8faf74e97e',
           'asr': '0x909f6cf47ed12f010a796527f562bfc26c7f4e72', 'respectedGameType': 621,
           'codeHashes': {'0x49048044d57e1c92a77f79988d21fa8faf74e97e': '0x7d1cd19d713c8d64bf663f4168250abfbf690dbb6214c25bf757fee383816914',
                          '0x909f6cf47ed12f010a796527f562bfc26c7f4e72': '0xfa8c9db6c6cab7108dea276f4cd09d575674eb0852c0fa3187e59e98ef977998'}}
STATE_FLOOR = 52_500_000                 # root: stateHistoryFromBlock (changesets held from here)
SNAPSHOT_HEAD = 53_048_526               # manifest 1792886410 (sha 1f0c4e6c...)
# capability check against the PINNED binary's own help at use; root's capture outputs/.../base-cli-help-2025/help.out
# (binary 9c44836d...) confirms every flag below except `db get` (not captured: checked live here)
REQUIRED_HELP = {
    ('stage', 'unwind'): ['--datadir', '--config', 'to-block', '--offline'],
    ('stage', 'run'): ['--from', '--to', '--commit', '--skip-unwind', '--checkpoints', '--config'],
    ('stage', 'drop'): ['merkle', '--config'],
    ('db', 'get'): ['static-file', 'mdbx'],
    ('db', '--help'): ['get', 'settings', 'stage-checkpoints'],
}
TRUSTED_UID = 0                                  # receipt, manifest and marker must be root-owned (tests override)
MANIFEST_SHA = '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'
SNAPSHOT_UNIT = 'enclave-rpc-base-snapshot.service'
# Units that must be STOPPED before any DB is opened (source: stage_node_units.py, stage_backend.py): the Base node with its
# EMBEDDED consensus (`chain_service.py base` runs `base --chain mainnet rpc`), the marker-triggered auto-start path unit
# (PathExists=<mount>/snapshot-complete would START the node), and the downloader. Config may only ADD units.
REQUIRED_UNITS = ('enclave-base-holder.service', 'enclave-base-holder.path', SNAPSHOT_UNIT)
ALLOW_INCOMPLETE_PROC_SCAN = False                # tests only: unprivileged runs cannot read other users' fd tables
LIMITS = {'help': (60, 1 << 20), 'read': (900, 64 << 20), 'merkle-drop': (3600, 256 << 20)}   # (timeout s, stdout cap)
MUTATING = {'unwind': 'unwindChunkSec', 'merkle-drop': None, 'merkle-run': 'merkleSec'}
LOG_CAP, STDERR_CAP, GRACE_SEC = 256 << 20, 16 << 20, 120
FORBIDDEN_STAGES_V2 = ('hashing', 'account-hashing', 'storage-hashing', 'execution')
# ---- A1 evidence pins (a1-a2-integration) ----
A1_MODES = ('fresh-initial', 'original-game-recheck', 'capture-original-recheck')
# production-bootstrap-wiring (bootstrap-closure-review A1/C): the two LEGACY modes accept root-owned receipt FILES whose provenance is
# self-asserted (run-result.json); production refuses them. The first bootstrap's A1 is capture-original-recheck: the reviewed capture
# module's `recheck` of the SOURCE-pinned initial receipt, verified HERE (verify) and admitted HERE (the shared ledger). Tests only:
A1_LEGACY_MODES = ('fresh-initial', 'original-game-recheck')
A1_LEGACY_TEST_ONLY = False
A1_FILE_CAP = 1 << 20
A1_MAX_L1_AGE_SEC = 1800                          # recorded finalized-header age (A1 DEFAULT_MAX_FINALIZED_AGE_SEC)
A1_RUN_WINDOW_SEC = 300                           # receipt `at` - finalized timestamp - recorded age: the runner's own read time
A1_INITIAL_SHA256 = 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'   # live-1958/a1-evidence.json (tests override)
A1_GATE_PINS = {'a1-gate.mjs': '06cc29612d1d380e91c932dc13ed676e153c8aab368103eac673c4004409414c',      # a1-a2-integration (new)
                'a1-recheck.mjs': 'f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8',   # a1-original-game, unmodified
                'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d'}    # l1-anchor-a1, unmodified
RECHECK_INPUT_PINS = {'a1-recheck.mjs': 'f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8',  # run-recheck.py inputPins
                      'a1-recheck-read.mjs': '78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825',
                      'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d',
                      'a1-read.mjs': 'da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274f85',
                      'vendor/anchor-bootstrap.mjs': '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8'}
A1_RECHECK_KEYS = ('a1InitialEvidence', 'a1InitialSha256', 'a1RecheckSha256', 'a1RunResult')
# ---- production-bootstrap-wiring: the reviewed capture closure, VERBATIM from harness/a2a4.py (the recovery harness) ----
A1_CAPTURE_SOURCE = pathlib.Path('/opt/enclave-rpc/a1-capture/a1_capture.py')    # HOLD: not installed
A1_CAPTURE_SHA256 = '8da369de00c176364aadac5af57842f2a2d02f3abee20f63fe4361b7a1b0793e'   # base-finality-proof-stage/r10/capture/a1_capture.py (closure + r10 elUrl/verify fixes)
A1_FIRST_CAPTURE_REVIEWED = False   # production-bootstrap-wiring: THIS harness's capture flag (installer FLAG_MODULE)
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


A1_CAPTURE_TEST_PINS = None     # TESTS ONLY: a callable -> that module's Pins over pinned stub sources; production: its reviewed Pins()
_A1_CAPTURE = None


class Refused(Exception):
    pass


def refuse(code, why):
    raise Refused(f'{code}: {why}')


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


# ---- config ---------------------------------------------------------------------------------------------------------------
KEYS = {'datadir', 'baseBinary', 'baseBinarySha256', 'rethConfig', 'workdir', 'a1Evidence', 'a1MaxAgeSec', 'N', 'outputRoot', 'game',
        'downloadReceipt', 'manifestPath', 'snapshotMarker', 'timeouts', 'inPlaceReviewed', 'unwindChunk', 'serviceUnits', 'anchorModule',
        'depsRoot', 'node', 'minFreeBytes', 'backup', 'bytecodeChecker', 'bytecodeCheckerSha256', 'a1Mode', 'a1GateDir', 'a1CaptureOut', *A1_RECHECK_KEYS}


def load_config(path):
    c = json.loads(pathlib.Path(path).read_text())
    if not isinstance(c, dict) or set(c) - KEYS:
        refuse('bad_config', f'unknown keys {sorted(set(c) - KEYS)}')
    for k in ('datadir', 'baseBinary', 'rethConfig', 'workdir', 'a1Evidence', 'anchorModule', 'depsRoot', 'node', 'downloadReceipt',
              'manifestPath', 'snapshotMarker'):
        if not isinstance(c.get(k), str) or not os.path.isabs(c[k]):
            refuse('bad_config', f'{k} must be an absolute path')
    if not re.fullmatch(r'[0-9a-f]{64}', str(c.get('baseBinarySha256', ''))):
        refuse('bad_config', 'baseBinarySha256 must be 64 hex')
    if not isinstance(c.get('N'), int) or not STATE_FLOOR <= c['N'] < SNAPSHOT_HEAD:
        refuse('bad_config', f'N must be an integer in [{STATE_FLOOR}, {SNAPSHOT_HEAD})')
    if not re.fullmatch(r'0x[0-9a-f]{64}', str(c.get('outputRoot', ''))) or not re.fullmatch(r'0x[0-9a-f]{40}', str(c.get('game', ''))):
        refuse('bad_config', 'outputRoot/game must be lowercase hex')
    if not isinstance(c.get('a1MaxAgeSec'), int) or not 60 <= c['a1MaxAgeSec'] <= 3600:
        refuse('bad_config', 'a1MaxAgeSec must be 60..3600 (A1 is re-run at use; an old file is never accepted)')
    if not isinstance(c.get('unwindChunk'), int) or not 1_000 <= c['unwindChunk'] <= 50_000:
        refuse('bad_config', 'unwindChunk must be 1000..50000 (the non-offline unwind runs one unthrottled batch per call)')
    extra = c.get('serviceUnits', [])
    if not isinstance(extra, list) or not all(isinstance(u, str) and re.fullmatch(r'[A-Za-z0-9@._-]+\.(service|path|timer|socket)', u) for u in extra):
        refuse('bad_config', 'serviceUnits may only ADD unit names to the required set')
    c['serviceUnits'] = list(dict.fromkeys(list(REQUIRED_UNITS) + extra))
    t = c.get('timeouts')
    if not isinstance(t, dict) or set(t) != {'unwindChunkSec', 'merkleSec', 'bytecodeSec'} or not (isinstance(t['unwindChunkSec'], int) and 600 <= t['unwindChunkSec'] <= 86_400) \
            or not (isinstance(t['merkleSec'], int) and 3600 <= t['merkleSec'] <= 604_800) or not (isinstance(t['bytecodeSec'], int) and 600 <= t['bytecodeSec'] <= 172_800):
        refuse('bad_config', 'timeouts {unwindChunkSec 600..86400, merkleSec 3600..604800, bytecodeSec 600..172800} must be declared (real operations take hours)')
    c.setdefault('inPlaceReviewed', False); c.setdefault('backup', None); c.setdefault('minFreeBytes', 50 * 10**9)
    c.setdefault('a1Mode', 'fresh-initial')
    if c['a1Mode'] not in A1_MODES:
        refuse('bad_config', f'a1Mode must be one of {A1_MODES}')
    if not isinstance(c.get('a1GateDir'), str) or not os.path.isabs(c['a1GateDir']):
        refuse('bad_config', 'a1GateDir must be an absolute path (the pinned a1gate/ modules)')
    if c['a1Mode'] in A1_LEGACY_MODES and not A1_LEGACY_TEST_ONLY:
        refuse('a1_legacy', f'a1Mode {c["a1Mode"]} accepts self-asserted receipt files: refused in production; the first bootstrap runs '
               'capture-original-recheck (a verified capture-module recheck of the pinned initial receipt)')
    if c['a1Mode'] == 'capture-original-recheck':
        if not isinstance(c.get('a1CaptureOut'), str) or not os.path.isabs(c['a1CaptureOut']):
            refuse('bad_config', 'a1CaptureOut (absolute: the capture module\'s recheck OUT directory) is required in capture-original-recheck')
        if c['a1Evidence'] != os.path.join(c['a1CaptureOut'], 'capture', 'evidence.json'):
            refuse('bad_config', 'in capture-original-recheck a1Evidence is the capture evidence (no other receipt path)')
    elif 'a1CaptureOut' in c:
        refuse('bad_config', 'a1CaptureOut belongs to a1Mode capture-original-recheck only')
    if c['a1Mode'] == 'original-game-recheck':
        for k in ('a1InitialEvidence', 'a1RunResult'):
            if not isinstance(c.get(k), str) or not os.path.isabs(c[k]):
                refuse('bad_config', f'{k} must be an absolute path in original-game-recheck mode')
        for k in ('a1InitialSha256', 'a1RecheckSha256'):
            if not re.fullmatch(r'[0-9a-f]{64}', str(c.get(k, ''))):
                refuse('bad_config', f'{k} must be 64 lowercase hex in original-game-recheck mode')
    elif any(k in c for k in A1_RECHECK_KEYS):
        refuse('bad_config', f'{list(A1_RECHECK_KEYS)} belong to a1Mode original-game-recheck only')
    return c


# ---- command runner (every reth call goes through here; tests replace baseBinary with a fake) -----------------------------
def exited_unreaped(pid):
    """True once our child `pid` exited. waitid(WNOWAIT) does NOT reap it: as an unreaped zombie its pid, which is also the
    process-group id of its session (start_new_session), stays reserved, so signalling that group cannot hit a reused id."""
    r = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    return r is not None and r.si_pid == pid


def group_members(pgid, exclude=()):
    out = []
    for p in pathlib.Path('/proc').iterdir():
        if p.name.isdigit() and int(p.name) not in exclude:
            try:
                st = (p / 'stat').read_text(); fields = st[st.rfind(')') + 2:].split()
                if int(fields[2]) == pgid: out.append(int(p.name))
            except (OSError, ValueError, IndexError):
                pass
    return out


def _wait(cond, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if cond(): return True
        time.sleep(0.05)
    return cond()


def settle_owned(p, stop, grace):
    """Ownership-safe end of OUR child's process group. Every signal is sent while the leader is still ours and UNREAPED:
      1. stop=True (bound hit): killpg TERM while the leader runs; wait `grace` for its exit (WNOWAIT); else killpg KILL.
      2. leader exited, still a zombie: any other member of its group is ours -> TERM, grace, KILL, wait.
      3. only then reap the leader (p.wait()). No signal is ever sent after reaping.
    -> (returncode or None if the leader could not be stopped/reaped, stray member count seen in step 2).
    LIMIT: descendants that left the group (setsid/setpgid) are not tracked; reth is not expected to do that."""
    pg = p.pid
    if stop and not exited_unreaped(pg):
        os.killpg(pg, signal.SIGTERM)
        if not _wait(lambda: exited_unreaped(pg), grace):
            os.killpg(pg, signal.SIGKILL)
            if not _wait(lambda: exited_unreaped(pg), 60):
                return None, len(group_members(pg))          # unkillable (D state): NOT reaped, caller refuses
    stray = group_members(pg, exclude=(pg,))
    if stray:
        os.killpg(pg, signal.SIGTERM)                         # leader is an unreaped zombie: the group id is still ours
        if not _wait(lambda: not group_members(pg, exclude=(pg,)), grace):
            os.killpg(pg, signal.SIGKILL)
            _wait(lambda: not group_members(pg, exclude=(pg,)), 30)
    return p.wait(), len(stray)


def journal(w):
    p = w / 'mutation-journal.jsonl'
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


def journal_append(w, rec):
    with open(w / 'mutation-journal.jsonl', 'a') as f:
        f.write(json.dumps(rec) + '\n'); f.flush(); os.fsync(f.fileno())


def journal_guard(w):
    j = journal(w)
    if j and (j[-1]['state'] != 'finished' or j[-1].get('rc') != 0):
        refuse('interrupted_mutation', f'mutation journal ends with {j[-1]["state"]} rc={j[-1].get("rc")} for {j[-1]["argv"][2:5]}: the datadir state is UNKNOWN; '
               'no step continues automatically (PROCEDURE.md §4: inspect read-only, then root decides; default recovery = re-download)')


class Base:
    def __init__(self, c, log, w=None):
        self.c, self.log, self.w, self.n = c, log, w, 0
        self.db_allowed = False                       # set only by gate_static in THIS process

    def limits(self, cls):
        return LIMITS[cls] if cls in LIMITS else (self.c['timeouts'][MUTATING[cls]], LOG_CAP)

    def run(self, *args, cls='read', allow_fail=False):
        timeout, cap = self.limits(cls); mut = cls in MUTATING
        if args and args[0] in ('db', 'stage') and '--help' not in args and not self.db_allowed:
            refuse('ungated_db_access', f'{" ".join(args[:3])}: DB access before gate_static passed in this process')
        argv = [self.c['baseBinary'], 'reth', *args]
        env = {k: v for k, v in os.environ.items() if k not in ('BASE_CHAIN',)}     # `base reth` refuses with BASE_CHAIN set
        d = pathlib.Path(self.c['workdir']) / 'cmd'; d.mkdir(mode=0o700, exist_ok=True)
        self.n += 1; tag = f'{now().strftime("%Y%m%dT%H%M%S%fZ")}-{self.n:04d}'
        out_p, err_p = d / f'{tag}.out', d / f'{tag}.err'
        if mut:
            seq = len(journal(pathlib.Path(self.c['workdir']))) + 1
            journal_append(pathlib.Path(self.c['workdir']), {'seq': seq, 'state': 'started', 'argv': argv, 'at': now().isoformat()})
        t0, why = time.monotonic(), None
        with open(out_p, 'xb') as o, open(err_p, 'xb') as e:
            p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=o, stderr=e, env=env, start_new_session=True)
            while not exited_unreaped(p.pid):                 # never poll()/wait() here: that would reap the leader early
                if time.monotonic() - t0 > timeout: why = f'timeout after {timeout} s'
                elif out_p.stat().st_size > cap or err_p.stat().st_size > STDERR_CAP: why = f'output cap ({cap} B) exceeded'
                if why: break
                time.sleep(0.05)
        rc, stray = settle_owned(p, why is not None, GRACE_SEC if mut else 10)
        if rc is None:
            why = (why or 'stopped') + '; leader could not be stopped (not reaped)'
        elif not why and stray:
            why = f'process group left {stray} member(s) after the command exited (stopped)'
        if not why and (out_p.stat().st_size > cap or err_p.stat().st_size > STDERR_CAP):
            why = f'output cap ({cap} B) exceeded'          # re-checked after a quick exit too
        if mut:
            journal_append(pathlib.Path(self.c['workdir']), {'seq': seq, 'state': 'interrupted' if why else 'finished', 'rc': rc, 'why': why,
                                                              'argv': argv, 'at': now().isoformat()})
        stdout = '' if mut or out_p.stat().st_size > cap else out_p.read_text(errors='replace')   # mutation logs stay on disk
        with open(err_p, 'rb') as e: e.seek(max(0, err_p.stat().st_size - 400)); err_tail = e.read().decode(errors='replace')
        self.log.append({'argv': argv, 'class': cls, 'rc': rc, 'sec': round(time.monotonic() - t0, 3), 'stdoutBytes': out_p.stat().st_size,
                         'stdoutLog': str(out_p), 'stderrTail': err_tail, 'stopped': why})
        if why:
            refuse('bounded', f'{" ".join(args[:3])}: {why}; own process group {p.pid} stopped' +
                   ('; MUTATION INTERRUPTED: datadir state unknown' if mut else ''))
        if rc != 0 and not allow_fail:
            refuse('reth_failed', f'{" ".join(args[:3])} rc={rc}: {err_tail.strip()[-300:]}')
        return types.SimpleNamespace(stdout=stdout, stderr=err_tail, returncode=rc)

    def db(self, *args):
        p = self.run('db', '--datadir', self.c['datadir'], '--config', self.c['rethConfig'], *args)
        if not p.stdout.strip():
            refuse('empty_read', f'db {" ".join(args)} printed nothing (a missing key exits 0 in this client): refusing')
        return p.stdout


def last_json(text):
    """`db get` prints a label line then JSON blocks; take the FIRST JSON object after 'Header'."""
    m = re.search(r'Header\s*\n(\{.*?\n\})', text, re.S) or re.search(r'(\{.*\})', text, re.S)
    if not m:
        refuse('unparsed', 'no JSON object in db output')
    return json.loads(m.group(1))


# Pinned reth 7134be3b51cf9d9504f988bff3266a23085f0bd9 (base-v1.5.1 Cargo.lock rev):
#  - `db stage-checkpoints get` without a stage prints `{stage}: {checkpoint:?}` for EVERY row of tables::StageCheckpoints
#    (crates/cli/commands/src/db/stage_checkpoints.rs `get`, None branch): the key is the StageId Display string and the value
#    the StageCheckpoint Debug `StageCheckpoint { block_number: N, stage_checkpoint: <Option<StageUnitCheckpoint>> }`;
#  - StageId Display = as_str (crates/stages/types/src/id.rs): 'Headers', 'Bodies', 'Execution', 'MerkleExecute', 'Finish', ...;
#  - live-sync persistence (DatabaseProvider::save_blocks -> update_pipeline_stages, crates/storage/provider/src/providers/
#    database/provider.rs) moves EVERY StageId::ALL row to the persisted tip and records a LAGGING state/trie frontier ONLY in
#    Finish's FinishCheckpoint.partial_state_trie (crates/stages/types/src/checkpoints.rs): labels are not persisted state.
STAGE_KEYS = {'Headers': 'headers', 'Bodies': 'bodies', 'Execution': 'execution', 'MerkleExecute': 'merkle-execute', 'Finish': 'finish'}
KNOWN_STAGES = frozenset({'StaticFile', 'MerkleChangeSets', 'Era', 'Headers', 'Bodies', 'SenderRecovery', 'Execution', 'PruneSenderRecovery',
                          'MerkleUnwind', 'AccountHashing', 'StorageHashing', 'MerkleExecute', 'TransactionLookup', 'IndexAccountHistory',
                          'IndexStorageHistory', 'Prune', 'Finish'})           # id.rs as_str (StageId::Other refused: not this client)
STAGE_ROW = re.compile(r'(?P<s>[A-Za-z]+): StageCheckpoint \{ block_number: (?P<n>[0-9]+), stage_checkpoint: (?P<d>None|Some\(.*\)) \}')
FINISH_DETAIL = re.compile(r'Some\(Finish\(FinishCheckpoint \{ partial_state_trie: (?:None|Some\((?P<p>[0-9]+)\)) \}\)\)')


def parse_checkpoints(text):
    """-> ({canonical key: block_number} for the five stages the harness uses, state frontier). Every non-empty line must be a
    well-formed row of a known StageId; duplicates and missing required rows refuse. state frontier = Finish.partial_state_trie
    when recorded, else Finish.block_number; never above Finish."""
    rows = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        m = STAGE_ROW.fullmatch(line.strip())
        if not m:
            refuse('unparsed', f'not a pinned stage-checkpoints row: {line.strip()[:160]!r}')
        if m['s'] not in KNOWN_STAGES:
            refuse('unparsed', f'unknown stage {m["s"]!r} (not a pinned StageId)')
        if m['s'] in rows:
            refuse('unparsed', f'duplicate checkpoint row for {m["s"]}')
        rows[m['s']] = (int(m['n']), m['d'])
    missing = [s for s in STAGE_KEYS if s not in rows]
    if missing:
        refuse('unparsed', f'no checkpoint for {missing}')
    fin_n, fin_d = rows['Finish']
    if fin_d == 'None':
        state = fin_n
    else:
        f = FINISH_DETAIL.fullmatch(fin_d)
        if not f:
            refuse('unparsed', f'Finish stage_checkpoint is not a FinishCheckpoint: {fin_d[:160]!r}')
        state = int(f['p']) if f['p'] is not None else fin_n
    if state > fin_n:
        refuse('unparsed', f'state frontier {state} above the Finish checkpoint {fin_n}')
    return {k: rows[s][0] for s, k in STAGE_KEYS.items()}, state


def checkpoint_block(text, stage):
    """canonical key ('headers', 'merkle-execute', ...) -> block_number, from the pinned output (parse_checkpoints)"""
    cps, _state = parse_checkpoints(text)
    if stage not in cps:
        refuse('unparsed', f'no checkpoint for {stage}')
    return cps[stage]


def load_capture():
    """The reviewed capture module, executed from exactly its pinned bytes (HOLD until A1_CAPTURE_REVIEWED)."""
    global _A1_CAPTURE
    if not reviewed('A1_FIRST_CAPTURE_REVIEWED'):
        refuse('a1_capture_pending', 'HOLD: the A1 capture module (a1-capture-binding-stage/r4) is not reviewed for use (A1_FIRST_CAPTURE_REVIEWED)')
    if _A1_CAPTURE is None or _A1_CAPTURE[0] != (str(A1_CAPTURE_SOURCE), A1_CAPTURE_SHA256):
        b = _read_trusted(str(A1_CAPTURE_SOURCE), 'A1 capture module', 4 << 20)
        if hashlib.sha256(b).hexdigest() != A1_CAPTURE_SHA256:
            refuse('a1_capture_pin', f'{A1_CAPTURE_SOURCE} is not the reviewed capture module {A1_CAPTURE_SHA256[:12]}...')
        m = types.ModuleType('a1_capture_reviewed'); m.__file__ = str(A1_CAPTURE_SOURCE); sys.modules['a1_capture_reviewed'] = m
        exec(compile(b, str(A1_CAPTURE_SOURCE), 'exec'), m.__dict__)
        _A1_CAPTURE = ((str(A1_CAPTURE_SOURCE), A1_CAPTURE_SHA256), m)
    return _A1_CAPTURE[1]



LEDGER_FORMAT = 'enclave-a1-admission-ledger/v1'
LEDGER_KEYS = {'format', 'seq', 'prevSha256', 'at', 'keys'}
LEDGER_KEY = re.compile(r'(capture|evidence|record):[0-9a-f]{32,64}')
LEDGER_MAX = 16 << 20
LEDGER_LOCK_TIMEOUT_SEC = 60
# finality r5 (base-finality-proof-stage/r5): the ONE shared admission ledger (== chain_service.A1_ADMISSION_LEDGER). Every admission
# and every admission check goes through _ledger_paths, which refuses any other path BEFORE the ledger is read or written, so
# re-anchor admissions and post-anchor finality admissions are one replay domain. A source constant, never config.
A1_ADMISSION_LEDGER = pathlib.Path('/etc/enclave-rpc/base-a1-admission.jsonl')


def ledger_line(rec):
    """The one canonical encoding of a ledger record (sorted keys, no spaces) + newline."""
    return json.dumps(rec, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def _ledger_paths(c):
    p = pathlib.Path(c['reanchor']['admissionLedger'])
    if p != A1_ADMISSION_LEDGER:
        refuse('a1_ledger_path', f'{p} is not the shared A1 admission ledger {A1_ADMISSION_LEDGER}: nothing is admitted or checked')
    st = os.lstat(p.parent)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != TRUSTED_UID or st.st_mode & 0o022:
        refuse('untrusted_file', f'{p.parent} (the ledger directory) must be a real directory owned by uid {TRUSTED_UID}, not group/other-writable')
    return p, p.with_name(p.name + '.lock')


def _ledger_lock(lock):
    """Exclusive flock on the stable sibling lock file (created 0600 if absent; never a symlink; owner TRUSTED_UID; fd == path)."""
    try:
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError as e:
        refuse('untrusted_file', f'ledger lock {lock} cannot be opened safely ({type(e).__name__}: a symlink is refused)')
    try:
        st, ln = os.fstat(fd), os.lstat(lock)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != TRUSTED_UID or st.st_mode & 0o077 or (st.st_dev, st.st_ino) != (ln.st_dev, ln.st_ino):
            refuse('untrusted_file', f'ledger lock {lock} must be a private regular file owned by uid {TRUSTED_UID}')
        deadline = time.monotonic() + LEDGER_LOCK_TIMEOUT_SEC
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                if time.monotonic() > deadline:
                    refuse('a1_ledger_busy', f'the admission ledger lock is held for > {LEDGER_LOCK_TIMEOUT_SEC} s: nothing admitted')
                time.sleep(0.02)
    except BaseException:
        os.close(fd)
        raise


def ledger_records(p):
    """The verified ledger -> ([(sha256 of line, record)], admitted key set, raw bytes). Refuses an incomplete tail (interrupted
    append), any non-canonical line, schema/seq/chain break, unsorted/empty/malformed keys, or a key admitted twice."""
    if not os.path.lexists(p):
        return [], set(), b''
    b = _read_trusted(str(p), 'A1 admission ledger', LEDGER_MAX)
    if b and not b.endswith(b'\n'):
        refuse('a1_ledger', 'the ledger ends in an incomplete record (an interrupted append): ambiguous, so nothing is admitted until root resolves it')
    out, seen, prev = [], set(), None
    for i, line in enumerate(b.split(b'\n')[:-1], 1):
        try:
            r = json.loads(line)
        except ValueError:
            refuse('a1_ledger', f'ledger record {i} is not JSON')
        if not (isinstance(r, dict) and set(r) == LEDGER_KEYS and r['format'] == LEDGER_FORMAT and r['seq'] == i and r['prevSha256'] == prev
                and isinstance(r['at'], str) and isinstance(r['keys'], list) and r['keys'] and r['keys'] == sorted(set(r['keys']))
                and all(isinstance(k, str) and LEDGER_KEY.fullmatch(k) for k in r['keys'])) or ledger_line(r) != line + b'\n':
            refuse('a1_ledger', f'ledger record {i} breaks the schema, sequence, hash chain or canonical encoding')
        if seen & set(r['keys']):
            refuse('a1_ledger', f'ledger record {i} repeats an already admitted key {sorted(seen & set(r["keys"]))[0]}')
        seen |= set(r['keys']); prev = hashlib.sha256(line + b'\n').hexdigest(); out.append((prev, r))
    return out, seen, b


def admit_captures(c, summaries):
    """Durable replay refusal: each capture (id, record, evidence) is admitted at most once, across steps, workdirs and launches.
    Under the ledger lock: read + verify the whole ledger, apply C.admit (in memory), append ONE canonical record with an exact
    full write + fsync (+ directory fsync when created), re-verify that it landed. Only then does the step proceed. A step that
    fails later needs a NEW capture (never a replay)."""
    C = load_capture(); p, lock = _ledger_paths(c)
    fd = _ledger_lock(lock)
    try:
        recs, seen, raw = ledger_records(p)
        new = set(seen)
        try:
            for summary in summaries:
                C.admit(summary, new)                     # the replay RULE only; nothing here is durable by itself
        except C.Refused as e:
            refuse('a1_replayed', f'{e.code}: {e}')
        rec = {'format': LEDGER_FORMAT, 'seq': len(recs) + 1, 'prevSha256': recs[-1][0] if recs else None, 'at': now().isoformat(),
               'keys': sorted(new - seen)}
        line = ledger_line(rec); created = not os.path.lexists(p)
        wfd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_CREAT | os.O_EXCL if created else 0), 0o600)
        try:
            if os.fstat(wfd).st_size != len(raw):
                refuse('a1_ledger', 'the ledger changed while the lock was held')
            view = memoryview(line)
            while view:
                n = os.write(wfd, view)
                if n <= 0:
                    refuse('a1_ledger', 'short write to the ledger')
                view = view[n:]
            os.fsync(wfd)
        finally:
            os.close(wfd)
        if created:
            dfd = os.open(p.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        after, _seen, _raw = ledger_records(p)
        if len(after) != rec['seq'] or after[-1][1] != rec:
            refuse('a1_ledger', 'the ledger append did not land')
    finally:
        os.close(fd)


def check_admissible(c, summaries):
    """finality r5: the replay RULE against the shared ledger, in memory only (`finality_state check`): nothing is written."""
    C = load_capture(); p, _lock = _ledger_paths(c)
    _recs, seen, _raw = ledger_records(p); new = set(seen)
    try:
        for summary in summaries:
            C.admit(summary, new)
    except C.Refused as e:
        refuse('a1_replayed', f'{e.code}: {e}')



def first_capture(c, out=None, fresh=True):
    """capture-original-recheck -> (verified summary, initial bytes, evidence bytes) of ONE capture-module `recheck` OUT: the module's
    own verify() (file set, hashes, runtime identity, argv/env, Helios pin at fresh-finalized, derivations, the pinned A1 gate), mode
    `recheck`, run against exactly the SOURCE-pinned initial receipt (A1_INITIAL_SHA256; the module's RECHECK_ORIGINAL game/N/root),
    finished within a1MaxAgeSec (fresh), bytes unchanged since verify. Never a receipt hash from config, never a translated file."""
    C = load_capture(); out = out or c['a1CaptureOut']
    kw = {'pins': A1_CAPTURE_TEST_PINS() if A1_CAPTURE_TEST_PINS else None, 'node': c['node'], 'workdir': str(workdir(c))}
    try:
        s = C.verify(out, **kw)
    except C.Refused as e:
        refuse('a1_capture', f'{e.code}: {e}')
    if s.get('mode') != 'recheck':
        refuse('a1_capture_binding', 'the A1 capture is not the capture module\'s original-game recheck (mode recheck)')
    if (s.get('boundInputs') or {}).get('inputs/initial-a1-evidence.json') != A1_INITIAL_SHA256:
        refuse('a1_initial_pin', f'the capture rechecked another initial receipt than the source pin {A1_INITIAL_SHA256[:12]}...')
    if fresh:
        age = (now() - _utc(s['finishedAt'], 'recheck capture finishedAt')).total_seconds()
        if age < 0 or age > c['a1MaxAgeSec']:
            refuse('a1_stale', f'the recheck capture finished {int(age)} s ago (max {c["a1MaxAgeSec"]}): capture a new recheck')
    ini = _read_trusted(os.path.join(out, 'capture', 'inputs', 'initial-a1-evidence.json'), 'captured initial receipt', A1_FILE_CAP)
    ev = _read_trusted(os.path.join(out, 'capture', 'evidence.json'), 'recheck capture evidence', A1_FILE_CAP)
    if hashlib.sha256(ini).hexdigest() != A1_INITIAL_SHA256 or hashlib.sha256(ev).hexdigest() != s['evidenceSha256']:
        refuse('a1_capture_binding', 'the capture evidence changed after it was verified')
    return s, ini, ev


def _ledger_c(c):
    """the recovery ledger functions read the ledger path from c['reanchor']; here it is ALWAYS the source constant"""
    return {**c, 'reanchor': {'admissionLedger': str(A1_ADMISSION_LEDGER)}}


# ---- gates ----------------------------------------------------------------------------------------------------------------
def _read_trusted(path, what, cap):
    """A root-produced evidence file, read ONCE: open without following a final symlink, check the OPEN file (regular, owner uid
    TRUSTED_UID, not group/other-writable, <= cap bytes) and return exactly those bytes (no stat/read race, no re-resolution)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        refuse('no_evidence', f'{what} {path} does not exist')
    except OSError as e:
        refuse('untrusted_file', f'{what} {path} cannot be opened as a regular non-symlink file: {e.strerror}')
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != TRUSTED_UID or st.st_mode & 0o022:
            refuse('untrusted_file', f'{what} {path} must be a regular file owned by uid {TRUSTED_UID} and not group/other-writable')
        b = f.read(cap + 1)
    if len(b) > cap:
        refuse('untrusted_file', f'{what} {path} exceeds {cap} bytes')
    return b


def _utc(s, what):
    try:
        t = datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError:
        t = None
    if t is None or t.tzinfo is None:
        refuse('a1_receipt', f'{what} {s!r} is not an ISO UTC time')
    return t


def a1_node_gate(c, inp):
    """The pinned JS gate over the exact bytes. The module files are read once, compared with A1_GATE_PINS and imported from a
    private copy in the 0700 workdir. -> the gate's normalized summary (every receipt-derived value below comes from here)."""
    d = pathlib.Path(tempfile.mkdtemp(prefix='a1gate-', dir=workdir(c)))
    try:
        for name, want in A1_GATE_PINS.items():
            b = pathlib.Path(c['a1GateDir'], name).read_bytes()
            if hashlib.sha256(b).hexdigest() != want:
                refuse('a1_gate_pin', f'{name} in a1GateDir differs from its pin')
            (d / name).write_bytes(b)
        script = ("const g=await import(process.env.G);const fs=await import('node:fs');const i=JSON.parse(fs.readFileSync(0,'utf8'));"
                  "try{console.log(JSON.stringify({ok:true,summary:g.gate(i)}))}catch(e){console.log(JSON.stringify({ok:false,code:e.code||'error',"
                  "error:String(e.message||e).slice(0,300)}));process.exit(3)}")
        p = subprocess.run([c['node'], '--input-type=module', '-e', script], input=json.dumps(inp), capture_output=True, text=True,
                           env=dict(os.environ, G=(d / 'a1-gate.mjs').as_uri()), timeout=60)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        refuse('a1_tool', f'A1 gate produced no verdict: {p.stderr[-300:]}')
    if p.returncode != 0 or r.get('ok') is not True:
        refuse('a1_receipt', f'{r.get("code")}: {r.get("error")}')
    return r['summary']


def gate_recheck_run(c, s):
    """Provenance of the recheck receipt: recheck.json + run-result.json of ONE run-recheck.py output dir, both root-owned; the run
    used the pinned recheck modules on the pinned initial receipt, exited 0, stopped Helios, and wrote the receipt inside its window."""
    ev, rp = pathlib.Path(c['a1Evidence']), pathlib.Path(c['a1RunResult'])
    if ev.name != 'recheck.json' or rp.name != 'run-result.json' or os.path.realpath(ev.parent) != os.path.realpath(rp.parent):
        refuse('a1_provenance', 'a1Evidence/a1RunResult must be recheck.json and run-result.json of ONE run-recheck.py output directory')
    try:
        r = json.loads(_read_trusted(rp, 'recheck run record', A1_FILE_CAP))
    except ValueError:
        refuse('a1_provenance', 'run-result.json is not JSON')
    if not isinstance(r, dict) or r.get('inputPins') != RECHECK_INPUT_PINS:
        refuse('a1_provenance', 'the recheck run did not use the pinned recheck modules (inputPins)')
    if r.get('initialSha256') != c['a1InitialSha256'] or type(r.get('recheckExit')) is not int or r['recheckExit'] != 0 \
            or r.get('processStopped') is not True or r.get('productionActivated') is not False or 'error' in r:
        refuse('a1_provenance', 'the recheck run record is not a clean exit-0 run over the pinned initial receipt with Helios stopped')
    if not _utc(r.get('startedAt'), 'run startedAt') <= _utc(s['at'], 'recheck at') <= _utc(r.get('finishedAt'), 'run finishedAt'):
        refuse('a1_provenance', 'the recheck receipt time lies outside its run record window')


def gate_a1(c, admit=True):
    """A1 evidence (module docstring). Both modes: root-owned exact bytes through the pinned JS gate, then here: receipt age <=
    a1MaxAgeSec, mainnet ASR/type/code-hash pins, exactly the planned N/output root/game, finalized-header age bounded and
    consistent with the receipt time. original-game-recheck additionally: pinned initial sha, root-reviewed recheck sha, run record."""
    cap = None
    if c['a1Mode'] == 'capture-original-recheck':          # production-bootstrap-wiring: the verified capture, then the SAME pinned JS gate
        cap, ini, ev = first_capture(c)
        s = a1_node_gate(c, {'mode': 'original-game-recheck', 'initial': base64.b64encode(ini).decode(), 'initialSha256': A1_INITIAL_SHA256,
                             'recheck': base64.b64encode(ev).decode()})
    elif c['a1Mode'] == 'fresh-initial':
        ev = _read_trusted(c['a1Evidence'], 'A1 evidence', A1_FILE_CAP)
        s = a1_node_gate(c, {'mode': 'fresh-initial', 'initial': base64.b64encode(ev).decode()})
    else:
        ev = _read_trusted(c['a1Evidence'], 'A1 evidence', A1_FILE_CAP)
        if c['a1InitialSha256'] != A1_INITIAL_SHA256:
            refuse('a1_initial_pin', f'a1InitialSha256 is not the pinned initial A1 receipt {A1_INITIAL_SHA256[:12]}... (a source change, never config)')
        if hashlib.sha256(ev).hexdigest() != c['a1RecheckSha256']:
            refuse('a1_recheck_sha', 'the recheck file is not the one root reviewed (a1RecheckSha256)')
        ini = _read_trusted(c['a1InitialEvidence'], 'initial A1 receipt', A1_FILE_CAP)
        s = a1_node_gate(c, {'mode': 'original-game-recheck', 'initial': base64.b64encode(ini).decode(), 'initialSha256': c['a1InitialSha256'],
                             'recheck': base64.b64encode(ev).decode()})
        gate_recheck_run(c, s)
    at = _utc(s['at'], 'A1 at')
    age = (now() - at).total_seconds()
    if age < 0 or age > c['a1MaxAgeSec']:
        refuse('a1_stale', f'A1 evidence is {int(age)} s old (max {c["a1MaxAgeSec"]}): re-run A1 now; an existing file is not accepted')
    if s['asr'] != MAINNET['asr'] or s['respectedGameType'] != MAINNET['respectedGameType']:
        refuse('a1_pins', 'ASR or respected game type is not the pinned mainnet value')
    for addr, ch in MAINNET['codeHashes'].items():
        if s['pins'].get(addr, {}).get('codeHash') != ch:
            refuse('a1_pins', f'code hash of {addr} differs from the pin')
    if s['mode'] == 'fresh-initial' and int(s['N']) > c['N']:
        refuse('a1_anchor_advanced', f'the ASR anchor advanced to {s["N"]} (> N): a fresh initial A1 names only the LATEST anchor; re-confirm game '
               f'{c["game"]} with a1Mode original-game-recheck - never re-anchor or accept descendants silently')
    if s['N'] != str(c['N']) or s['outputRoot'] != c['outputRoot'] or s['game'] != c['game']:
        refuse('a1_anchor', 'A1 anchor (N/outputRoot/game) differs from the planned one')
    l1 = s['l1']
    if l1['ageSec'] > A1_MAX_L1_AGE_SEC:
        refuse('a1_l1_stale', f'A1 L1 finalized header was older than {A1_MAX_L1_AGE_SEC} s')
    if not l1['ageSec'] <= at.timestamp() - l1['timestamp'] <= l1['ageSec'] + A1_RUN_WINDOW_SEC:
        refuse('a1_l1_stale', 'the recorded finalized-header age is inconsistent with the receipt time and header timestamp')
    g = {'mode': s['mode'], 'a1At': s['at'], 'a1AgeSec': int(age), 'l1Finalized': l1['number'], 'l1Hash': l1['hash'], 'initialSha256': s['initialSha256'],
         'N': s['N'], 'outputRoot': s['outputRoot'], 'game': s['game'], 'asr': s['asr']}
    if s['mode'] == 'original-game-recheck':
        g['initialL1'] = s['initialL1']; g['latestAnchorObservation'] = s['latestAnchorObservation']   # recorded, never used
    if cap is not None:
        g['a1Mode'] = c['a1Mode']
        g['recheckCapture'] = {'outPath': c['a1CaptureOut'], **{k: cap[k] for k in ('captureId', 'captureSha256', 'evidenceSha256', 'finishedAt')}}
        # admitted only after EVERY check passed, ONCE: plan only checks (admit=False); A2 and release each admit their own NEW capture
        if admit:
            admit_captures(_ledger_c(c), [cap])
        else:                                       # r2: a3/a4 re-run plan; THIS workdir's A2 capture (already admitted once) is re-verified,
            a2 = load(workdir(c), 'a2-authenticated.json', need=False)   # fresh-checked and accepted here without a second admission
            if (((a2 or {}).get('a1Gate') or {}).get('recheckCapture') or {}).get('captureSha256') != cap['captureSha256']:
                check_admissible(_ledger_c(c), [cap])
    return g


def bind_a1(w, g):
    """release: the A1 result names the SAME initial receipt, N, root, game and ASR the A2 authentication used, at an L1 block
    not older than A2's. A bootstrap can never switch to another receipt (or a descendant anchor) between A2 and release."""
    b = load(w, 'a2-authenticated.json').get('a1Gate')
    if not isinstance(b, dict):
        refuse('a1_binding', 'a2-authenticated.json records no A1 gate result: re-run a2')
    for k in ('initialSha256', 'N', 'outputRoot', 'game', 'asr'):
        if g[k] != b.get(k):
            refuse('a1_binding', f'release A1 {k} differs from the A1 used by A2')
    if not isinstance(b.get('l1Finalized'), int) or g['l1Finalized'] < b['l1Finalized']:
        refuse('a1_binding', 'release A1 is at an older L1 block than the A1 used by A2')


def _root_owned(path, what):
    st = os.stat(path)
    if st.st_uid != TRUSTED_UID or st.st_mode & 0o022:
        refuse('untrusted_file', f'{what} {path} must be owned by uid {TRUSTED_UID} and not group/other-writable')
    return st


def gate_download(c):
    """A root-written completion receipt bound to the pinned manifest, the unit's success, the (empty) marker and this datadir.
    The client verified every extracted output file against the manifest's per-file BLAKE3 (download/archive.rs VerifyOutputs) -
    only for files LISTED there, so every selected archive must carry a non-empty checksum list."""
    rp = c['downloadReceipt']
    if not os.path.isfile(rp):
        refuse('no_receipt', 'no root completed-download receipt: the snapshot is not proven complete (an empty marker alone is not accepted)')
    r = json.loads(_read_trusted(rp, 'receipt', 1 << 20))
    want = {'format': 'base-snapshot-completion-receipt/v1', 'manifestSha256': MANIFEST_SHA, 'block': SNAPSHOT_HEAD, 'chainId': 8453,
            'storageVersion': 2, 'unit': SNAPSHOT_UNIT, 'unitResult': 'success', 'execMainStatus': 0, 'datadir': c['datadir']}
    for k, v in want.items():
        if r.get(k) != v:
            refuse('receipt_fields', f'receipt {k}={r.get(k)!r}, expected {v!r}')
    mb = _read_trusted(c['manifestPath'], 'manifest', 64 << 20)
    if hashlib.sha256(mb).hexdigest() != MANIFEST_SHA:
        refuse('manifest_pin', 'the pinned manifest bytes differ')
    m = json.loads(mb)
    if (m.get('block'), m.get('chain_id'), m.get('storage_version')) != (SNAPSHOT_HEAD, 8453, 2):
        refuse('manifest_pin', 'manifest block/chain/storage version differ')
    if r.get('baseBinarySha256') != SEL.BASE_BINARY_SHA256:
        refuse('receipt_fields', 'receipt does not attribute the download to the pinned base binary')
    if r.get('profile') not in SEL.PROFILES:
        refuse('receipt_fields', f'unknown retention profile {r.get("profile")!r}')
    try:
        SEL.check_argv(r.get('downloadArgv'), r['profile'], c['datadir'], c['manifestPath'])
        got = SEL.validate_entries(r.get('selectedArchives'), m)
        want = SEL.derive(m, r['profile'])
    except SEL.SelectionError as e:
        refuse('manifest_selection', str(e))
    if got != want:
        refuse('manifest_selection', f'receipt selection differs from the pinned manifest + profile: missing {sorted(map(str, want - got))[:5]} extra {sorted(map(str, got - want))[:5]}')
    for key in sorted(got, key=str):
        files = SEL.checksums(m, key)
        if not files or not all(re.fullmatch(r'[0-9a-f]{64}', str(f.get('blake3', ''))) and f.get('path') and type(f.get('size')) is int for f in files):
            refuse('unverified_archive', f'{key}: the manifest lists no per-file BLAKE3 for it, so the client verified nothing (full verification not established)')
    if not SEL.PROFILES[r['profile']]['final']:
        refuse('first_pass_only', f'receipt profile {r["profile"]} is the first-pass selection, not the approved final retention ({SEL.FINAL_PROFILE})')
    sel = got
    show = lambda prop: subprocess.run(['systemctl', 'show', SNAPSHOT_UNIT, '-p', prop, '--value'], capture_output=True, text=True, timeout=30).stdout.strip()
    if (show('Result'), show('ExecMainStatus')) != ('success', '0'):
        refuse('download_unit', f'{SNAPSHOT_UNIT} did not finish successfully now')
    mk = _root_owned(c['snapshotMarker'], 'marker')
    if mk.st_size != 0:
        refuse('marker', 'the snapshot-complete marker is expected EMPTY (stage_backend.py ExecStartPost touch)')
    dd = os.stat(c['datadir'])
    if r.get('datadirIdentity') != {'dev': dd.st_dev, 'ino': dd.st_ino}:
        refuse('receipt_datadir', 'the receipt names another datadir (dev/ino)')
    return {'manifestSha256': MANIFEST_SHA, 'archives': len(sel)}


def gate_stopped(c):
    """BEFORE any DB open: every required/added unit inactive, and no process has a file open under the datadir."""
    for u in c['serviceUnits']:
        st = subprocess.run(['systemctl', 'show', u, '-p', 'ActiveState', '--value'], capture_output=True, text=True, timeout=30).stdout.strip()
        if st not in ('inactive', 'failed'):
            refuse('service_running', f'{u} is {st or "unknown"}: stop it before any DB access')
    root, users, unreadable = os.path.realpath(c['datadir']), [], 0
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name) == os.getpid():
            continue
        try:
            for fd in (p / 'fd').iterdir():
                try:
                    t = os.readlink(fd)
                except OSError:
                    continue
                if t == root or t.startswith(root + os.sep):
                    users.append(int(p.name)); break
        except PermissionError:
            unreadable += 1
        except OSError:
            pass
    if users:
        refuse('datadir_open', f'processes {users[:10]} hold files under the datadir')
    if unreadable and not ALLOW_INCOMPLETE_PROC_SCAN:
        refuse('proc_scan_incomplete', f'{unreadable} fd tables unreadable: run as root so every opener is visible')
    return {'unitsInactive': c['serviceUnits'], 'procScanUnreadable': unreadable}


def gate_static(c, base):
    """EVERY DB-touching step runs this first. Order: units stopped -> completed-download receipt -> binary pin -> file-only
    checks -> pinned help (binary only) -> ONLY THEN the first DB read (`db settings get`) and v2 enforcement. Base.run refuses any
    non-help `db`/`stage` call before this point in the process (ungated_db_access)."""
    base.db_allowed = False
    g = {'stopped': gate_stopped(c)}
    g['download'] = gate_download(c)
    if sha256(c['baseBinary']) != c['baseBinarySha256']:
        refuse('binary_pin', 'base binary sha256 differs from the pin')
    cfg = pathlib.Path(c['rethConfig']).read_text()
    for seg in ('account_history', 'storage_history'):
        m = re.search(rf'^{seg}\s*=\s*\{{\s*before\s*=\s*(\d+)\s*\}}', cfg, re.M)
        if not m or not int(m.group(1)) <= STATE_FLOOR:
            refuse('prune_config', f'{c["rethConfig"]} must set [prune.segments] {seg} = {{ before = <= {STATE_FLOOR} }} (a Distance profile refuses N)')
    if pathlib.Path(c['datadir'], 'proofs').exists():
        refuse('proofs_store', '<datadir>/proofs exists: the proofs-history store is NOT unwound by stage unwind; quarantine it first (root)')
    free = shutil.disk_usage(c['datadir']).free
    g['freeBytes'] = free
    if free < c['minFreeBytes']:
        refuse('capacity', f'only {free} bytes free on the datadir filesystem')
    if c['backup'] is not None:
        refuse('backup_unsupported', 'a full datadir copy is not prepared here: capacity/time must be measured first (see PROCEDURE.md)')
    for (a, b), need in REQUIRED_HELP.items():
        h = base.run(a, '--help', cls='help').stdout if b == '--help' else base.run(a, b, '--help', cls='help').stdout
        missing = [x for x in need if x not in h]
        if missing:
            refuse('capability', f'pinned `base reth {a} {b} --help` lacks {missing}: client capability differs from the audited source')
    base.db_allowed = True                            # every non-DB gate passed: the first DB read may happen now
    s = base.run('db', '--datadir', c['datadir'], '--config', c['rethConfig'], 'settings', 'get').stdout
    if 'storage_v2' not in s:
        base.db_allowed = False
        refuse('unparsed', 'db settings get did not print storage_v2')
    g['storageV2'] = 'storage_v2: true' in s
    if not g['storageV2']:
        base.db_allowed = False
        refuse('v1_layout', 'legacy (non-v2) storage: the plain->hashed rebuild path is NOT prepared/tested here; refusing')
    if not c['inPlaceReviewed']:
        g['inPlace'] = 'NOT REVIEWED: a3/a4 will refuse'
    return g


# ---- A2 -------------------------------------------------------------------------------------------------------------------
def read_header(c, base, n):
    out = base.db('get', 'static-file', 'headers', str(n))
    h = last_json(out)
    for k in ('number', 'stateRoot', 'withdrawalsRoot', 'parentHash', 'requestsHash'):
        if k not in h:
            refuse('header_format', f'header JSON lacks {k}: the pinned output format differs from the audited serde shape')
    return h


def authenticate(c, header):
    script = (
        "const fs=await import('node:fs');const m=await import(process.env.A);const d=await import(process.env.D);"
        "const i=JSON.parse(fs.readFileSync(0,'utf8'));"
        "try{const a=m.authenticateAnchor({rootClaim:i.rootClaim,l2BlockNumber:i.N},i.header,(b)=>d.keccak_256(b));"
        "console.log(JSON.stringify({ok:true,...a}))}catch(e){console.log(JSON.stringify({ok:false,code:e.code,error:e.message}));process.exit(3)}")
    deps = pathlib.Path(c['depsRoot'], 'node_modules/@noble/hashes/sha3.js')
    env = dict(os.environ, A=pathlib.Path(c['anchorModule']).as_uri(), D=deps.as_uri())
    p = subprocess.run([c['node'], '--input-type=module', '-e', script], input=json.dumps({'rootClaim': c['outputRoot'], 'N': c['N'], 'header': header}),
                       capture_output=True, text=True, env=env, timeout=60)
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        refuse('a2_tool', f'anchor check produced no verdict: {p.stderr[-300:]}')
    if p.returncode != 0 or not r.get('ok'):
        refuse('a2_mismatch', f'header N does not reproduce the A1 output root ({r.get("code")}: {r.get("error")})')
    return {'number': r['number'], 'blockHash': r['blockHash'], 'stateRoot': r['stateRoot'], 'messagePasserStorageRoot': r['messagePasserStorageRoot']}


# ---- state ----------------------------------------------------------------------------------------------------------------
def workdir(c):
    w = pathlib.Path(c['workdir'])
    w.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (w.stat().st_mode & 0o077) != 0:
        refuse('workdir', 'workdir must be 0700')
    return w


def save(w, name, obj):
    with open(w / name, 'x') as f:
        json.dump(obj, f, indent=1)


def load(w, name, need=True):
    p = w / name
    if not p.exists():
        if need:
            refuse('order', f'{name} missing: run the previous step first')
        return None
    return json.loads(p.read_text())


def head_checkpoints(c, base):
    return head_state(c, base)[0]


def head_state(c, base):
    """-> (canonical checkpoints, persisted state frontier) of the stopped DB (parse_checkpoints)"""
    return parse_checkpoints(base.db('stage-checkpoints', 'get'))


def require_reviewed(c):
    if not c['inPlaceReviewed']:
        refuse('not_reviewed', 'in-place mutation requires inPlaceReviewed=true after explicit root review (recovery = re-download)')


# ---- steps ----------------------------------------------------------------------------------------------------------------
def step_plan(c, base, w):
    g = {'a1': gate_a1(c, admit=False), **gate_static(c, base)}   # plan admits nothing
    cps, state = head_state(c, base)
    if cps['execution'] < c['N']:
        refuse('below_anchor', f'execution checkpoint {cps["execution"]} is below N: sync forward first (not prepared here)')
    if state < c['N']:
        refuse('state_below_anchor', f'the persisted state/trie frontier {state} (Finish.partial_state_trie) is below N: labels are not state')
    targets = list(range(cps['execution'] - c['unwindChunk'], c['N'], -c['unwindChunk'])) + [c['N']]
    a4 = [['stage', 'drop', '--datadir', c['datadir'], '--config', c['rethConfig'], 'merkle'],
          ['stage', 'run', '--datadir', c['datadir'], '--config', c['rethConfig'], '--from', '0', '--to', str(c['N']), '--commit', '--checkpoints', '--skip-unwind', 'merkle']]
    plan = {'gates': g, 'checkpoints': cps, 'storageV2': g['storageV2'],
            'a3': [['stage', 'unwind', '--datadir', c['datadir'], '--config', c['rethConfig'], 'to-block', str(t)] for t in targets], 'a4': a4,
            'refusedOnV2': list(FORBIDDEN_STAGES_V2) if g['storageV2'] else [],
            'v1Extra': [] if g['storageV2'] else [['stage', 'drop', '--datadir', c['datadir'], 'account-hashing'], ['stage', 'drop', '--datadir', c['datadir'], 'storage-hashing']]}
    if g['storageV2'] is not True:                    # unreachable after gate_static; kept as a second check
        refuse('v1_layout', 'legacy (non-v2) storage: the plain->hashed rebuild path is NOT prepared/tested here; refusing')
    return plan


def step_a2(c, base, w):
    a1 = gate_a1(c)
    gate_static(c, base)                              # pins, receipt, stop, layout BEFORE the header read
    h = read_header(c, base, c['N'])
    auth = authenticate(c, h)
    save(w, 'a2-authenticated.json', {'at': now().isoformat(), 'anchor': auth, 'header': h, 'a1Gate': a1})
    return auth


def step_a3(c, base, w):
    require_reviewed(c)
    auth = load(w, 'a2-authenticated.json')['anchor']
    gate_static(c, base)
    plan = step_plan(c, base, w)
    done = []
    for argv in plan['a3']:
        base.run(*argv, cls='unwind')
        cp = head_checkpoints(c, base)
        done.append({'target': int(argv[-1]), 'checkpoints': cp})
        if cp['execution'] != int(argv[-1]):
            refuse('unwind_short', f'execution checkpoint {cp["execution"]} != unwind target {argv[-1]}')
    cps, state = head_state(c, base)
    if any(v != c['N'] for k, v in cps.items() if k != 'merkle-execute') or cps['merkle-execute'] > c['N'] or state != c['N']:
        refuse('unwind_incomplete', f'stage checkpoints after the unwind are not at N: {cps} (state frontier {state})')
    above = base.run('db', '--datadir', c['datadir'], '--config', c['rethConfig'], 'get', 'static-file', 'headers', str(c['N'] + 1))
    if above.stdout.strip():
        refuse('headers_above_n', 'a header above N survived the unwind')
    if authenticate(c, read_header(c, base, c['N']))['blockHash'] != auth['blockHash']:
        refuse('header_changed', 'header N changed between A2 and A3')
    for label in ('LastFinalizedBlock', 'LastSafeBlock'):
        p = base.run('db', '--datadir', c['datadir'], '--config', c['rethConfig'], 'get', 'mdbx', 'ChainState', label)
        v = re.search(r'(\d+)', p.stdout or '')
        if v and int(v.group(1)) > c['N']:
            refuse('label_above_n', f'{label} {v.group(1)} is above N after the unwind')
    save(w, 'a3-unwound.json', {'at': now().isoformat(), 'steps': done, 'checkpoints': cps})
    return cps


def step_a4(c, base, w):
    require_reviewed(c)
    auth = load(w, 'a2-authenticated.json')['anchor']
    load(w, 'a3-unwound.json')
    plan = step_plan(c, base, w)
    pre, pre_state = head_state(c, base)             # the A3 receipt is not enough: THIS DB must still be unwound to exactly N
    if any(v != c['N'] for k, v in pre.items() if k != 'merkle-execute') or pre_state != c['N']:
        refuse('not_unwound', f'stage checkpoints {pre} are not at N: A4 runs only on the A3-unwound DB')
    for argv in plan['a4']:
        if any(s in argv for s in FORBIDDEN_STAGES_V2):
            refuse('forbidden_stage', f'{argv} would destroy canonical v2 state')
        base.run(*argv, cls='merkle-drop' if argv[1] == 'drop' else 'merkle-run')   # state-root mismatch -> exit 1 -> Refused
    cps = head_checkpoints(c, base)
    if cps['merkle-execute'] != c['N']:
        refuse('merkle_not_at_n', f'merkle-execute checkpoint {cps["merkle-execute"]} != N')
    h = read_header(c, base, c['N'])
    if h['stateRoot'].lower() != auth['stateRoot'] or authenticate(c, h)['blockHash'] != auth['blockHash']:
        refuse('root_mismatch', 'header N / state root differ from the A2-authenticated values')
    save(w, 'a4-rebuilt.json', {'at': now().isoformat(), 'verifiedStateAt': c['N'], 'stateRoot': auth['stateRoot'], 'blockHash': auth['blockHash'],
                                'method': 'full merkle rebuild from canonical v2 hashed state (stage run merkle --from 0 --to N), validate_state_root vs header N'})


# G-a stays OPEN until the prepared checker (bytecode-check/, NOT built) is built, its tests pass and a live run passed under root review.
# Prepared code is not a release gate: removing this entry is a reviewed source change, never a config switch.
OPEN_GAPS = ['bytecodes-content-unverified']
# a2-v2-release-bound (PREPARED; see README.md there). The gap above is closed for ONE database ONLY by bytecode_gap_closed():
# a v2 receipt (below) from the SOURCE-pinned checker, bound to this DB, this A4 result, this download receipt and an unchanged
# mutation journal. The pin is the ACTUAL receipt-v2 release (root-bytecode-v2-release-2303: 1,276,048 bytes, fresh=false, opt 3;
# built from the source that passed 23/23 native tests + 17 exact controls in root-bytecode-v2-recovery-2259; Ubuntu ABI
# launch/refusal smoke root-bytecode-v2-abi-2318 rc 0). PINNING ALONE CLOSES NOTHING: no real database has been scanned; the gap
# closes only for a DB whose real read-only scan at N produced a bound v2 receipt from exactly this binary. The v1 release
# 42d692d4... emits v1 receipts, which are bound as EVIDENCE but never close the gap. v2 digests are framed keccak-256, not sha256.
BYTECODE_CHECKER_V2_SHA256 = 'b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7'
BYTECODE_V1_KEYS = {'format', 'rows', 'tag0', 'tag2', 'tag4', 'nonCanonicalPadding', 'failures', 'paddingShortDupn', 'firstFailures',
                    'accountsWithCode', 'missingCode', 'readError', 'ok'}
BYTECODE_V2_KEYS = BYTECODE_V1_KEYS | {'bytecodesEntries', 'hashedAccountsEntries', 'accountsScanned', 'rowsDigest', 'codeHashesDigest',
                                      'mdbxTxnId', 'checkpoints', 'datadir'}
CHECKPOINT_KEYS = ('headers', 'bodies', 'execution', 'merkle-execute', 'finish')
CHECKER_CAP = 256 << 20


def db_identity(c, base):
    st = os.stat(pathlib.Path(c['datadir'], 'db', 'mdbx.dat'))
    cps = base.db('stage-checkpoints', 'get')
    return {'mdbx': {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns},
            'checkpointsSha256': hashlib.sha256(cps.encode()).hexdigest(), 'headerN': authenticate(c, read_header(c, base, c['N']))['blockHash']}


def _count(r, k):
    v = r.get(k)
    if type(v) is not int or v < 0:
        refuse('checker_receipt', f'{k}={v!r} is not a non-negative integer')
    return v


def check_bytecode_receipt(c, r):
    """-> 'v1' | 'v2'. The checker's own `ok` is never trusted alone: every count is re-derived/cross-checked here."""
    if not isinstance(r, dict) or r.get('format') not in ('base-bytecode-check/v1', 'base-bytecode-check/v2'):
        refuse('checker_receipt', f'unknown receipt format {r.get("format") if isinstance(r, dict) else type(r).__name__}')
    if r.get('ok') is not True or r.get('failures') != 0 or r.get('missingCode') != 0 or not r.get('rows'):
        refuse('bytecodes_failed', f'bytecode check failed: failures={r.get("failures")} missingCode={r.get("missingCode")} rows={r.get("rows")} ok={r.get("ok")}')
    v = 'v2' if r['format'].endswith('/v2') else 'v1'
    if set(r) != (BYTECODE_V2_KEYS if v == 'v2' else BYTECODE_V1_KEYS):
        refuse('checker_receipt', f'receipt keys differ from the {v} schema: {sorted(set(r) ^ (BYTECODE_V2_KEYS if v == "v2" else BYTECODE_V1_KEYS))}')
    rows = _count(r, 'rows')
    if _count(r, 'failures') or _count(r, 'missingCode') or _count(r, 'paddingShortDupn') or r['firstFailures'] != {} or r['readError'] is not None:
        refuse('bytecodes_failed', 'failures/missing code/short DUPN padding/read error present')
    if _count(r, 'tag0') + _count(r, 'tag2') + _count(r, 'tag4') != rows or _count(r, 'nonCanonicalPadding') > r['tag2']:
        refuse('checker_receipt', 'tag counts do not add up to the scanned rows')
    if _count(r, 'accountsWithCode') == 0:
        refuse('checker_receipt', 'no account with code was checked for completeness (empty/unscanned HashedAccounts)')
    if v == 'v2':
        if rows != _count(r, 'bytecodesEntries'):
            refuse('checker_receipt', f'scanned {rows} Bytecodes rows but the table holds {r["bytecodesEntries"]} (same transaction)')
        if _count(r, 'accountsScanned') != _count(r, 'hashedAccountsEntries') or r['accountsWithCode'] > r['accountsScanned']:
            refuse('checker_receipt', 'HashedAccounts scan incomplete (scanned != table entries, or more code accounts than accounts)')
        if not all(re.fullmatch(r'[0-9a-f]{64}', str(r[k])) for k in ('rowsDigest', 'codeHashesDigest')) or _count(r, 'mdbxTxnId') == 0:
            refuse('checker_receipt', 'row/code-hash digests or the MDBX transaction id are missing')
        cp = r['checkpoints']
        if not isinstance(cp, dict) or set(cp) != set(CHECKPOINT_KEYS) or any(type(cp[k]) is not int or cp[k] != c['N'] for k in CHECKPOINT_KEYS):
            refuse('checker_receipt', f'the scan transaction was not at N on every stage checkpoint: {cp}')
        if r['datadir'] != c['datadir']:
            refuse('checker_receipt', 'the receipt names another datadir')
    return v


def journal_digest(w):
    p = w / 'mutation-journal.jsonl'
    b = p.read_bytes() if p.exists() else b''
    return {'records': len(b.splitlines()), 'sha256': hashlib.sha256(b).hexdigest()}


def _trusted_sha(path, what, cap):
    return hashlib.sha256(_read_trusted(path, what, cap)).hexdigest()


def private_checker(c, w):
    """Read the configured checker ONCE, compare with its config pin, and return a private 0500 copy in the 0700 workdir: the
    executed bytes are exactly the hashed bytes (no path re-resolution between the pin check and exec)."""
    b = _read_trusted(c['bytecodeChecker'], 'bytecode checker', CHECKER_CAP)
    sha = hashlib.sha256(b).hexdigest()
    if sha != c['bytecodeCheckerSha256']:
        refuse('checker_pin', 'bytecode checker binary differs from its pin')
    d = w / 'bin'; d.mkdir(mode=0o700, exist_ok=True)
    p = d / f'bytecode-checker-{sha}'
    if not p.exists():
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
        with os.fdopen(fd, 'wb') as f:
            f.write(b)
    if sha256(p) != sha:
        refuse('checker_pin', 'the private checker copy differs from the pinned bytes')
    return p, sha


def step_bytecodes(c, base, w):
    """Run the pinned read-only checker over ALL Bytecodes rows of THIS DB at N with clients stopped; bind the result."""
    a4 = load(w, 'a4-rebuilt.json')
    for k in ('bytecodeChecker', 'bytecodeCheckerSha256'):
        if not c.get(k):
            refuse('no_checker', 'bytecodeChecker/bytecodeCheckerSha256 not configured: the checker is prepared source only (G-a open)')
    exe, csha = private_checker(c, w)
    gate_static(c, base)                                  # units stopped, no openers, receipt, prune config, capability
    j = journal(w)                                        # step order: A4's merkle rebuild must be the LAST mutation of this DB
    if not j or j[-1]['state'] != 'finished' or j[-1].get('rc') != 0 or j[-1]['argv'][2:4] != ['stage', 'run'] or j[-1]['argv'][-1] != 'merkle':
        refuse('bytecode_order', 'the last journaled mutation is not the finished A4 merkle rebuild: the DB may have changed after A4')
    if head_checkpoints(c, base)['execution'] != c['N']:
        refuse('not_at_n', 'the DB is not at N')
    before = db_identity(c, base)
    if before['headerN'] != a4['blockHash']:
        refuse('header_changed', 'header N differs from A4')
    timeout = c['timeouts']['bytecodeSec']
    d = w / 'cmd'; d.mkdir(mode=0o700, exist_ok=True); tag = now().strftime("%Y%m%dT%H%M%S%fZ")
    out_p, err_p = d / f'bytecodes-{tag}.json', d / f'bytecodes-{tag}.err'
    argv = [str(exe), c['datadir']]                       # exact invocation: one positional argument, empty environment
    with open(out_p, 'xb') as o, open(err_p, 'xb') as e:
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=o, stderr=e, env={}, start_new_session=True)
        t0, over = time.monotonic(), False
        while not exited_unreaped(p.pid):
            if time.monotonic() - t0 > timeout or out_p.stat().st_size > (1 << 20) or err_p.stat().st_size > STDERR_CAP:
                over = True; break
            time.sleep(0.05)
        rc, stray = settle_owned(p, over, GRACE_SEC)
        if over or rc is None or stray or out_p.stat().st_size > (1 << 20):
            refuse('bounded', 'bytecode checker exceeded its time/output bound or left group members')
    raw = out_p.read_bytes()
    try:
        r = json.loads(raw)
    except Exception:
        refuse('checker_output', 'checker printed no JSON receipt')
    if rc != 0:
        refuse('bytecodes_failed', f'bytecode check failed: rc={rc} failures={r.get("failures") if isinstance(r, dict) else None} '
               f'missingCode={r.get("missingCode") if isinstance(r, dict) else None}')
    version = check_bytecode_receipt(c, r)
    after = db_identity(c, base)
    if after != before:
        refuse('db_changed', 'the DB changed while the checker ran: the result cannot be bound')
    save(w, 'bytecodes-verified.json', {'at': now().isoformat(), 'identity': before, 'a4Sha256': sha256(w / 'a4-rebuilt.json'),
                                        'checkerSha256': csha, 'argv': ['<checker>', c['datadir']], 'env': {}, 'receiptVersion': version,
                                        'receiptSha256': hashlib.sha256(raw).hexdigest(), 'receiptFile': out_p.name, 'journal': journal_digest(w),
                                        'downloadReceiptSha256': _trusted_sha(c['downloadReceipt'], 'receipt', 1 << 20),
                                        'manifestSha256': MANIFEST_SHA, 'result': r})
    return {k: r[k] for k in ('rows', 'tag2', 'tag4', 'nonCanonicalPadding', 'accountsWithCode')} | {'receiptVersion': version}


def bound_bytecodes(c, base, w):
    """release: the bytecode receipt must still describe THIS DB, THIS A4 result, THIS download receipt and an unchanged journal."""
    bv = load(w, 'bytecodes-verified.json', need=False)
    if bv is None:
        refuse('bytecode_receipt', 'no bound bytecode verification (step bytecodes) for this DB')
    if bv['a4Sha256'] != sha256(w / 'a4-rebuilt.json') or bv['identity'] != db_identity(c, base) or bv.get('journal') != journal_digest(w) \
            or bv.get('downloadReceiptSha256') != _trusted_sha(c['downloadReceipt'], 'receipt', 1 << 20) or bv.get('manifestSha256') != MANIFEST_SHA:
        refuse('bytecode_receipt_stale', 'the bytecode verification was for another DB state, A4 result, download receipt or mutation journal')
    raw = (w / 'cmd' / str(bv.get('receiptFile', ''))).read_bytes() if (w / 'cmd' / str(bv.get('receiptFile', ''))).is_file() else b''
    if hashlib.sha256(raw).hexdigest() != bv.get('receiptSha256') or json.loads(raw) != bv['result']:
        refuse('bytecode_receipt_stale', 'the stored checker receipt differs from the bound one')
    if check_bytecode_receipt(c, bv['result']) != bv.get('receiptVersion'):
        refuse('bytecode_receipt_stale', 'receipt version changed')
    return bv


def bytecode_gap_closed(c, bv):
    """True ONLY for a v2 receipt from the SOURCE-pinned v2 checker (config pin == source pin). Otherwise the gap stays open."""
    return (BYTECODE_CHECKER_V2_SHA256 is not None and bv['checkerSha256'] == BYTECODE_CHECKER_V2_SHA256 == c['bytecodeCheckerSha256']
            and bv['receiptVersion'] == 'v2' and check_bytecode_receipt(c, bv['result']) == 'v2')


def step_release(c, base, w):
    a4 = load(w, 'a4-rebuilt.json')
    a1 = gate_a1(c)                                   # A1 re-run (or original-game recheck) before derivation is allowed
    gate_static(c, base)                              # db_identity below reads the DB
    bind_a1(w, a1)                                    # the SAME initial receipt/N/root/game as A2, not an older L1 block
    bv = bound_bytecodes(c, base, w)
    gaps = [g for g in OPEN_GAPS if not (g == 'bytecodes-content-unverified' and bytecode_gap_closed(c, bv))]
    if gaps:
        refuse('open_gaps', f'derivation stays blocked: {gaps} (a missing client capability, not bypassable by config)')
    save(w, 'm10-launch.json', {'bootstrapAnchor': f'{c["N"]}:{a4["blockHash"]}', 'at': now().isoformat(),
                                'bytecodes': {k: bv[k] for k in ('checkerSha256', 'receiptSha256', 'receiptVersion')},
                                **({'a1Gate': a1} if 'recheckCapture' in a1 else {})})   # the producer re-verifies this capture too


STEPS = {'plan': step_plan, 'a2': step_a2, 'a3': step_a3, 'a4': step_a4, 'bytecodes': step_bytecodes, 'release': step_release}


def main(argv):
    if len(argv) != 3 or argv[1] not in STEPS:
        print(__doc__); return 2
    c = load_config(argv[2]); w = workdir(c); log = []
    rec = {'step': argv[1], 'startedAt': now().isoformat()}
    try:
        journal_guard(w)
        rec['result'] = STEPS[argv[1]](c, Base(c, log, w), w); rec['ok'] = True; code = 0
    except Refused as e:
        rec['ok'] = False; rec['refused'] = str(e); code = 1
    rec['commands'] = log; rec['finishedAt'] = now().isoformat()
    with open(w / f'run-{argv[1]}-{now().strftime("%Y%m%dT%H%M%S%fZ")}.json', 'x') as f:
        json.dump(rec, f, indent=1, default=str)
    print(json.dumps({'step': argv[1], 'ok': rec['ok'], 'refused': rec.get('refused')}))
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv))
