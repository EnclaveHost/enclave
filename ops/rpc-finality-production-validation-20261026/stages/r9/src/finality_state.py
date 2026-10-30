#!/usr/bin/env python3
"""finality_state.py: ROOT-ONLY qualification of POST-ANCHOR finality of the launched Base chain (base-finality-proof-stage/r5,
PREPARED; NOT run). It never edits the launcher; the launcher's reviewed writer (base_launch.record_finality) consumes `status`.

Inputs, each with its provenance (nothing here is a config-supplied claim):
  launch record  <launch-dir>/launch.json, sha == chain.json baseBootstrap.anchorLaunch {launchSha256} (root's pin): original N,
                 anchor hash, original A1 output root/game/L1 block, release binary sha, datadir, mdbx dev/ino
  launch journal the wrapper's own verified journal (W.journal_entries, under W.launch_lock): last event `consumed` or
                 `bootstrapped` (a started launch; r4)
  fresh A1       r4: ONLY the recovery harness's reviewed capture path (the pinned harness, executing the pinned capture r4
                 module - HOLD while the harness's A1_CAPTURE_REVIEWED is False): an `initial` capture of the newer game plus a
                 `recheck-capture` of exactly it, through the harness's OWN capture_binding / pinned A1 gate / gate_a1 rules
                 (age, mainnet ASR/type/code hashes, L1 age consistency), then admitted ONCE into the SHARED A1 admission ledger
                 (the wrapper's A1_ADMISSION_LEDGER, the one re-anchor admissions use): a capture serves one finality proof OR
                 one re-anchor step, never both and never twice. `check` admits into a private copy (nothing durable). The
                 old live-1958/run.py output-directory path is removed. Like the harness, this tool cannot re-verify Helios.
  our chain      JSON-RPC of the node process BOUND by /proc: the only listener of the loopback RPC port, executing the release
                 binary (sha), holding the launch record's mdbx.dat (dev/ino) open; identical before and after the reads
  the decision   src/finality-core.mjs (pinned): header N' reproduces the fresh A1 root, ancestry N'..N links, N is the launch
                 anchor and reproduces the ORIGINAL root, every earlier qualified point is on the path (vendor functions reused).
                 r4: the core, vendor module AND the @noble/hashes tree are checked against their pins and executed only from a
                 private copy of exactly the checked bytes; the process and launch identity are re-bound right before any append.

State: <finality-dir>/NNNNNN.json, a hash-chained append-only journal (the wrapper's format discipline), one launch per dir:
  (none)|qualified -> qualified    a strictly newer N' AND a strictly newer L1 block AND an unused receipt (no replay)
  (none)|qualified -> contradicted TERMINAL: authenticated values and our bound node disagree (fork, DB swap, broken ancestry)
  (none)|qualified -> revoked      TERMINAL: root reason (e.g. the launch was rolled back)
A qualification is CURRENT only for the process and launch-journal head it was recorded with (`status`): a restart or a rearm
makes it stale until a new fresh proof re-walks N'' -> N through every earlier qualified point.
Commands (root only):  check | record | status | revoke   (record: HOLD while FINALITY_PROTOTYPE_REVIEWED is False)
"""
import base64, datetime, fcntl, hashlib, json, os, pathlib, re, shutil, stat, subprocess, sys, tempfile, types, urllib.parse

FINALITY_PROTOTYPE_REVIEWED = False          # source constant: `record` refuses until root reviews this prototype
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


OWNER = 0                                    # every trusted file/dir must be owned by this uid (tests override)
HERE = pathlib.Path(__file__).resolve().parent.parent
CORE_PINS = {'src/finality-core.mjs': '686cbc22cd837dbc0bb79512105972297c5addbe512dbd6dce2cfac28aaa6eab', 'vendor/anchor-bootstrap.mjs': '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8'}
A1_GATE_PINS = {'a1-gate.mjs': '06cc29612d1d380e91c932dc13ed676e153c8aab368103eac673c4004409414c',      # harness A1_GATE_PINS
                'a1-recheck.mjs': 'f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8',
                'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d'}
# r4: fresh A1 provenance = the recovery harness (base-reanchor-recovery-stage/r7, root 0345) and its pinned capture module.
HARNESS_SHA256 = '2efc6d66687afd31cff62e23aab705ed4df611c18df64c5afa740e12e8d3eb25'   # base-finality-proof-stage/r9/harness/a2a4.py (pinned parser + closure capture pin)
HARNESS_SOURCE = pathlib.Path('/opt/enclave-rpc/a2a4-recovery/a2a4.py')      # == base_launch.RECOVERY_A2A4_SOURCE (HOLD: not installed)
FRESH_A1_MAX_AGE_SEC = 600                    # the recheck capture's age bound (the harness's a1MaxAgeSec for this use)
NOBLE_VERSION = '1.8.0'
SELECTION_SHA256 = 'e6c312f4007f6d747197a6569eaeb36c8c949a0819be49738ce6a0723b999532'   # harness/selection.py (r7 = a2-v2 stage)
WRAPPER_SHA256 = '4fc3b970e4ec062eeb66ef90c5bd1b14149a9bdcff135e7720708e7c544df8ae'   # base-finality-proof-stage/r6/wrapper/chain_service.py
WRAPPER_SOURCE = pathlib.Path('/opt/enclave-rpc/chain_service.py')
A1_APPEND_MAX_AGE_SEC = 1800                  # r6: the recheck capture's age bound AT APPEND, after the (possibly long) core proof
NOBLE_TREE_SHA256 = 'e17fdd7c4fcb8a440e3b53c35017e5c1cc0d72d5c86170c21b2dc6a006ee5ff8'   # every file of node_modules/@noble/hashes (tree_sha256)
FORMAT = 'enclave-base-finality/v1'
NEXT = {None: {'qualified', 'contradicted', 'revoked'}, 'qualified': {'qualified', 'contradicted', 'revoked'}, 'contradicted': set(), 'revoked': set()}
ENTRY, PARTIAL = re.compile(r'[0-9]{6}\.json'), re.compile(r'\.partial-[0-9]+')
H32, CAP = re.compile(r'0x[0-9a-f]{64}'), 1 << 20


