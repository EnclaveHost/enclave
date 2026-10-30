#!/usr/bin/env python3
"""finality_state.py: ROOT-ONLY qualification of POST-ANCHOR finality of the launched Base chain (base-finality-proof-stage,
PREPARED; NOT run). Separate prototype: it never edits the launcher; its optional wiring is integration/*.patch.

Inputs, each with its provenance (nothing here is a config-supplied claim):
  launch record  <launch-dir>/launch.json, sha == chain.json baseBootstrap.anchorLaunch {launchSha256} (root's pin): original N,
                 anchor hash, original A1 output root/game/L1 block, release binary sha, datadir, mdbx dev/ino
  launch journal the wrapper's own verified journal (W.journal_entries, under W.launch_lock): last event must be `consumed`
  fresh A1       ONE output directory of the REVIEWED producer live-1958/run.py (its own sha pinned) - a1-evidence.json,
                 run-result.json, a1-config.json, run.py, all root-owned - with the run record's inputPins, Helios binary,
                 exit 0, Helios stopped, the receipt time inside the run window; then the PINNED A1 gate (a1gate/, fresh-initial)
                 and the harness's gate_a1 rules (age, mainnet ASR/type/code hashes, L1 age consistency). Like the harness, this
                 tool cannot re-verify Helios: the receipt is a trusted ROOT-PRODUCED record of the reviewed runner.
  our chain      JSON-RPC of the node process BOUND by /proc: the only listener of the loopback RPC port, executing the release
                 binary (sha), holding the launch record's mdbx.dat (dev/ino) open; identical before and after the reads
  the decision   src/finality-core.mjs (pinned): header N' reproduces the fresh A1 root, ancestry N'..N links, N is the launch
                 anchor and reproduces the ORIGINAL root, every earlier qualified point is on the path (vendor functions reused)

State: <finality-dir>/NNNNNN.json, a hash-chained append-only journal (the wrapper's format discipline), one launch per dir:
  (none)|qualified -> qualified    a strictly newer N' AND a strictly newer L1 block AND an unused receipt (no replay)
  (none)|qualified -> contradicted TERMINAL: authenticated values and our bound node disagree (fork, DB swap, broken ancestry)
  (none)|qualified -> revoked      TERMINAL: root reason (e.g. the launch was rolled back)
A qualification is CURRENT only for the process and launch-journal head it was recorded with (`status`): a restart or a rearm
makes it stale until a new fresh proof re-walks N'' -> N through every earlier qualified point.
Commands (root only):  check | record | status | revoke   (record: HOLD while FINALITY_PROTOTYPE_REVIEWED is False)
"""
import base64, datetime, fcntl, hashlib, json, os, pathlib, re, shutil, stat, subprocess, sys, tempfile, urllib.parse

FINALITY_PROTOTYPE_REVIEWED = False          # source constant: `record` refuses until root reviews this prototype
OWNER = 0                                    # every trusted file/dir must be owned by this uid (tests override)
HERE = pathlib.Path(__file__).resolve().parent.parent
CORE_PINS = {'src/finality-core.mjs': '686cbc22cd837dbc0bb79512105972297c5addbe512dbd6dce2cfac28aaa6eab', 'vendor/anchor-bootstrap.mjs': '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8'}
A1_GATE_PINS = {'a1-gate.mjs': '06cc29612d1d380e91c932dc13ed676e153c8aab368103eac673c4004409414c',      # harness A1_GATE_PINS
                'a1-recheck.mjs': 'f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8',
                'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d'}
A1_RUNNER_SHA256 = 'b3044bbf9da1346da56837dcab7504b6e0bcb357c80cc13fc044e04266130210'   # l1-anchor-a1/live-1958/run.py
A1_INPUT_PINS = {'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d',          # run.py inputPins
                 'a1-read.mjs': 'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8',
                 'vendor/anchor-bootstrap.mjs': '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8'}
HELIOS_SHA256 = 'cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0'
MAINNET = {'portal': '0x49048044d57e1c92a77f79988d21fa8faf74e97e', 'asr': '0x909f6cf47ed12f010a796527f562bfc26c7f4e72', 'respectedGameType': 621,
           'codeHashes': {'0x49048044d57e1c92a77f79988d21fa8faf74e97e': '0x7d1cd19d713c8d64bf663f4168250abfbf690dbb6214c25bf757fee383816914',
                          '0x909f6cf47ed12f010a796527f562bfc26c7f4e72': '0xfa8c9db6c6cab7108dea276f4cd09d575674eb0852c0fa3187e59e98ef977998'}}  # a2a4.py
