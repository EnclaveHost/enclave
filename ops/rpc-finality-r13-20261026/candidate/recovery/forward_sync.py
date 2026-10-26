#!/usr/bin/env python3
"""forward_sync.py (base-forward-sync-stage; PREPARED; NOT run): CONSUMER-ISOLATED forward sync of an AUTHENTICATED Base snapshot that
lies BELOW the retained finality floor, so that the existing full A2-A4 re-anchor at a fresh A1 anchor N >= floor becomes possible.
It never writes or lowers the floor (watermark), never produces a launch record and never starts production.

The node it runs is the PINNED release binary with exactly the production invocation's flags (chain_service.py `base`), each confirmed
in that binary's own help, but with this route's own datadir identity, own loopback ports (no production port), no tx forwarding, our
own L1 pair (127.0.0.1:18645 / :15052) and peer transport. Its labels are never evidence: what it fetched is proven later, offline,
by the harness (`verify`) and then by the full A2-A4 re-anchor.

  authenticate  root, STOPPED: harness gate_static (units stopped, the completed-download receipt bound to THIS datadir path+dev/ino and
                the pinned manifest/binary, layout, storage v2); every stage checkpoint == SNAPSHOT_HEAD (an untouched download);
                SNAPSHOT_HEAD < the retained floor (else the normal re-anchor applies); the production launch is rolled back; our L1
                beacon still holds the blobs at the snapshot's safe-L1-origin slot (L1 derivation from there needs them)
  run           the enclave-base-forward-sync unit: one node child (service user, scrubbed env, own process group); stops it once
                its finalized label >= floor + margin; a crash is recorded and the unit's retry resumes (reth resumes its DB)
  verify        root, STOPPED: gate_static again, EVERY checkpoint >= floor, the DB header at the floor height hashes to the RETAINED
                floor block, the datadir identity unchanged -> `synced`
  handoff       `synced` and the DB unchanged since -> `handed-off`: the only next step is the existing A2-A4 re-anchor (produce with
                `reanchor`, fresh A1 capture N >= floor - gate_watermark refuses anything below), arm, start
  abandon       -> the datadir renamed to <datadir>.quarantine-sync-<id> (root 0700); the floor is untouched
Journal: <recoveryRoot>/journal.jsonl, canonical hash-chained lines, fsynced, under <recoveryRoot>/sync.lock."""
import datetime, fcntl, hashlib, json, os, pathlib, re, signal, stat, subprocess, sys, time, tomllib, types, urllib.request

FORMAT = 'enclave-base-forward-sync/v1'
NEXT = {None: {'authenticated'}, 'authenticated': {'started', 'abandoned'}, 'started': {'stopped', 'abandoned'},
        'stopped': {'started', 'synced', 'abandoned'}, 'synced': {'handed-off', 'started', 'abandoned'}, 'handed-off': set(), 'abandoned': set()}
# this route's OWN ports (none is a production, readiness, lease or L1 port: chain_service.py base/el/cl, readiness_sampler PORTS)
SYNC_PORTS = {'http': 28545, 'rpc': 29545, 'p2p': 30333, 'discv5': 9201, 'p2pTcp': 9232, 'p2pUdp': 9233}
PRODUCTION_PORTS = {18545, 19545, 30303, 9200, 9222, 9223, 18645, 18651, 15052, 30313, 30314, 9310, 9311}
L1 = ('http://127.0.0.1:18645', 'http://127.0.0.1:15052')        # our own L1 EL + beacon (chain_service.py), never a public RPC
CONFIG_KEYS = {'format', 'recoveryRoot', 'harnessConfig', 'productionLaunchDir', 'watermarkStore', 'serviceUser', 'targetMarginBlocks'}
POLL_SEC, GRACE_SEC = 30, 600
OWNER = 0                                                      # tests override


class Refused(Exception):
    def __init__(self, code, why):
        super().__init__(f'{code}: {why}'); self.code = code


def refuse(code, why):
    raise Refused(code, why)


sha = lambda b: hashlib.sha256(b).hexdigest()
now = lambda: datetime.datetime.now(datetime.timezone.utc)