class Refused(Exception):
    def __init__(self, code, why, contradiction=False):
        super().__init__(f'{code}: {why}'); self.code, self.contradiction = code, contradiction


def refuse(code, why):
    raise Refused(code, why)


sha = lambda b: hashlib.sha256(b).hexdigest()
_clock = lambda: datetime.datetime.now(datetime.timezone.utc)      # the real clock for the at-append freshness check (tests patch it)
try:
    SELF_SHA256 = sha(pathlib.Path(__file__).read_bytes())         # the bytes this module was executed from (loaders verify them first)
except (OSError, NameError):
    SELF_SHA256 = None


def _utc(s, what):
    try:
        t = datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError:
        t = None
    if t is None or t.tzinfo is None:
        refuse('time', f'{what} {s!r} is not an ISO UTC time')
    return t


def secure_dir(p, top):
    """every component from `top` down: real (no symlink), owned by OWNER, not group/other writable; the leaf a directory"""
    top, p = pathlib.Path(top), pathlib.Path(p)
    if not (p.is_absolute() and '..' not in p.parts and (p == top or top in p.parents)):
        refuse('path', f'{p} is not a plain path under {top}')
    cur = top
    for part in [None] + list(p.relative_to(top).parts):
        cur = cur / part if part else cur
        try:
            st = os.lstat(cur)
        except OSError as e:
            refuse('path', f'{cur} is missing or unreadable ({type(e).__name__})')
        if stat.S_ISLNK(st.st_mode) or st.st_uid != OWNER or st.st_mode & 0o022:
            refuse('path', f'{cur} is a symlink, not owned by {OWNER}, or group/other writable')
    if not stat.S_ISDIR(st.st_mode):
        refuse('path', f'{p} is not a directory')


def read_trusted(p, cap=CAP):
    """exact bytes, read ONCE from the OPEN file: regular, owner OWNER, not group/other writable, no final symlink, <= cap"""
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        refuse('untrusted_file', f'{pathlib.Path(p).name} cannot be opened as a regular non-symlink file ({type(e).__name__})')
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != OWNER or st.st_mode & 0o022:
            refuse('untrusted_file', f'{pathlib.Path(p).name} must be a regular file owned by {OWNER}, not group/other writable')
        b = f.read(cap + 1)
    if len(b) > cap:
        refuse('untrusted_file', f'{pathlib.Path(p).name} exceeds {cap} bytes')
    return b


def jload(b, what):
    try:
        v = json.loads(b)
    except ValueError:
        refuse('bad_json', f'{what} is not JSON')
    if not isinstance(v, dict):
        refuse('bad_json', f'{what} is not an object')
    return v


# ---- the launch (root's pin) and the wrapper's journal -------------------------------------------------------------------
def load_launch(d, chain_json, top):
    d = pathlib.Path(d); secure_dir(d, top)
    pin = (jload(read_trusted(chain_json), 'chain.json').get('baseBootstrap') or {}).get('anchorLaunch')
    if not isinstance(pin, dict) or set(pin) != {'launchSha256'} or not re.fullmatch(r'[0-9a-f]{64}', str(pin.get('launchSha256'))):
        refuse('no_launch_pin', 'chain.json has no baseBootstrap.anchorLaunch {launchSha256}: nothing was launched under a pin')
    lb = read_trusted(d / 'launch.json', 64 << 20)
    if sha(lb) != pin['launchSha256']:
        refuse('launch_pin', 'launch.json bytes differ from root\'s chain.json pin')
    L = jload(lb, 'launch.json')
    m = re.fullmatch(r'([1-9][0-9]{0,18}):(0x[0-9a-f]{64})', str(L.get('anchor', '')))
    b = L.get('bindings') or {}; a1 = b.get('a1') or {}; mdbx = (b.get('dbIdentity') or {}).get('mdbx') or {}
    if L.get('format') != 'enclave-base-bootstrap-launch/v1' or not m or not H32.fullmatch(str(a1.get('outputRoot', ''))) \
            or str(a1.get('N')) != m.group(1) or not isinstance(a1.get('l1Finalized'), int) or not re.fullmatch(r'0x[0-9a-f]{40}', str(a1.get('game', ''))) \
            or not re.fullmatch(r'[0-9a-f]{64}', str(L.get('baseReleaseSha256', ''))) or not isinstance(b.get('datadir'), str) \
            or not all(isinstance(mdbx.get(k), int) for k in ('dev', 'ino')):
        refuse('launch_record', 'launch.json lacks the anchor, the A1 binding, the release sha, the datadir or the mdbx identity')
    return {'dir': d, 'launchSha256': pin['launchSha256'], 'N': int(m.group(1)), 'blockHash': m.group(2), 'outputRoot': a1['outputRoot'],
            'game': a1['game'], 'l1Finalized': a1['l1Finalized'], 'releaseSha256': L['baseReleaseSha256'], 'datadir': b['datadir'],
            'mdbx': {'dev': mdbx['dev'], 'ino': mdbx['ino']}}