A1_MAX_RECEIPT_AGE_SEC, A1_MAX_L1_AGE_SEC, A1_RUN_WINDOW_SEC = 900, 1800, 300
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


def launch_head(launch, W, top):
    """the wrapper's verified journal; qualification needs a STARTED launch (last event consumed)"""
    try:
        entries = W.journal_entries(launch['dir'] / 'journal', OWNER, launch['launchSha256'], top)
    except AssertionError as e:
        refuse('launch_journal', str(e))
    e_sha, e = entries[-1]
    if e['event'] == 'rolled-back':
        refuse('rolled_back', 'the launch was rolled back: nothing is qualified for it')
    if e['event'] != 'consumed':
        refuse('not_started', f'the launch journal is {e["event"]!r}: no start consumed this launch record')
    return {'seq': e['seq'], 'entrySha256': e_sha}


# ---- the fresh A1 receipt: reviewed producer, provenance, pinned gate, harness rules -------------------------------------
def node_gate(receipt_bytes, node, workdir):
    """the PINNED A1 gate (fresh-initial) over the exact bytes, from a private copy (the harness's a1_node_gate pattern)"""
    d = pathlib.Path(tempfile.mkdtemp(prefix='a1gate-', dir=workdir))
    try:
        for name, want in A1_GATE_PINS.items():
            b = (HERE / 'a1gate' / name).read_bytes()
            if sha(b) != want:
                refuse('a1_gate_pin', f'{name} differs from its pin')
            (d / name).write_bytes(b)
        script = ("const g=await import(process.env.G);const fs=await import('node:fs');const i=JSON.parse(fs.readFileSync(0,'utf8'));"
                  "try{console.log(JSON.stringify({ok:true,summary:g.gate(i)}))}catch(e){console.log(JSON.stringify({ok:false,code:e.code||'error',"
                  "error:String(e.message||e).slice(0,300)}));process.exit(3)}")
        p = subprocess.run([node, '--input-type=module', '-e', script], input=json.dumps({'mode': 'fresh-initial', 'initial': base64.b64encode(receipt_bytes).decode()}),
                           capture_output=True, text=True, env={'G': (d / 'a1-gate.mjs').as_uri(), 'PATH': '/usr/bin:/bin'}, timeout=60)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        refuse('a1_tool', f'the A1 gate produced no verdict: {p.stderr[-300:]}')
    if p.returncode != 0 or r.get('ok') is not True:
        refuse('a1_receipt', f'{r.get("code")}: {r.get("error")}')
    return r['summary']


def fresh_a1(run_dir, now, gate, top):
    run_dir = pathlib.Path(run_dir); secure_dir(run_dir, top)
    if sha(read_trusted(run_dir / 'run.py')) != A1_RUNNER_SHA256:
        refuse('a1_provenance', 'the A1 output directory was not produced by the reviewed runner (run.py sha)')
    rr_b = read_trusted(run_dir / 'run-result.json'); rr = jload(rr_b, 'run-result.json')
    hs = rr.get('heliosStatus') or {}
    if rr.get('inputPins') != A1_INPUT_PINS or hs.get('binarySha256') != HELIOS_SHA256 or hs.get('verdict') != 'fresh-finalized' \
            or type(rr.get('a1Exit')) is not int or rr['a1Exit'] != 0 or rr.get('processStopped') is not True \
            or rr.get('productionActivated') is not False or 'error' in rr:
        refuse('a1_provenance', 'the run record is not a clean exit-0 run of the pinned A1 modules on the pinned Helios, Helios stopped')
    cfg = jload(read_trusted(run_dir / 'a1-config.json'), 'a1-config.json')
    if str(cfg.get('portal', '')).lower() != MAINNET['portal'] or str(cfg.get('asr', '')).lower() != MAINNET['asr'] or cfg.get('expectedChainId') != 1:
        refuse('a1_provenance', 'the run used another portal/ASR/chain than the pinned mainnet values')
    ev = read_trusted(run_dir / 'a1-evidence.json')
    s = gate(ev)
    at = _utc(s.get('at'), 'A1 at')
    if not _utc(rr.get('startedAt'), 'run startedAt') <= at <= _utc(rr.get('finishedAt'), 'run finishedAt'):
        refuse('a1_provenance', 'the receipt time lies outside its run record window')
    age = (now - at).total_seconds()
    if age < 0 or age > A1_MAX_RECEIPT_AGE_SEC:
        refuse('a1_stale', f'the A1 receipt is {int(age)} s old (max {A1_MAX_RECEIPT_AGE_SEC}): run the reviewed A1 runner again')
    if s.get('asr') != MAINNET['asr'] or s.get('respectedGameType') != MAINNET['respectedGameType']:
        refuse('a1_pins', 'ASR or respected game type is not the pinned mainnet value')
    for addr, ch in MAINNET['codeHashes'].items():
        if (s.get('pins') or {}).get(addr, {}).get('codeHash') != ch:
            refuse('a1_pins', f'code hash of {addr} differs from the pin')
    l1 = s.get('l1') or {}
    if not isinstance(l1.get('ageSec'), int) or l1['ageSec'] > A1_MAX_L1_AGE_SEC \
            or not l1['ageSec'] <= at.timestamp() - l1.get('timestamp', -1) <= l1['ageSec'] + A1_RUN_WINDOW_SEC:
        refuse('a1_l1_stale', 'the L1 finalized header was too old or its age is inconsistent with the receipt time')
    if not re.fullmatch(r'[1-9][0-9]*', str(s.get('N'))) or not H32.fullmatch(str(s.get('outputRoot'))) or not isinstance(l1.get('number'), int):
        refuse('a1_receipt', 'normalized receipt lacks N/outputRoot/L1 number')
    return {'N': int(s['N']), 'outputRoot': s['outputRoot'], 'game': s['game'], 'l1': {'number': l1['number'], 'hash': l1.get('hash')},
            'at': s['at'], 'receiptSha256': s['initialSha256'], 'runResultSha256': sha(rr_b)}