def read_trusted(p, cap=1 << 20):
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        refuse('untrusted_file', f'{p} cannot be opened ({type(e).__name__})')
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != OWNER or st.st_mode & 0o022:
            refuse('untrusted_file', f'{p} must be a regular file owned by {OWNER}, not group/other writable')
        b = f.read(cap + 1)
    if len(b) > cap:
        refuse('untrusted_file', f'{p} is too large')
    return b


def load_config(path):
    c = json.loads(read_trusted(path))
    if not isinstance(c, dict) or set(c) != CONFIG_KEYS or c['format'] != FORMAT or type(c['targetMarginBlocks']) is not int \
            or not 0 <= c['targetMarginBlocks'] <= 100_000 or not all(str(c[k]).startswith('/') for k in ('recoveryRoot', 'harnessConfig', 'productionLaunchDir', 'watermarkStore')):
        refuse('bad_config', f'the forward-sync config must be exactly {sorted(CONFIG_KEYS)} with absolute paths')
    return c


# ---- journal (append-only, canonical, hash-chained, fsynced; under the route lock) ------------------------------------------
def _line(r):
    return json.dumps(r, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def journal(root):
    p = pathlib.Path(root, 'journal.jsonl')
    if not os.path.lexists(p):
        return []
    b = read_trusted(p, 16 << 20)
    if b and not b.endswith(b'\n'):
        refuse('journal', 'the forward-sync journal ends in an incomplete record (interrupted append): root resolves it')
    out, prev, last = [], None, None
    for i, line in enumerate(b.split(b'\n')[:-1], 1):
        r = json.loads(line)
        if _line(r) != line + b'\n' or r.get('format') != FORMAT or r.get('seq') != i or r.get('prevSha256') != prev or r.get('event') not in NEXT[last]:
            refuse('journal', f'forward-sync journal record {i} breaks the chain or the transitions')
        prev = sha(line + b'\n'); last = r['event']; out.append(r)
    return out


def append(root, js, event, evidence):
    last = js[-1]['event'] if js else None
    if event not in NEXT[last]:
        refuse('transition', f'{last!r} -> {event!r} is not allowed')
    p = pathlib.Path(root, 'journal.jsonl'); raw = p.read_bytes() if p.exists() else b''
    r = {'format': FORMAT, 'seq': len(js) + 1, 'prevSha256': sha(raw.split(b'\n')[-2] + b'\n') if js else None, 'event': event,
         'at': now().isoformat(), 'evidence': evidence}
    fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        if os.fstat(fd).st_size != len(raw):
            refuse('journal', 'the journal changed while the lock was held')
        os.write(fd, _line(r)); os.fsync(fd)
    finally:
        os.close(fd)
    after = journal(root)
    if len(after) != r['seq'] or after[-1] != r:
        refuse('journal', 'the append did not land')
    return after


def locked(root):
    fd = os.open(pathlib.Path(root, 'sync.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd); refuse('busy', 'another forward-sync operation holds the lock')
    return fd


# ---- shared checks (the REAL harness and wrapper functions; no rule re-implemented) ---------------------------------------
def floor_of(W, c, top):
    try:
        es = W.watermark_entries(pathlib.Path(c['watermarkStore']), OWNER, top)
    except AssertionError as e:
        refuse('watermark', str(e))
    if not es:
        refuse('no_floor', 'no retained finality floor: a below-floor recovery is not needed (normal re-anchor)')
    return {'entrySha256': es[-1][0], 'number': es[-1][1]['number'], 'blockHash': es[-1][1]['blockHash'], 'kind': es[-1][1]['kind']}


def production_rolled_back(W, c, top):
    d = pathlib.Path(c['productionLaunchDir'])
    if not os.path.lexists(d / 'launch.json'):
        return {'launch': None}                                  # retired (archived) or never launched
    l_sha = sha(read_trusted(d / 'launch.json', 64 << 20))
    try:
        es = W.journal_entries(d / 'journal', OWNER, l_sha, top)
    except AssertionError as e:
        refuse('production_journal', str(e))
    if es[-1][1]['event'] != 'rolled-back':
        refuse('production_live', f'the production launch is {es[-1][1]["event"]!r}: recovery only after its rollback')
    return {'launch': l_sha, 'rolledBackEntrySha256': es[-1][0]}


def identity(datadir, full=False):
    st = os.stat(pathlib.Path(datadir, 'db', 'mdbx.dat')); dd = os.stat(datadir)
    i = {'datadirDev': dd.st_dev, 'datadirIno': dd.st_ino, 'dev': st.st_dev, 'ino': st.st_ino}
    return dict(i, size=st.st_size, mtimeNs=st.st_mtime_ns) if full else i


STAGES = ('Headers', 'Bodies', 'Execution', 'MerkleExecute', 'Finish')          # pinned reth 7134be3 StageId Display (stages/types/src/id.rs)
CK_ROW = re.compile(r'^(?P<s>[A-Za-z]+): StageCheckpoint \{ block_number: (?P<n>[0-9]+), stage_checkpoint: (?P<d>.*) \}$')
PARTIAL = re.compile(r'FinishCheckpoint \{ partial_state_trie: (?:None|Some\((?P<p>[0-9]+)\)) \}')


def stage_frontier(text):
    """r2: the STOPPED DB's persisted frontiers, from pinned reth 7134be3 semantics (not raw labels alone):
    - `db stage-checkpoints get` (no stage) prints `{StageId}: {StageCheckpoint:?}` for every row of tables::StageCheckpoints
      (cli/commands/src/db/stage_checkpoints.rs:47-51; StageId Display = 'Headers', 'MerkleExecute', ... id.rs:151-162);
    - live-sync persistence (DatabaseProvider::save_blocks, storage/provider/.../provider.rs:836-850) sets EVERY stage of
      StageId::ALL to the persisted tip (update_pipeline_stages, provider.rs:2394-2412) and records a LAGGING state/trie frontier
      only in Finish's FinishCheckpoint.partial_state_trie (stages/types/src/checkpoints.rs:454-457, provider.rs:840-849).
    -> ({stage: block_number}, state_frontier) where state_frontier = Finish.partial_state_trie if recorded, else Finish.block_number."""
    rows = {}
    for line in text.splitlines():
        m = CK_ROW.match(line.strip())
        if m and m['s'] in STAGES:
            if m['s'] in rows:
                refuse('unparsed', f'duplicate stage checkpoint row {m["s"]}')
            rows[m['s']] = (int(m['n']), m['d'])
    if set(rows) != set(STAGES):
        refuse('unparsed', f'stage checkpoints lack {sorted(set(STAGES) - set(rows))} (pinned `db stage-checkpoints get` format)')
    fin_n, fin_d = rows['Finish']
    if fin_d == 'None':
        state = fin_n
    else:
        p = PARTIAL.search(fin_d)
        if not p or 'Finish' not in fin_d:
            refuse('unparsed', f'unexpected Finish stage_checkpoint {fin_d[:160]!r}')
        state = int(p['p']) if p['p'] is not None else fin_n
    if state > fin_n:
        refuse('unparsed', f'state frontier {state} above the Finish checkpoint {fin_n}')
    return {k: n for k, (n, _d) in rows.items()}, state


def read_stage_text(base):
    return base.db('stage-checkpoints', 'get')                  # the harness's gated, pinned-binary DB read (after gate_static)


def stopped_db(A, hc):
    base = A.Base(hc, [], pathlib.Path(hc['workdir'])); A.gate_static(hc, base)
    cps, state = stage_frontier(read_stage_text(base))
    return base, cps, state


def authenticate(cfg_path, *, A, W, top='/'):
    c = load_config(cfg_path); root = pathlib.Path(c['recoveryRoot']); fd = locked(root)
    try:
        js = journal(root)
        if js:
            refuse('transition', 'this recovery root is already authenticated (abandon it to start over)')
        hc = A.load_config(c['harnessConfig']); floor = floor_of(W, c, top); prod = production_rolled_back(W, c, top)
        try:
            _base, cps, state = stopped_db(A, hc)
        except A.Refused as e:
            refuse('snapshot_auth', str(e))
        if set(cps.values()) != {A.SNAPSHOT_HEAD} or state != A.SNAPSHOT_HEAD:
            refuse('not_snapshot', f'stage checkpoints {cps} are not all the pinned snapshot head {A.SNAPSHOT_HEAD}: not an untouched download')
        if not A.SNAPSHOT_HEAD < floor['number']:
            refuse('not_below_floor', f'the snapshot head {A.SNAPSHOT_HEAD} is not below the floor {floor["number"]}: use the normal re-anchor')
        origin = W.coverage_activation(W.CONFIG, W.ROOT / 'manifest.json', (W.MANIFEST.get('binaries') or {}).get('base'))
        slot = str(origin['blobSlot'])
        retained = retention(W, int(slot))
        return append(root, js, 'authenticated', {'datadir': hc['datadir'], 'identity': identity(hc['datadir']), 'checkpoints': cps,
                      'floor': floor, 'production': prod, 'snapshotHead': A.SNAPSHOT_HEAD, 'blobSlot': slot, 'retained': retained, 'manifestSha256': A.MANIFEST_SHA})[-1]
    finally:
        os.close(fd)


def lighthouse_db_info():
    """the FULL /lighthouse/database/info document from our own beacon (the wrapper's beacon() returns ['data'], which this
    Lighthouse-specific endpoint does not have: top-level schema_version/config/split/anchor/data_info, observed live 2026-10-26)"""
    with urllib.request.urlopen(L1[1].rstrip('/') + '/lighthouse/database/info', timeout=10) as r:
        return json.loads(r.read(1 << 20))


def retention(W, need_slot):
    """r2: AVAILABILITY of the retained range, from our OWN Lighthouse (authoritative; /lighthouse/database/info, v8.3.2):
    blocks and blob/column data are held contiguously from anchor.oldest_block_slot / data_info.oldest_data_slot to the head, so the
    coverage need_from slot (`coverage_activation(...)['blobSlot']`, the activation evidence) must be >= both. This proves the beacon
    can SERVE the range now; the per-block KZG/commitment verdict is the separate pinned coverage verdict that coverage_activation
    already requires (coverageVerified + acceptance hashes). A slot without blobs (zero commitments) or without a block is legitimate
    and is not probed here."""
    try:
        info = lighthouse_db_info()
        oldest_block, oldest_data = int(info['anchor']['oldest_block_slot']), int(info['data_info']['oldest_data_slot'])
    except Exception as e:
        refuse('blob_history_unknown', f'our L1 beacon did not report its retained range ({type(e).__name__})')
    if oldest_block > need_slot or oldest_data > need_slot:
        refuse('blob_history_missing', f'our L1 beacon retains blocks from slot {oldest_block} and blob data from {oldest_data}, after the '
               f'coverage need_from slot {need_slot}: L1 derivation from the snapshot cannot be served (restore history first)')
    return {'needFromSlot': need_slot, 'oldestBlockSlot': oldest_block, 'oldestDataSlot': oldest_data}


# ---- the isolated node ---------------------------------------------------------------------------------------------------------
def node_argv(exe, datadir, prune):
    """EXACTLY the production base invocation's flags (chain_service.py _start, side base) minus tx forwarding and proof serving,
    with this route's datadir and ports; HTTP is loopback `eth` only (progress)."""
    p = SYNC_PORTS
    return [exe, '--chain', 'mainnet', 'rpc', '--datadir', str(datadir),
            '--http', '--http.addr', '127.0.0.1', '--http.port', str(p['http']), '--http.api', 'eth',
            '--txpool.disable-transactions-backup', *prune, '--rpc.max-connections', '8', '--ipcdisable',
            '--addr', '0.0.0.0', '--port', str(p['p2p']), '--discovery.addr', '0.0.0.0', '--discovery.port', str(p['p2p']),
            '--discovery.v5.addr', '0.0.0.0', '--discovery.v5.port', str(p['discv5']),
            '--rpc.addr', '127.0.0.1', '--rpc.port', str(p['rpc']), '--p2p.listen.ip', '0.0.0.0',
            '--p2p.listen.tcp', str(p['p2pTcp']), '--p2p.listen.udp', str(p['p2pUdp']),
            '--l1-eth-rpc', L1[0], '--l1-beacon', L1[1], '--l1.rpc-timeout-ms', '10000', '--upgrade-signal.mode', 'metrics-only']


def capability(exe_path, fds, argv):
    """every flag this route passes appears in the PINNED binary's own help (global + `rpc`): no invented flag runs"""
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    tok = lambda a: set(re.findall(r'(?<![\w-])--[a-z0-9][a-z0-9.-]*', subprocess.run([exe_path, *a], capture_output=True, text=True, timeout=60, env=env, pass_fds=fds).stdout))
    g, r = tok(['--help']), tok(['rpc', '--help'])                  # r2: EXACT tokens, per position (global before `rpc`, rpc after)
    if 'rpc' not in argv:
        refuse('capability', 'the node argv has no `rpc` subcommand')
    i = argv.index('rpc')
    missing = sorted({x for x in argv[1:i] if x.startswith('--') and x not in g} | {x for x in argv[i + 1:] if x.startswith('--') and x not in r})
    if missing:
        refuse('capability', f'the pinned base binary help lacks {missing}: this route never runs an unknown flag')


def holders(datadir, proc='/proc'):
    root, out = os.path.realpath(datadir), []
    for p in pathlib.Path(proc).iterdir():
        if p.name.isdigit() and int(p.name) != os.getpid():
            try:
                if any(os.path.realpath(os.readlink(f)).startswith(root + '/') for f in (p / 'fd').iterdir()):
                    out.append(int(p.name))
            except OSError:
                pass
    return out


def _start_time(pid):
    try:
        return pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def finalized(port):
    q = urllib.request.Request(f'http://127.0.0.1:{port}/', data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockByNumber',
                               'params': ['finalized', False]}).encode(), headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(q, timeout=10) as r:
            b = json.loads(r.read(1 << 20)).get('result') or {}
        return int(b['number'], 16)
    except Exception:
        return None


def stop_group(p, grace=GRACE_SEC):
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        return p.wait(grace)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); return p.wait(60)


def run(cfg_path, *, A, W, top='/', user=True, poll=POLL_SEC):
    c = load_config(cfg_path); root = pathlib.Path(c['recoveryRoot']); fd = locked(root)
    try:
        js = journal(root)
        if js and js[-1]['event'] == 'started':                   # the unit's previous child died with it: record, then resume
            ev = js[-1]['evidence']
            if _start_time(ev['pid']) == ev['startTime']:
                refuse('running', f'the forward-sync node {ev["pid"]} still runs')
            js = append(root, js, 'stopped', {'reason': 'crashed-or-killed', 'pid': ev['pid']})
        if not js or js[-1]['event'] not in ('authenticated', 'stopped', 'synced'):
            refuse('transition', f'run needs an authenticated recovery root (state {js[-1]["event"] if js else None!r})')
        auth = js[0]['evidence']; dd = auth['datadir']; floor = floor_of(W, c, top); production_rolled_back(W, c, top)   # r2: re-checked
        if identity(dd) != auth['identity']:
            refuse('datadir_changed', 'the datadir is not the authenticated one (dev/ino)')
        if floor['entrySha256'] != auth['floor']['entrySha256'] and floor['number'] < auth['floor']['number']:
            refuse('watermark', 'the retained floor moved backward')
        if holders(dd):
            refuse('datadir_busy', f'processes {holders(dd)} hold files under {dd}')
        if set(SYNC_PORTS.values()) & PRODUCTION_PORTS:
            refuse('ports', 'a forward-sync port is a production port')
        rel = pathlib.Path(W.BASE_RELEASE_PATH); efd = os.open(rel, os.O_RDONLY | os.O_CLOEXEC)
        try:
            h = hashlib.sha256()
            while (b := os.read(efd, 1 << 20)):
                h.update(b)
            if h.hexdigest() != W.BASE_RELEASE_SHA256:
                refuse('release_pin', f'{rel} is not the pinned base release')
            exe = f'/proc/self/fd/{efd}'
            prune = W.prune_args(tomllib.loads(pathlib.Path(dd, 'reth.toml').read_text()), W.history_from_block(W.CONFIG), W.state_history_from_block(W.CONFIG))
            argv = node_argv(exe, dd, prune); capability(exe, (efd,), argv)
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': dd, 'TMPDIR': str(root / 'tmp'), 'BASE_NODE_L1_TRUST_RPC': 'false'}
            (root / 'tmp').mkdir(mode=0o700, exist_ok=True); (root / 'logs').mkdir(mode=0o755, exist_ok=True)
            tag = now().strftime('%Y%m%dT%H%M%SZ') + '-' + os.urandom(16).hex(); kw = {}
            if user:
                import pwd
                pw = pwd.getpwnam(c['serviceUser']); kw = {'user': pw.pw_uid, 'group': pw.pw_gid, 'extra_groups': []}
                os.chown(root / 'tmp', pw.pw_uid, pw.pw_gid)
            with open(root / 'logs' / f'node-{tag}.out', 'xb') as o, open(root / 'logs' / f'node-{tag}.err', 'xb') as e:
                p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=o, stderr=e, env=env, pass_fds=(efd,), start_new_session=True, **kw)
        finally:
            os.close(efd)
        js = append(root, journal(root), 'started', {'pid': p.pid, 'startTime': _start_time(p.pid), 'argvSha256': sha(json.dumps(argv[1:]).encode()),
                    'releaseSha256': W.BASE_RELEASE_SHA256, 'ports': SYNC_PORTS, 'target': floor['number'] + c['targetMarginBlocks']})
        target, stop = floor['number'] + c['targetMarginBlocks'], {}
        signal.signal(signal.SIGTERM, lambda *_a: stop.setdefault('reason', 'signal'))
        while True:
            if p.poll() is not None:
                append(root, journal(root), 'stopped', {'reason': 'exited', 'rc': p.returncode}); return 1
            n = finalized(SYNC_PORTS['http'])
            if stop or (n is not None and n >= target):
                rc = stop_group(p)
                append(root, journal(root), 'stopped', {'reason': stop.get('reason', 'target'), 'finalizedLabel': n, 'rc': rc})
                return 0 if not stop else 1
            time.sleep(poll)
    finally:
        os.close(fd)