STARTED = ('consumed', 'bootstrapped', 'restarted')       # r5: a running launch (restart-permitted = stopped, waiting)


def launch_journal(launch, W, top):
    try:
        return W.journal_entries(launch['dir'] / 'journal', OWNER, launch['launchSha256'], top)
    except AssertionError as e:
        refuse('launch_journal', str(e))


def launch_head(launch, W, top, entries=None):
    """the wrapper's verified journal; qualification needs a STARTED launch (consumed | bootstrapped | restarted)"""
    entries = entries or launch_journal(launch, W, top)
    e_sha, e = entries[-1]
    if e['event'] == 'rolled-back':
        refuse('rolled_back', 'the launch was rolled back: nothing is qualified for it')
    if e['event'] == 'finality-terminal':
        refuse('terminal', 'the launch journal records this launch\'s finality as contradicted or revoked (terminal)')
    if e['event'] not in STARTED:
        refuse('not_started', f'the launch journal is {e["event"]!r}: no start consumed this launch record')
    return {'seq': e['seq'], 'entrySha256': e_sha}


# ---- the fresh A1 receipt: reviewed producer, provenance, pinned gate, harness rules -------------------------------------
def _exec_pinned(name, b, path):
    m = types.ModuleType(name); m.__file__ = str(path); sys.modules[name] = m
    exec(compile(b, str(path), 'exec'), m.__dict__)
    return m


def load_harness(path=HARNESS_SOURCE, pin=HARNESS_SHA256):
    """r6: the recovery harness AND its selection.py, each exactly its pinned bytes read ONCE (root-owned, no symlink) and executed
    from those bytes - no import by path, no .pyc: the harness's `import selection` resolves to the verified module object."""
    p = pathlib.Path(path); b = read_trusted(p, 8 << 20); sb = read_trusted(p.parent / 'selection.py', 8 << 20)
    if sha(b) != pin or sha(sb) != SELECTION_SHA256:
        refuse('harness_pin', f'{p} (or its selection.py) is not the reviewed recovery harness {pin[:12]}...')
    _exec_pinned('selection', sb, p.parent / 'selection.py')
    return _exec_pinned('a2a4_finality', b, p)


def load_wrapper(path=WRAPPER_SOURCE, pin=WRAPPER_SHA256):
    """r6: the installed wrapper (journal, lock, watermark rules) exactly its pinned bytes, executed from them."""
    p = pathlib.Path(path); b = read_trusted(p, 8 << 20)
    if sha(b) != pin:
        refuse('wrapper_pin', f'{p} is not the reviewed r6 wrapper {pin[:12]}...')
    return _exec_pinned('chain_service', b, p)


def harness_identity(R):
    """The harness module in use (and the selection module it imported) must be the pinned bytes and gate the same pinned A1 gate
    files as this tool's a1gate/."""
    got = sha(read_trusted(R.__file__, 8 << 20)); sel = getattr(R, 'SEL', None)
    if got != HARNESS_SHA256 or R.A1_GATE_PINS != A1_GATE_PINS or sel is None or sha(read_trusted(sel.__file__, 8 << 20)) != SELECTION_SHA256:
        refuse('harness_pin', 'the harness in use is not the pinned recovery harness (or its selection module, or other A1 gate bytes)')
    if getattr(R, 'A1_ADMISSION_LEDGER', None) is None:
        refuse('harness_pin', 'the harness enforces no shared A1 admission ledger path')
    return got


def node_fd(R, node):
    """r6: the node binary is a REVIEWED build (the capture module's pins), hashed from an open fd; every finality decision runs it as
    /proc/self/fd/N passed to the child, so the bytes hashed are the bytes executed (no path swap). -> (fd, sha256)"""
    try:                                          # r6.2: the reviewed set FIRST (nothing opened yet); a harness refusal keeps its code
        accepted = R.accepted_nodes()
    except R.Refused as e:
        refuse(str(e).split(':', 1)[0], str(e))
    try:
        fd = os.open(node, os.O_RDONLY | os.O_CLOEXEC)
    except OSError as e:
        refuse('node_pin', f'{node} cannot be opened ({type(e).__name__})')
    h = hashlib.sha256()
    while (c := os.read(fd, 1 << 20)):
        h.update(c)
    if h.hexdigest() not in accepted:
        os.close(fd); refuse('node_pin', f'{node} is not a reviewed node binary ({h.hexdigest()[:12]}...)')
    return fd, h.hexdigest()