def post_anchor_rules(a1, launch, prior):
    if a1['N'] <= launch['N']:
        refuse('not_post_anchor', f'the fresh anchor {a1["N"]} is not above the launch anchor {launch["N"]}')
    if a1['game'] == launch['game']:
        refuse('same_game', 'the fresh receipt names the launch game itself: no newer anchor exists yet')
    if a1['l1']['number'] <= launch['l1Finalized']:
        refuse('stale_l1', 'the fresh receipt is not at a newer L1 block than the launch A1')
    for e in prior:
        q = e['evidence']
        if q['a1']['receiptSha256'] == a1['receiptSha256'] or q['a1']['runResultSha256'] == a1['runResultSha256']:
            refuse('replayed', 'this A1 receipt (or run) was already used')
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
                inodes.add(f[9])
    pids = set()
    for pd in pathlib.Path(proc).iterdir():
        if pd.name.isdigit():
            try:
                links = [os.readlink(x) for x in (pd / 'fd').iterdir()]
            except OSError:
                continue
            if any(l in {f'socket:[{i}]' for i in inodes} for l in links):
                pids.add(pd.name)
    if len(inodes) == 0 or len(pids) != 1:
        refuse('process_binding', f'port {u.port}: {len(inodes)} listening socket(s), {len(pids)} owning process(es); exactly one is required')
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
def run_core(launch, a1, prior, rpc_url, node, deps_root, workdir, chunk=512):
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
        noble = pathlib.Path(deps_root, 'node_modules/@noble/hashes')
        if json.loads((noble / 'package.json').read_text()).get('version') != '1.8.0':
            refuse('deps', '@noble/hashes is not the pinned 1.8.0')
        p = subprocess.run([node, '--input-type=module', '-e', script], input=json.dumps({'args': args, 'url': rpc_url, 'chunk': chunk}),
                           capture_output=True, text=True, timeout=3600,
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
def qualify(d, chain_json, fdir, a1_dir, rpc_url, *, W, gate, node, deps_root, workdir, write, now=None, top='/', proc='/proc', chunk=512):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if write and not FINALITY_PROTOTYPE_REVIEWED:                 # no write of ANY kind (qualified or contradicted) until reviewed
        refuse('hold_prototype', 'HOLD: FINALITY_PROTOTYPE_REVIEWED is False; use `check` (verifies, records nothing)')
    launch = load_launch(d, chain_json, top)
    try:
        lock = W.launch_lock(launch['dir'], OWNER, top)
    except AssertionError as e:
        refuse('lock', str(e))
    try:
        head = launch_head(launch, W, top)
        cur = entries(fdir, launch['launchSha256'], top)
        if cur and not NEXT[cur[-1]['event']]:
            refuse('terminal', f'the finality journal is {cur[-1]["event"]!r} (terminal)')
        prior = [e for e in cur if e['event'] == 'qualified']
        a1 = fresh_a1(a1_dir, now, gate, top)
        post_anchor_rules(a1, launch, prior)
        p1 = bind_process(rpc_url, launch, proc)
        try:
            v = run_core(launch, a1, prior, rpc_url, node, deps_root, workdir, chunk)
        except Refused as e:
            if e.contradiction and write:
                p2 = bind_process(rpc_url, launch, proc)
                if p2 == p1:                              # only a contradiction from the SAME bound process is recorded
                    append(fdir, launch['launchSha256'], cur, 'contradicted', {'code': e.code, 'detail': str(e)[:500], 'a1': a1, 'process': p1,
                           'launchJournal': head}, now, top)
            raise
        if bind_process(rpc_url, launch, proc) != p1:
            refuse('process_changed', 'the node process changed during the proof (restart): nothing is qualified')
        evidence = {'original': v['original'], 'fresh': v['fresh'], 'span': v['span'], 'priorChecked': v['priorChecked'], 'a1': a1,
                    'process': p1, 'launchJournal': head,
                    'code': {**{k: sha((HERE / k).read_bytes()) for k in CORE_PINS}, **{f'a1gate/{k}': w for k, w in A1_GATE_PINS.items()},
                             'finality_state.py': sha(pathlib.Path(__file__).read_bytes())}}
        if write:
            after = append(fdir, launch['launchSha256'], cur, 'qualified', evidence, now, top)
            return {'event': 'qualified', 'seq': after[-1]['seq'], 'entrySha256': after[-1]['sha'], **evidence}
        return {'event': None, 'checked': True, **evidence}
    finally:
        os.close(lock)


def status(d, chain_json, fdir, rpc_url, *, W, top='/', proc='/proc'):
    """CURRENT only if the last entry is `qualified` for THIS launch-journal head and THIS running process (no restart since)"""
    launch = load_launch(d, chain_json, top)
    cur = entries(fdir, launch['launchSha256'], top)
    if not cur:
        return {'state': 'none', 'qualified': False}
    last = cur[-1]
    if last['event'] != 'qualified':
        return {'state': last['event'], 'qualified': False, 'seq': last['seq']}
    try:
        head, p = launch_head(launch, W, top), bind_process(rpc_url, launch, proc)
    except Refused as e:
        return {'state': 'unbound', 'qualified': False, 'refused': str(e)}
    if head != last['evidence']['launchJournal']:
        return {'state': 'stale-launch-changed', 'qualified': False}
    if p != last['evidence']['process']:
        return {'state': 'stale-after-restart', 'qualified': False}
    return {'state': 'qualified', 'qualified': True, 'freshN': last['evidence']['fresh']['N'], 'entrySha256': last['sha'], 'at': last['at']}


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
        cur = entries(fdir, launch['launchSha256'], top)
        after = append(fdir, launch['launchSha256'], cur, 'revoked', {'reason': reason}, now, top)
        return {'event': 'revoked', 'seq': after[-1]['seq']}
    finally:
        os.close(lock)


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    usage = ('check|record <launch-dir> <chain.json> <finality-dir> <a1-run-dir> <rpc-url>; status <launch-dir> <chain.json> <finality-dir> <rpc-url>; '
             'revoke <launch-dir> <chain.json> <finality-dir> <reason>.  env: FINALITY_NODE, FINALITY_DEPS_ROOT, FINALITY_WORKDIR (root-owned 0700)')
    try:
        sys.path.insert(0, '/opt/enclave-rpc'); import chain_service as W            # the INSTALLED wrapper: its lock and journal
        if not (hasattr(W, 'launch_lock') and hasattr(W, 'journal_entries')):
            refuse('wrapper', 'the installed chain_service.py has no launch journal')
        cmd = argv[1]
        if cmd in ('check', 'record') and len(argv) == 7:
            node, deps, wd = os.environ['FINALITY_NODE'], os.environ['FINALITY_DEPS_ROOT'], os.environ['FINALITY_WORKDIR']
            secure_dir(wd, '/')
            r = qualify(argv[2], argv[3], argv[4], argv[5], argv[6], W=W, gate=lambda b: node_gate(b, node, wd), node=node, deps_root=deps,
                        workdir=wd, write=cmd == 'record')
        elif cmd == 'status' and len(argv) == 6:
            r = status(argv[2], argv[3], argv[4], argv[5], W=W)
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