def verify(cfg_path, *, A, W, top='/'):
    c = load_config(cfg_path); root = pathlib.Path(c['recoveryRoot']); fd = locked(root)
    try:
        js = journal(root)
        if not js or js[-1]['event'] != 'stopped':
            refuse('transition', 'verify needs a stopped forward-sync node')
        auth = js[0]['evidence']; hc = A.load_config(c['harnessConfig']); floor = floor_of(W, c, top); production_rolled_back(W, c, top)   # r2
        if hc['datadir'] != auth['datadir'] or identity(hc['datadir']) != auth['identity']:
            refuse('datadir_changed', 'the datadir is not the authenticated one')
        before = identity(hc['datadir'], full=True)
        try:
            base, cps, state = stopped_db(A, hc)
            if any(type(v) is not int or v < floor['number'] for v in cps.values()):
                refuse('below_floor', f'stage checkpoints {cps} are still below the retained floor {floor["number"]}: run again')
            if state < floor['number']:
                refuse('state_below_floor', f'the persisted state/trie frontier {state} (Finish.partial_state_trie) is below the floor {floor["number"]}: run again')
            got = A.header_hash(hc, A.read_header(hc, base, floor['number']))
        except A.Refused as e:
            refuse('stopped_db', str(e))
        if got != floor['blockHash']:
            refuse('floor_conflict', f'the synced DB holds another block at the floor {floor["number"]}: another chain; abandon')
        if identity(hc['datadir'], full=True) != before:
            refuse('datadir_changed', 'the DB changed during the checks (not stopped)')
        return append(root, js, 'synced', {'floor': floor, 'checkpoints': cps, 'stateFrontier': state, 'mdbx': before})[-1]
    finally:
        os.close(fd)