def fresh_a1(R, capture, *, ledger, node, workdir, write, rules, node_fds=()):
    """-> the normalized fresh A1, through the HARNESS's own capture path (no rule re-implemented here):
    capture_binding (both captures verified by the pinned capture module; the recheck is of exactly the initial) -> the pinned
    A1 gate -> `rules` (post-anchor + replay, BEFORE anything is admitted) -> gate_a1 over exactly that anchor, which re-checks
    everything and admits the recheck AND the initial capture ONCE into the shared ledger (the harness refuses any other ledger
    path before reading or writing it). write=False (`check`): gate_a1(admit=False) applies the same replay rule in memory."""
    if not isinstance(capture, dict) or set(capture) != {'initialOut', 'recheckOut'}:
        refuse('a1_capture', 'the fresh A1 is named only as {initialOut, recheckOut} capture outputs')
    if pathlib.Path(ledger) != R.A1_ADMISSION_LEDGER:
        refuse('a1_ledger_path', 'the wrapper and the harness name different shared A1 admission ledgers')
    w = pathlib.Path(tempfile.mkdtemp(prefix='a1cap-', dir=workdir))
    try:
        c = {'workdir': str(w / 'work'), 'node': node, 'nodePassFds': tuple(node_fds), 'a1GateDir': str(HERE / 'a1gate'), 'a1MaxAgeSec': FRESH_A1_MAX_AGE_SEC,
             'a1Mode': 'capture-recheck', 'reanchor': {'a1Capture': {'initialOut': str(capture['initialOut']), 'recheckOut': str(capture['recheckOut'])},
                                                      'admissionLedger': str(ledger)}}
        os.mkdir(c['workdir'], 0o700)                      # no a2-authenticated.json: the initial capture is verified now
        try:
            bound, sr, ini, rk = R.capture_binding(c)
            s = R.a1_node_gate(c, {'mode': 'original-game-recheck', 'initial': base64.b64encode(ini).decode(), 'initialSha256': sha(ini),
                                   'recheck': base64.b64encode(rk).decode()})
            rules({'N': int(s['N']), 'game': s['game'], 'l1': {'number': s['l1']['number']},
                   'captures': sorted([bound['captureSha256'], sr['captureSha256']])})
            g = R.gate_a1(dict(c, N=int(s['N']), outputRoot=s['outputRoot'], game=s['game']), at_a2=True, admit=write)
        except R.Refused as e:
            refuse(str(e).split(':', 1)[0], str(e))
    finally:
        shutil.rmtree(w, ignore_errors=True)
    ic, rc = g['initialCapture'], g['recheckCapture']
    return {'N': int(g['N']), 'outputRoot': g['outputRoot'], 'game': g['game'], 'l1': {'number': g['l1Finalized'], 'hash': g['l1Hash']},
            'at': g['a1At'], 'initialCapture': {k: ic[k] for k in ('captureId', 'captureSha256', 'evidenceSha256')}, 'recheckCapture': rc,
            'captures': sorted([ic['captureSha256'], rc['captureSha256']]), 'admitted': 'shared-ledger' if write else 'checked-only'}


def post_anchor_rules(a1, launch, prior):
    if a1['N'] <= launch['N']:
        refuse('not_post_anchor', f'the fresh anchor {a1["N"]} is not above the launch anchor {launch["N"]}')
    if a1['game'] == launch['game']:
        refuse('same_game', 'the fresh receipt names the launch game itself: no newer anchor exists yet')
    if a1['l1']['number'] <= launch['l1Finalized']:
        refuse('stale_l1', 'the fresh receipt is not at a newer L1 block than the launch A1')
    for e in prior:
        q = e['evidence']
        if set(q['a1']['captures']) & set(a1['captures']):
            refuse('replayed', 'this A1 capture was already used for finality')
        if a1['N'] <= q['fresh']['N'] or a1['l1']['number'] <= q['a1']['l1']['number']:
            refuse('not_newer', 'the fresh anchor or its L1 block is not newer than an earlier qualification')


