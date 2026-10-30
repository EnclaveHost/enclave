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

Pinned-source semantics (base v1.5.1 -> base-reth 2.5.2 7134be3; see PROCEDURE.md for file:line):
  - `base reth stage unwind --datadir D --config F to-block T`  (non-offline: truncates headers/bodies/static files and lowers
    ChainState finalized/safe; Distance guard only; commits per stage step: NO rollback)
  - v2 storage (HashedAccounts/HashedStorages ARE canonical state): hashing stages are no-ops/destructive -> refused here;
    the state commitment is checked by `stage drop merkle` + `stage run merkle --from 0 --to N --commit --skip-unwind`
    (from==0 -> full rebuild; validate_state_root against header N; mismatch -> exit 1)
  - `db get` exits 0 with EMPTY output on a missing key -> every read here requires non-empty, parsed output.
"""
import datetime, hashlib, json, os, pathlib, re, shutil, signal, subprocess, sys, time, types
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
        'depsRoot', 'node', 'minFreeBytes', 'backup', 'bytecodeChecker', 'bytecodeCheckerSha256'}


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


def checkpoint_block(text, stage):
    """`stage-checkpoints get` prints Rust Debug 'stage: Some(StageCheckpoint { block_number: N, .. })'."""
    m = re.search(rf'^{re.escape(stage)}:\s*.*?block_number:\s*(\d+)', text, re.M)
    if not m:
        refuse('unparsed', f'no checkpoint for {stage}')
    return int(m.group(1))


# ---- gates ----------------------------------------------------------------------------------------------------------------
def gate_a1(c):
    """A fresh A1 run (file written <= a1MaxAgeSec ago), the mainnet pins, and the planned N/output root/game."""
    e = json.loads(pathlib.Path(c['a1Evidence']).read_text())
    at = datetime.datetime.fromisoformat(e['at'].replace('Z', '+00:00'))
    age = (now() - at).total_seconds()
    if age < 0 or age > c['a1MaxAgeSec']:
        refuse('a1_stale', f'A1 evidence is {int(age)} s old (max {c["a1MaxAgeSec"]}): re-run A1 now; an existing file is not accepted')
    if e.get('verdict') != 'A1-authenticated':
        refuse('a1_verdict', f'A1 verdict {e.get("verdict")}')
    if e.get('asr', '').lower() != MAINNET['asr'] or e.get('respectedGameType') != MAINNET['respectedGameType']:
        refuse('a1_pins', 'ASR or respected game type is not the pinned mainnet value')
    for addr, ch in MAINNET['codeHashes'].items():
        if (e.get('pins', {}).get(addr, {}).get('codeHash', '').lower()) != ch:
            refuse('a1_pins', f'code hash of {addr} differs from the pin')
    if str(e.get('N')).isdigit() and int(e['N']) > c['N']:
        refuse('a1_anchor_advanced', f'the ASR anchor advanced to {e["N"]} (> N): the current A1 tool re-checks only the LATEST anchor, so it cannot '
               f're-confirm game {c["game"]} now; needs the game-specific re-check (G-h) - never re-anchor or accept descendants silently')
    if str(e.get('N')) != str(c['N']) or e.get('outputRoot', '').lower() != c['outputRoot'] or e.get('game', '').lower() != c['game']:
        refuse('a1_anchor', 'A1 anchor (N/outputRoot/game) differs from the planned one')
    reads = e.get('reads', {})
    for k in ('anchorRoot', 'anchorGame', 'isGameFinalized', 'isGameBlacklisted', 'isGameRetired', 'gameStatus', 'gameRootClaim'):
        if reads.get(k) not in ('helios-call', 'mpt-proof'):
            refuse('a1_unproven', f'A1 read {k} is not proof-verified')
    if int(e.get('l1', {}).get('ageSec', 10**9)) > 1800:
        refuse('a1_l1_stale', 'A1 L1 finalized header was older than 1800 s')
    return {'a1At': e['at'], 'a1AgeSec': int(age), 'l1Finalized': e['l1']['number']}


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
    _root_owned(rp, 'receipt'); r = json.loads(pathlib.Path(rp).read_text())
    want = {'format': 'base-snapshot-completion-receipt/v1', 'manifestSha256': MANIFEST_SHA, 'block': SNAPSHOT_HEAD, 'chainId': 8453,
            'storageVersion': 2, 'unit': SNAPSHOT_UNIT, 'unitResult': 'success', 'execMainStatus': 0, 'datadir': c['datadir']}
    for k, v in want.items():
        if r.get(k) != v:
            refuse('receipt_fields', f'receipt {k}={r.get(k)!r}, expected {v!r}')
    _root_owned(c['manifestPath'], 'manifest')
    if sha256(c['manifestPath']) != MANIFEST_SHA:
        refuse('manifest_pin', 'the pinned manifest bytes differ')
    m = json.loads(pathlib.Path(c['manifestPath']).read_text())
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
    t = base.db('stage-checkpoints', 'get')
    return {s: checkpoint_block(t, s) for s in ('headers', 'bodies', 'execution', 'merkle-execute', 'finish')}


def require_reviewed(c):
    if not c['inPlaceReviewed']:
        refuse('not_reviewed', 'in-place mutation requires inPlaceReviewed=true after explicit root review (recovery = re-download)')


# ---- steps ----------------------------------------------------------------------------------------------------------------
def step_plan(c, base, w):
    g = {'a1': gate_a1(c), **gate_static(c, base)}
    cps = head_checkpoints(c, base)
    if cps['execution'] < c['N']:
        refuse('below_anchor', f'execution checkpoint {cps["execution"]} is below N: sync forward first (not prepared here)')
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
    gate_a1(c)
    gate_static(c, base)                              # pins, receipt, stop, layout BEFORE the header read
    h = read_header(c, base, c['N'])
    auth = authenticate(c, h)
    save(w, 'a2-authenticated.json', {'at': now().isoformat(), 'anchor': auth, 'header': h})
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
    cps = head_checkpoints(c, base)
    if any(v != c['N'] for k, v in cps.items() if k != 'merkle-execute') or cps['merkle-execute'] > c['N']:
        refuse('unwind_incomplete', f'stage checkpoints after the unwind are not at N: {cps}')
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
    pre = head_checkpoints(c, base)                  # the A3 receipt is not enough: THIS DB must still be unwound to exactly N
    if any(v != c['N'] for k, v in pre.items() if k != 'merkle-execute'):
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


def db_identity(c, base):
    st = os.stat(pathlib.Path(c['datadir'], 'db', 'mdbx.dat'))
    cps = base.db('stage-checkpoints', 'get')
    return {'mdbx': {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns},
            'checkpointsSha256': hashlib.sha256(cps.encode()).hexdigest(), 'headerN': authenticate(c, read_header(c, base, c['N']))['blockHash']}


def step_bytecodes(c, base, w):
    """Run the pinned read-only checker over ALL Bytecodes rows of THIS DB at N with clients stopped; bind the result."""
    a4 = load(w, 'a4-rebuilt.json')
    for k in ('bytecodeChecker', 'bytecodeCheckerSha256'):
        if not c.get(k):
            refuse('no_checker', 'bytecodeChecker/bytecodeCheckerSha256 not configured: the checker is prepared source only (G-a open)')
    if sha256(c['bytecodeChecker']) != c['bytecodeCheckerSha256']:
        refuse('checker_pin', 'bytecode checker binary differs from its pin')
    gate_static(c, base)                                  # units stopped, receipt, prune config, capability
    if head_checkpoints(c, base)['execution'] != c['N']:
        refuse('not_at_n', 'the DB is not at N')
    before = db_identity(c, base)
    if before['headerN'] != a4['blockHash']:
        refuse('header_changed', 'header N differs from A4')
    timeout = c['timeouts']['bytecodeSec']
    d = w / 'cmd'; d.mkdir(mode=0o700, exist_ok=True); out_p = d / f'bytecodes-{now().strftime("%Y%m%dT%H%M%S%fZ")}.json'
    with open(out_p, 'xb') as o:
        p = subprocess.Popen([c['bytecodeChecker'], c['datadir']], stdin=subprocess.DEVNULL, stdout=o, stderr=subprocess.DEVNULL, start_new_session=True)
        t0, over = time.monotonic(), False
        while not exited_unreaped(p.pid):
            if time.monotonic() - t0 > timeout or out_p.stat().st_size > (1 << 20):
                over = True; break
            time.sleep(0.05)
        rc, stray = settle_owned(p, over, GRACE_SEC)
        if over or rc is None or stray or out_p.stat().st_size > (1 << 20):
            refuse('bounded', 'bytecode checker exceeded its time/output bound or left group members')
    try:
        r = json.loads(out_p.read_text())
    except Exception:
        refuse('checker_output', 'checker printed no JSON receipt')
    if rc != 0 or r.get('format') != 'base-bytecode-check/v1' or r.get('ok') is not True or r.get('failures') != 0 or r.get('missingCode') != 0 or not r.get('rows'):
        refuse('bytecodes_failed', f'bytecode check failed: rc={rc} failures={r.get("failures")} missingCode={r.get("missingCode")}')
    after = db_identity(c, base)
    if after != before:
        refuse('db_changed', 'the DB changed while the checker ran: the result cannot be bound')
    save(w, 'bytecodes-verified.json', {'at': now().isoformat(), 'identity': before, 'a4Sha256': sha256(w / 'a4-rebuilt.json'),
                                        'checkerSha256': c['bytecodeCheckerSha256'], 'result': r})
    return {k: r[k] for k in ('rows', 'tag2', 'tag4', 'nonCanonicalPadding', 'accountsWithCode')}


def step_release(c, base, w):
    a4 = load(w, 'a4-rebuilt.json')
    gate_a1(c)                                        # A1 re-run before derivation is allowed
    gate_static(c, base)                              # db_identity below reads the DB
    bv = load(w, 'bytecodes-verified.json', need=False)
    if bv is None:
        refuse('bytecode_receipt', 'no bound bytecode verification (step bytecodes) for this DB')
    if bv['a4Sha256'] != sha256(w / 'a4-rebuilt.json') or bv['identity'] != db_identity(c, base):
        refuse('bytecode_receipt_stale', 'the bytecode verification was for another DB state or another A4 result')
    if OPEN_GAPS:
        refuse('open_gaps', f'derivation stays blocked: {OPEN_GAPS} (a missing client capability, not bypassable by config)')
    save(w, 'm10-launch.json', {'bootstrapAnchor': f'{c["N"]}:{a4["blockHash"]}', 'at': now().isoformat()})


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