def handoff(cfg_path, *, A, W, top='/'):
    c = load_config(cfg_path); root = pathlib.Path(c['recoveryRoot']); fd = locked(root)
    try:
        js = journal(root)
        if not js or js[-1]['event'] != 'synced':
            refuse('transition', 'handoff needs `synced`')
        ev = js[-1]['evidence']; dd = js[0]['evidence']['datadir']
        if identity(dd, full=True) != ev['mdbx']:
            refuse('datadir_changed', 'the DB changed since verify: verify again')
        if floor_of(W, c, top)['number'] < ev['floor']['number']:
            refuse('watermark', 'the retained floor moved backward')
        production_rolled_back(W, c, top)
        return append(root, js, 'handed-off', {'datadir': dd, 'floor': ev['floor'], 'next': 'A2-A4 re-anchor (produce with reanchor, fresh A1 '
                      f'capture at N >= {ev["floor"]["number"]}), arm, start: the only path to production'})[-1]
    finally:
        os.close(fd)


def abandon(cfg_path, *, A, W, top='/'):
    c = load_config(cfg_path); root = pathlib.Path(c['recoveryRoot']); fd = locked(root)
    try:
        js = journal(root)
        if js and js[-1]['event'] in ('handed-off', 'abandoned'):
            refuse('transition', f'state {js[-1]["event"]!r}')
        if js and js[-1]['event'] == 'started' and _start_time(js[-1]['evidence']['pid']) == js[-1]['evidence']['startTime']:
            refuse('running', 'stop the forward-sync unit first')
        dd = pathlib.Path(js[0]['evidence']['datadir']) if js else pathlib.Path(A.load_config(c['harnessConfig'])['datadir'])
        dst = dd.with_name(f'{dd.name}.quarantine-sync-{now().strftime("%Y%m%dT%H%M%SZ")}')
        if holders(dd) or os.path.lexists(dst):
            refuse('datadir_busy', f'{dd} is in use or {dst} exists')
        os.rename(dd, dst); os.chmod(dst, 0o700)
        if js and js[-1]['event'] == 'started':
            js = append(root, js, 'stopped', {'reason': 'abandon after a crash'})
        return append(root, js, 'abandoned', {'quarantined': str(dst)})[-1] if js else {'quarantined': str(dst)}
    finally:
        os.close(fd)