# ---- the node process that answers the RPC, bound by /proc --------------------------------------------------------------
def bind_process(rpc_url, launch, proc='/proc'):
    u = urllib.parse.urlsplit(rpc_url)
    if u.scheme != 'http' or u.hostname != '127.0.0.1' or not u.port or u.username or u.query or u.fragment:
        refuse('rpc_url', 'the node RPC must be plain http://127.0.0.1:<port>/ (loopback, bound below)')
    inodes = set()
    for tbl in ('net/tcp', 'net/tcp6'):
        try:
            rows = pathlib.Path(proc, tbl).read_text().splitlines()[1:]
        except FileNotFoundError:
            continue
        for row in rows:
            f = row.split()
            if len(f) > 9 and f[3] == '0A' and int(f[1].rsplit(':', 1)[1], 16) == u.port:
                inodes.add(f[9])                          # every listener on the port, ANY local address
    owners = {}
    for pd in pathlib.Path(proc).iterdir():
        if pd.name.isdigit():
            try:
                links = {os.readlink(x) for x in (pd / 'fd').iterdir()}
            except OSError:
                continue
            for i in inodes:
                if f'socket:[{i}]' in links:
                    owners.setdefault(i, set()).add(pd.name)
    pids = set().union(*owners.values()) if owners else set()
    # r6: EVERY listening socket on the port is owned, all by ONE process (an unscanned owner or a second listener refuses)
    if not inodes or set(owners) != inodes or len(pids) != 1:
        refuse('process_binding', f'port {u.port}: {len(inodes)} listening socket(s), {len(owners)} with a found owner, {len(pids)} owning '
               'process(es); one process owning every listener is required')
    pd = pathlib.Path(proc, pids.pop())
    with open(pd / 'exe', 'rb') as f:
        exe = hashlib.file_digest(f, 'sha256').hexdigest()
    if exe != launch['releaseSha256']:
        refuse('process_binary', 'the RPC is served by a process that is not the launched release binary')
    start = (pd / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    held = False
    for x in (pd / 'fd').iterdir():
        try:
            st = os.stat(x)
        except OSError:
            continue
        held = held or (st.st_dev, st.st_ino) == (launch['mdbx']['dev'], launch['mdbx']['ino'])
    st = os.stat(pathlib.Path(launch['datadir'], 'db', 'mdbx.dat'))
    if not held or (st.st_dev, st.st_ino) != (launch['mdbx']['dev'], launch['mdbx']['ino']):
        refuse('process_db', 'the serving process does not hold the launch record\'s mdbx.dat (dev/ino): another DB')
    return {'pid': int(pd.name), 'startTime': start, 'exeSha256': exe, 'mdbx': launch['mdbx']}


# ---- the decision (pinned JS core over the bound node) ------------------------------------------------------------------
def tree_sha256(root):
    """sha256 over sorted 'relpath\\0sha256(file)' rows of every file; any symlink or non-regular entry refuses"""
    rows = []
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = pathlib.Path(dp, n); st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                refuse('deps', f'{p} is a symlink or not a regular file')
            if stat.S_ISREG(st.st_mode):
                rows.append(f'{p.relative_to(root).as_posix()}\0{sha(p.read_bytes())}')
    return sha('\n'.join(sorted(rows)).encode())


def run_core(launch, a1, prior, rpc_url, node, deps_root, workdir, chunk=512, node_fds=()):
    d = pathlib.Path(tempfile.mkdtemp(prefix='finality-', dir=workdir))
    try:
        for rel, want in CORE_PINS.items():
            b = (HERE / rel).read_bytes()
            if want is not None and sha(b) != want:
                refuse('core_pin', f'{rel} differs from its pin')
            (d / rel).parent.mkdir(parents=True, exist_ok=True); (d / rel).write_bytes(b)
        script = (
            "const fs=await import('node:fs');const c=await import(process.env.C);const k=await import(process.env.K);"
            "const i=JSON.parse(fs.readFileSync(0,'utf8'));let id=0;"
            "const l2=async(method,params)=>{const r=await fetch(i.url,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',"
            "signal:AbortSignal.timeout(20000),body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});"
            "if(!r.ok)throw new Error('HTTP '+r.status);const t=await r.text();if(t.length>(1<<20))throw new Error('reply too large');"
            "const j=JSON.parse(t);if(j.jsonrpc!=='2.0'||j.id!==id||(('result' in j)===('error' in j)))throw new Error('bad envelope');"
            "if('error' in j)throw new Error('rpc error '+JSON.stringify(j.error).slice(0,120));return j.result};"
            "try{console.log(JSON.stringify({ok:true,r:await c.qualify(i.args,{l2},{keccak:(b)=>k.keccak_256(b),chunk:i.chunk})}))}"
            "catch(e){console.log(JSON.stringify({ok:false,kind:e.kind||'error',code:e.code||'error',error:String(e.message||e).slice(0,300)}));process.exit(3)}")
        args = {'original': {'N': launch['N'], 'blockHash': launch['blockHash'], 'outputRoot': launch['outputRoot']},
                'fresh': {'N': a1['N'], 'outputRoot': a1['outputRoot']},
                'prior': [{'N': e['evidence']['fresh']['N'], 'blockHash': e['evidence']['fresh']['blockHash']} for e in prior]}
        noble = d / 'noble'
        shutil.copytree(pathlib.Path(deps_root, 'node_modules/@noble/hashes'), noble, symlinks=True)
        if tree_sha256(noble) != NOBLE_TREE_SHA256 or json.loads((noble / 'package.json').read_bytes()).get('version') != NOBLE_VERSION:
            refuse('deps', f'@noble/hashes is not the pinned {NOBLE_VERSION} tree {NOBLE_TREE_SHA256[:12]}...')
        p = subprocess.run([node, '--input-type=module', '-e', script], input=json.dumps({'args': args, 'url': rpc_url, 'chunk': chunk}),
                           capture_output=True, text=True, timeout=3600, pass_fds=tuple(node_fds),
                           env={'C': (d / 'src/finality-core.mjs').as_uri(), 'K': (noble / 'sha3.js').as_uri(), 'PATH': '/usr/bin:/bin'})
    finally:
        shutil.rmtree(d, ignore_errors=True)
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        refuse('core_tool', f'the finality core produced no verdict: {p.stderr[-300:]}')
    if r.get('ok') is True and p.returncode == 0 and r['r'].get('verdict') == 'post-anchor-finality-qualified':
        return r['r']
    if r.get('kind') == 'contradiction':
        raise Refused(r.get('code'), r.get('error'), contradiction=True)
    refuse(r.get('code') or 'core', r.get('error') or 'no verdict')


# ---- the finality journal (append-only, hash-chained, durable) ----------------------------------------------------------
def entries(fd_dir, launch_sha, top):
    secure_dir(fd_dir, top)
    out, prev, last = [], None, None
    for name in sorted(os.listdir(fd_dir)):
        if PARTIAL.fullmatch(name):
            continue
        if not (ENTRY.fullmatch(name) and int(name[:6]) == len(out) + 1):
            refuse('finality_journal', f'unexpected entry {name}')
        b = read_trusted(pathlib.Path(fd_dir, name)); e = jload(b, name)
        if e.get('format') != FORMAT or e.get('launchSha256') != launch_sha or e.get('seq') != len(out) + 1 or e.get('prevSha256') != prev \
                or e.get('event') not in NEXT[last]:
            refuse('finality_journal', f'chain broken or transition not allowed at {name}')
        out.append({'sha': sha(b), **e}); prev, last = sha(b), e['event']
    return out


def append(fd_dir, launch_sha, cur, event, evidence, now, top):
    last = cur[-1]['event'] if cur else None
    if event not in NEXT[last]:
        refuse('transition', f'{last!r} -> {event!r} is not allowed')
    doc = {'format': FORMAT, 'launchSha256': launch_sha, 'seq': len(cur) + 1, 'prevSha256': cur[-1]['sha'] if cur else None,
           'event': event, 'at': now.isoformat(), 'evidence': evidence}
    b = json.dumps(doc, indent=1, sort_keys=True).encode()
    for n in os.listdir(fd_dir):
        if PARTIAL.fullmatch(n):
            os.unlink(pathlib.Path(fd_dir, n))           # an interrupted earlier append (we hold the lock)
    tmp = pathlib.Path(fd_dir, f'.partial-{os.getpid()}')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        v = memoryview(b)
        while v:
            v = v[os.write(fd, v):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.link(tmp, pathlib.Path(fd_dir, f'{len(cur) + 1:06d}.json'))   # never replaces an entry
    os.unlink(tmp)
    dfd = os.open(fd_dir, os.O_RDONLY | os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
    after = entries(fd_dir, launch_sha, top)
    if len(after) != len(cur) + 1 or after[-1]['sha'] != sha(b):
        refuse('finality_journal', 'the append did not land as written')
    return after


# ---- operations (all under the ONE launch lock: no rearm/rollback/start interleaves) -------------------------------------
TERMINAL = ('contradicted', 'revoked')


def finality_dir_of(launch, fdir):
    """r6: a launch's finality journal lives ONLY at <launch-dir>/finality (never an operator-chosen, possibly empty, directory)"""
    want = launch['dir'] / 'finality'
    if pathlib.Path(fdir) != want:
        refuse('finality_dir', f'the finality journal of this launch lives only at {want}')
    return want


def anchored(cur, js):
    """r6: the launch journal (root, hash-chained, wrapper format) is the DURABLE authority for this launch's finality journal: each
    `bootstrapped` event names the qualified entry it recorded and `finality-terminal` names the terminal one ({finalitySeq,
    finalityEntrySha256}). The finality directory must hold exactly those entries: an empty, other, restored or truncated finality
    journal refuses, so a contradicted/revoked state is never revived. -> True when the launch journal records it terminal."""
    by_seq, terminal = {e['seq']: e['sha'] for e in cur}, False
    for _sha, e in js:
        if e.get('event') in ('bootstrapped', 'finality-terminal'):
            ev = e.get('evidence') or {}
            if by_seq.get(ev.get('finalitySeq')) != ev.get('finalityEntrySha256'):
                refuse('finality_journal_rolled_back', f'the launch journal names finality entry {ev.get("finalitySeq")} that this finality '
                       'journal does not hold: an empty, other, restored or truncated finality journal is never accepted')
            terminal = terminal or e['event'] == 'finality-terminal'
    return terminal


def anchor_terminal(launch, W, entry, now, top):
    """(the caller holds the launch lock) record the terminal finality entry in the launch journal; idempotent; a rolled-back launch
    is already terminal. Also repairs a crash between the finality append and this one."""
    js = launch_journal(launch, W, top); state = js[-1][1]['event']
    if state in ('rolled-back', 'finality-terminal'):
        return
    try:
        W.journal_append(launch['dir'] / 'journal', OWNER, launch['launchSha256'], js, 'finality-terminal',
                         {'finalitySeq': entry['seq'], 'finalityEntrySha256': entry['sha'], 'event': entry['event']}, now.isoformat(), top)
    except AssertionError as e:
        refuse('launch_journal', str(e))


def qualify(d, chain_json, fdir, capture, rpc_url, *, W, R, node, deps_root, workdir, write, now=None, top='/', proc='/proc', chunk=512):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if write and not reviewed('FINALITY_PROTOTYPE_REVIEWED'):                 # no write of ANY kind (qualified or contradicted) until reviewed
        refuse('hold_prototype', 'HOLD: FINALITY_PROTOTYPE_REVIEWED is False; use `check` (verifies, records nothing)')
    launch = load_launch(d, chain_json, top)
    try:
        lock = W.launch_lock(launch['dir'], OWNER, top)
    except AssertionError as e:
        refuse('lock', str(e))
    try:
        fdir = finality_dir_of(launch, fdir)
        js = launch_journal(launch, W, top)
        cur = entries(fdir, launch['launchSha256'], top)
        if anchored(cur, js):
            refuse('terminal', 'the launch journal records this launch\'s finality as contradicted or revoked (terminal)')
        if cur and not NEXT[cur[-1]['event']]:
            anchor_terminal(launch, W, cur[-1], now, top)                     # a crash between the two appends: record it now
            refuse('terminal', f'the finality journal is {cur[-1]["event"]!r} (terminal)')
        head = launch_head(launch, W, top, js)
        prior = [e for e in cur if e['event'] == 'qualified']
        harness = harness_identity(R)
        ledger = getattr(W, 'A1_ADMISSION_LEDGER', None)
        if ledger is None:
            refuse('a1_ledger', 'the wrapper names no shared A1 admission ledger (A1_ADMISSION_LEDGER)')
        nfd, node_sha = node_fd(R, node); nodep = f'/proc/self/fd/{nfd}'
        try:
            a1 = fresh_a1(R, capture, ledger=ledger, node=nodep, node_fds=(nfd,), workdir=workdir, write=write,
                          rules=lambda x: post_anchor_rules(x, launch, prior))
            post_anchor_rules(a1, launch, prior)
            p1 = bind_process(rpc_url, launch, proc)
            try:
                v = run_core(launch, a1, prior, rpc_url, nodep, deps_root, workdir, chunk, node_fds=(nfd,))
            except Refused as e:
                if e.contradiction and write:
                    p2 = bind_process(rpc_url, launch, proc)
                    if p2 == p1:                          # only a contradiction from the SAME bound process is recorded
                        after = append(fdir, launch['launchSha256'], cur, 'contradicted', {'code': e.code, 'detail': str(e)[:500], 'a1': a1,
                                       'process': p1, 'launchJournal': head}, now, top)
                        anchor_terminal(launch, W, after[-1], now, top)
                raise
        finally:
            os.close(nfd)
        if bind_process(rpc_url, launch, proc) != p1:
            refuse('process_changed', 'the node process changed during the proof (restart): nothing is qualified')
        if launch_head(launch, W, top) != head or load_launch(d, chain_json, top)['launchSha256'] != launch['launchSha256']:
            refuse('launch_changed', 'the launch record or its journal changed during the proof: nothing is qualified')
        age = (_clock() - _utc(a1['recheckCapture']['finishedAt'], 'recheck capture finishedAt')).total_seconds()
        if age < 0 or age > A1_APPEND_MAX_AGE_SEC:                      # r6: freshness AT APPEND, after the expensive proof
            refuse('a1_stale_at_append', f'the fresh A1 recheck capture is {int(age)} s old at append (max {A1_APPEND_MAX_AGE_SEC}): '
                   'capture a new pair; nothing is qualified')
        evidence = {'original': v['original'], 'fresh': v['fresh'], 'span': v['span'], 'priorChecked': v['priorChecked'], 'a1': a1,
                    'process': p1, 'launchJournal': head,
                    'code': {**dict(CORE_PINS), **{f'a1gate/{k}': w for k, w in A1_GATE_PINS.items()},     # = the bytes verified and executed
                             'finality_state.py': SELF_SHA256, 'harness': harness, 'selection.py': SELECTION_SHA256, 'noble': NOBLE_TREE_SHA256,
                             'node': node_sha}}
        if write:
            after = append(fdir, launch['launchSha256'], cur, 'qualified', evidence, now, top)
            return {'event': 'qualified', 'seq': after[-1]['seq'], 'entrySha256': after[-1]['sha'], **evidence}
        return {'event': None, 'checked': True, **evidence}
    finally:
        os.close(lock)


def status(d, chain_json, fdir, rpc_url, *, W, top='/', proc='/proc'):
    """CURRENT only if the last entry is `qualified` for THIS launch-journal head and THIS running process (no restart since)"""
    launch = load_launch(d, chain_json, top)
    fdir = finality_dir_of(launch, fdir)
    cur = entries(fdir, launch['launchSha256'], top)
    try:
        if anchored(cur, launch_journal(launch, W, top)):
            return {'state': 'terminal', 'qualified': False}
    except Refused as e:
        return {'state': 'refused', 'qualified': False, 'refused': str(e)}
    if not cur:
        return {'state': 'none', 'qualified': False}
    last = cur[-1]
    if last['event'] != 'qualified':
        return {'state': last['event'], 'qualified': False, 'seq': last['seq']}
    try:
        js = launch_journal(launch, W, top); head, p = launch_head(launch, W, top, js), bind_process(rpc_url, launch, proc)
    except Refused as e:
        return {'state': 'unbound', 'qualified': False, 'refused': str(e)}
    rec, recorded = last['evidence']['launchJournal'], None
    if head != rec:
        # r5: the ONLY accepted change since the proof: exactly ONE following journal entry, `bootstrapped`, naming THIS qualified
        # entry (the launcher recording this very proof). Any other entry (permit, restart, rearm, a second record) is stale.
        nxt = js[rec['seq']:] if 0 < rec['seq'] <= len(js) and js[rec['seq'] - 1][0] == rec['entrySha256'] else None
        if not (nxt and len(nxt) == 1 and nxt[0][1]['event'] == 'bootstrapped'
                and (nxt[0][1].get('evidence') or {}).get('finalityEntrySha256') == last['sha']):
            return {'state': 'stale-launch-changed', 'qualified': False}
        recorded = nxt[0][0]
    if p != last['evidence']['process']:
        return {'state': 'stale-after-restart', 'qualified': False}
    return {'state': 'qualified', 'qualified': True, 'freshN': last['evidence']['fresh']['N'], 'freshBlockHash': last['evidence']['fresh']['blockHash'],
            'entrySha256': last['sha'], 'at': last['at'], 'launchSha256': launch['launchSha256'], 'process': p, 'recordedAs': recorded}


STATUS_FORMAT = 'enclave-base-finality-status/v1'


def publish_status(s, out, now=None, top='/'):
    """r5: the root-published status the readiness sampler's post-anchor-finality gate reads (root-owned 0644, atomic replace)."""
    now = now or datetime.datetime.now(datetime.timezone.utc); out = pathlib.Path(out)
    secure_dir(out.parent, top)
    b = json.dumps({'format': STATUS_FORMAT, 'publishedAt': now.isoformat(), **s}, sort_keys=True, indent=1).encode()
    tmp = out.with_name(f'.{out.name}.partial-{os.getpid()}')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        v = memoryview(b)
        while v:
            v = v[os.write(fd, v):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, out)
    dfd = os.open(out.parent, os.O_RDONLY | os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
    return {'published': str(out), 'sha256': sha(b), 'state': s.get('state')}


def revoke(d, chain_json, fdir, reason, *, W, now=None, top='/'):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if not (isinstance(reason, str) and 0 < len(reason) <= 500):
        refuse('evidence', 'revoke needs a short root reason')
    launch = load_launch(d, chain_json, top)
    try:
        lock = W.launch_lock(launch['dir'], OWNER, top)
    except AssertionError as e:
        refuse('lock', str(e))
    try:
        fdir = finality_dir_of(launch, fdir)
        cur = entries(fdir, launch['launchSha256'], top)
        anchored(cur, launch_journal(launch, W, top))
        after = append(fdir, launch['launchSha256'], cur, 'revoked', {'reason': reason}, now, top)
        anchor_terminal(launch, W, after[-1], now, top)
        return {'event': 'revoked', 'seq': after[-1]['seq']}
    finally:
        os.close(lock)


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    usage = ('check|record <launch-dir> <chain.json> <finality-dir> <initial-capture-out> <recheck-capture-out> <rpc-url>; status <launch-dir> <chain.json> <finality-dir> <rpc-url>; status-publish <launch-dir> <chain.json> <finality-dir> <rpc-url> <out.json>; '
             'revoke <launch-dir> <chain.json> <finality-dir> <reason>.  env: FINALITY_NODE, FINALITY_DEPS_ROOT, FINALITY_WORKDIR (root-owned 0700)')
    try:
        W = load_wrapper()                                            # the INSTALLED wrapper, exactly its pinned bytes
        cmd = argv[1]
        if cmd in ('check', 'record') and len(argv) == 8:
            node, deps, wd = os.environ['FINALITY_NODE'], os.environ['FINALITY_DEPS_ROOT'], os.environ['FINALITY_WORKDIR']
            secure_dir(wd, '/')
            r = qualify(argv[2], argv[3], argv[4], {'initialOut': argv[5], 'recheckOut': argv[6]}, argv[7], W=W, R=load_harness(), node=node,
                        deps_root=deps, workdir=wd, write=cmd == 'record')
        elif cmd == 'status' and len(argv) == 6:
            r = status(argv[2], argv[3], argv[4], argv[5], W=W)
        elif cmd == 'status-publish' and len(argv) == 7:              # root timer: the readiness gate reads this file
            r = publish_status(status(argv[2], argv[3], argv[4], argv[5], W=W), argv[6])
        elif cmd == 'revoke' and len(argv) == 6:
            r = revoke(argv[2], argv[3], argv[4], argv[5], W=W)
        else:
            print(usage); return 2
    except Refused as e:
        print(json.dumps({'ok': False, 'refused': str(e), 'contradiction': e.contradiction})); return 1
    except (OSError, KeyError, IndexError) as e:
        print(json.dumps({'ok': False, 'refused': f'{type(e).__name__}: {e}'})); return 1
    print(json.dumps({'ok': True, **r}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