# ---- CLI: pinned closures executed from verified bytes (as the r6 producer) -----------------------------------------------
WRAPPER = (pathlib.Path('/opt/enclave-rpc/chain_service.py'), '6a4d7aa5da385bf1d8dea74c37060eb1332d5d468625d54ae02ae878c7135189')
HARNESS = (pathlib.Path('/opt/enclave-rpc/a2a4-recovery/a2a4.py'), '27ecfb40044025709ed8f7645724082c1580b36e5fac988826aa826fb2f4814e')
SELECTION_SHA256 = 'e6c312f4007f6d747197a6569eaeb36c8c949a0819be49738ce6a0723b999532'


def _exec_pinned(name, path, pin):
    b = read_trusted(path, 8 << 20)
    if sha(b) != pin:
        refuse('source_pin', f'{path} is not the reviewed {pin[:12]}...')
    m = types.ModuleType(name); m.__file__ = str(path); sys.modules[name] = m
    exec(compile(b, str(path), 'exec'), m.__dict__)
    return m


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    ops = {'authenticate': authenticate, 'run': run, 'verify': verify, 'handoff': handoff, 'abandon': abandon}
    if len(argv) != 3 or argv[1] not in ops:
        print(__doc__); return 2
    try:
        W = _exec_pinned('chain_service', *WRAPPER)
        _exec_pinned('selection', HARNESS[0].parent / 'selection.py', SELECTION_SHA256)
        A = _exec_pinned('a2a4_recovery', *HARNESS)
        r = ops[argv[1]](argv[2], A=A, W=W)
    except (Refused, OSError, KeyError, ValueError) as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(json.dumps({'ok': True, 'result': r}, default=str)); return 0 if not isinstance(r, int) else r


if __name__ == '__main__':
    sys.exit(main(sys.argv))
