#!/usr/bin/env python3
"""a1_capture.py: CAPTURE-BOUND A1 runner and verifier (a1-capture-binding-stage, PREPARED; NOT run; not enabled anywhere).

A revision of root's reviewed runners live-1958/run.py (initial) and a1-original-game-prepared/run-recheck.py (original-game
recheck) that binds, AT CAPTURE, exactly what ran (restart-review DESIGN.md section 4 gaps G1-G7). It reuses the reviewed A1
modules, the reviewed l1_authority.py and the pinned A1 gate UNCHANGED; it adds no authority and no new verification logic:
the cryptographic checks (Helios-verified eth_call, our own MPT verification, header hash recomputation) remain those of
a1-anchor.mjs / a1-recheck.mjs, executed here from private copies.

  capture   python3 -I a1_capture.py capture initial|recheck OUT     (root; OUT must not exist)
  verify    python3 -I a1_capture.py verify  OUT                     (root; exit 0 + JSON summary only for a clean binding)

Capture (every step refuses on any deviation; a failed capture is still published, with its error, and never verifies):
  1. mkdir OUT exclusively (0700) - nothing can be replaced into it; build inside OUT/.partial-<pid>.
  2. Read every input ONCE (O_NOFOLLOW, regular, bounded) into memory, hash THOSE bytes, compare code with the reviewed pins
     below, write them as 0400 copies with O_EXCL: A1 modules, test/deps.mjs, l1_authority.py, the dependency closure
     (per-package content digests), the node binary, the l1-authority config + its checkpoint file, portal-result.json, the
     A1 config template (initial) or the pinned initial receipt (recheck). Configs/data are BOUND (hashed and recorded),
     semantically validated, and re-derivable by the verifier.
  3. Derive the run inputs only from the copies: the l1-authority config with checkpointFile -> the copy (nothing else
     changes, asserted); the A1 config exactly as run.py / run-recheck.py derive it.
  4. capture.json (O_EXCL, fsync) BEFORE anything executes: capture id (random), mode, every file's sha/size/source/role,
     the exact argv and env of both processes, interpreter and node identity.
  5. Start Helios through the COPIED l1_authority.py (it hashes the pinned binary from an open fd and execs that fd).
  6. Re-hash every copy; execute ONLY the copies (node copy, module copies, deps copy via ANCHOR_DEPS_ROOT); stdout -> an
     O_EXCL evidence file. Stop Helios. Re-hash every copy again.
  7. result.json (O_EXCL, fsync): sha of capture.json, exits, Helios status/stopped, evidence/stderr/log shas, both re-hash
     verdicts. Files 0400, then rename .partial-<pid> -> OUT/capture (a fresh name inside the exclusive OUT).
Threat model: root and the host are trusted to run THIS runner; the binding proves which reviewed bytes an honest run
executed and detects any later replacement of copies, records or evidence. It cannot defend against a malicious root
(no attestation), and node's shared libraries and the Helios data/home directories are not pinned (recorded as limits).
"""
import base64, dataclasses, datetime, hashlib, json, os, pathlib, re, secrets, shutil, signal, stat, subprocess, sys, time

W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo'); P = W / 'work/rpc-production-final-20261025'
O = W / 'outputs/rpc-production-final-20261025'; HERE = pathlib.Path(__file__).resolve().parent.parent
OPS = P / 'source/ops/rpc-backend-bootstrap/2026-10-25'
FORMAT = 'enclave-a1-capture/v1'
OWNER = 0
CAP_FILE, CAP_BIN = 1 << 20, 512 << 20

# ---- reviewed pins (sources: l1-anchor-a1/SHA256SUMS, a1-original-game-prepared/SHA256SUMS, harness RECHECK_INPUT_PINS) ----
MODULES = {
    'initial': {'a1-read.mjs': 'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8',
                'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d',
                'vendor/anchor-bootstrap.mjs': '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8',
                'test/deps.mjs': 'b7b08e8e2ddc55f68e7c9cf1e9cea7a99ce4ce8598270cdc8497a8a4f9cec6c4'},
    'recheck': {'a1-recheck-read.mjs': '41b83975e96fc816bd5743e56626dd309aa7f0ee03c6efb9912788eb184a7715',
                'a1-recheck.mjs': 'f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8',
                'a1-read.mjs': 'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8',
                'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d',
                'vendor/anchor-bootstrap.mjs': '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8',
                'test/deps.mjs': 'b7b08e8e2ddc55f68e7c9cf1e9cea7a99ce4ce8598270cdc8497a8a4f9cec6c4'}}
ENTRY = {'initial': 'a1-read.mjs', 'recheck': 'a1-recheck-read.mjs'}
L1_AUTHORITY_SHA256 = 'f4a5160b131f4d6880eaabc5f7ba70cb1447c7ad7dc39b30ed881a18212e8f12'      # finality-stage/l1-authority
HELIOS_SHA256 = 'cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0'
A1_EXAMPLE_SHA256 = '2eeadf2457f108de71ea8199724e36dbc58f805b2afa74d23f904a2219774270'        # l1-anchor-a1/a1-config.example.json
INITIAL_SHA256 = 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'           # live-1958/a1-evidence.json
LOCK_SHA256 = '9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20'              # source/package-lock.json
# the closure of @noble/hashes + viem in that lock (all top-level), content digest of the INSTALLED tree as observed
# 2026-10-25 at source/node_modules -> work/enclave/node_modules (rows "relpath sha256", sorted, no nested node_modules)
DEPS = {'@adraffy/ens-normalize': ('1.11.1', '0789dcdd72da73907d6a78bcc453b44bc12823203e10c76c8c842d36452aef45'),
        '@noble/ciphers': ('1.3.0', 'e1085be179d844f48d30af1d920a8ead131b1389da153d80d5beb88850214a66'),
        '@noble/curves': ('1.9.1', '70d4bd268c5db54e1febe8967f3cd4515e78731a16675c81094ab121e8c43a52'),
        '@noble/hashes': ('1.8.0', '659a1fe3b7b10284d704f923d3f2ce3c29f5da740c6bc6914f7e29e3176a9c08'),
        '@scure/base': ('1.2.6', '12781763967569cf33b76195cccf8496e8e6b823f0e359fec3de85bbf6c4e818'),
        '@scure/bip32': ('1.7.0', '22e55b7e65f7b5e578ca74326b0b6e1d7ce089039c2c481ae5e979b88993a7e6'),
        '@scure/bip39': ('1.6.0', '17765392e67bfb28de106ddfdd662a40e951d927f3d32576f9c68529f92f700b'),
        'abitype': ('1.2.3', '35286df2a6374a8545b8460d4df10dd53d993c503bb6eb469e4a0e2a54b36d16'),
        'eventemitter3': ('5.0.1', '8f8d6c84d0580f30c888c3a09a881def5d5e232efec4d86c587ee5cc71704f1b'),
        'isows': ('1.0.7', '3be32bc2d379fd9049b39d6d3385ac5aa010ec68b71e6678e8332191a45fe00f'),
        'ox': ('0.14.29', 'f7824543c25c32697eae4e36bab9a2abbb6109159945ef511023684d4ce49f68'),
        'viem': ('2.53.1', 'e200d4d114ee5ddceb49a4a6c840fd9f2765332635a75bf92e0fc9586680636c'),
        'ws': ('8.21.1', '25bf32c98e5846d4ecfc17e0f43762ac1c15b6acd630b950b805ce22c0596b95')}
DEPS_PACKAGE_JSON = b'{"name": "a1-capture-deps", "private": true}\n'
MAINNET = {'portal': '0x49048044d57e1c92a77f79988d21fa8faf74e97e', 'asr': '0x909f6cf47ed12f010a796527f562bfc26c7f4e72'}
RECHECK_ORIGINAL = {'originalGame': '0x343b3a99527af07d2cfb2652747b9e37715e21ac', 'originalN': '52866960',
                    'originalOutputRoot': '0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700'}
A1_GATE_PINS = {'a1-gate.mjs': '06cc29612d1d380e91c932dc13ed676e153c8aab368103eac673c4004409414c',
                'a1-recheck.mjs': 'f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8',
                'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d'}


@dataclasses.dataclass
class Sources:                      # production defaults = the paths root's reviewed runners use; tests substitute stubs
    initial_dir: pathlib.Path = OPS / 'l1-anchor-a1'
    recheck_dir: pathlib.Path = OPS / 'a1-original-game-prepared'
    l1_authority: pathlib.Path = P / 'finality-stage/l1-authority/l1_authority.py'
    l1_config: pathlib.Path = O / 'l1-authority-live-1941/config.json'
    portal_result: pathlib.Path = O / 'l1-proof-window/retest-30s/portal-result.json'
    initial_receipt: pathlib.Path = OPS / 'l1-anchor-a1/live-1958/a1-evidence.json'
    deps_root: pathlib.Path = P / 'source'
    node: str = '/usr/bin/node'
    el_url: str = 'http://127.0.0.1:28645'


@dataclasses.dataclass
class Pins:
    modules: dict = dataclasses.field(default_factory=lambda: MODULES)
    l1_authority: str = L1_AUTHORITY_SHA256
    helios: str = HELIOS_SHA256
    a1_example: str = A1_EXAMPLE_SHA256
    initial: str = INITIAL_SHA256
    lock: str = LOCK_SHA256
    deps: dict = dataclasses.field(default_factory=lambda: DEPS)
    asr: str = MAINNET['asr']
    portal: str = MAINNET['portal']
    gate: dict = dataclasses.field(default_factory=lambda: A1_GATE_PINS)


class Refused(Exception):
    def __init__(self, code, why):
        super().__init__(f'{code}: {why}'); self.code = code


def refuse(code, why):
    raise Refused(code, why)


sha = lambda b: hashlib.sha256(b).hexdigest()
utcnow = lambda: datetime.datetime.now(datetime.timezone.utc)


def read_once(p, cap=CAP_FILE):
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        refuse('input', f'{p} cannot be opened as a regular non-symlink file ({type(e).__name__})')
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            refuse('input', f'{p} is not a regular file')
        b = f.read(cap + 1)
    if len(b) > cap:
        refuse('input', f'{p} exceeds {cap} bytes')
    return b


def write_new(p, b, mode=0o400):
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        v = memoryview(b)
        while v:
            v = v[os.write(fd, v):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(p, mode)


def tree_rows(files):
    """the DEPS digest: rows 'relpath sha256' sorted (same rule as the pin computation)"""
    return hashlib.sha256(('\n'.join(f'{r} {h}' for r, h in sorted(files.items())) + '\n').encode()).hexdigest()


def read_package(root, name):
    """every regular file of node_modules/<name> (no nested node_modules, no symlink, no special file), read once"""
    base = pathlib.Path(root, 'node_modules', name); out = {}
    for d, ds, fs in os.walk(base):
        ds[:] = sorted(x for x in ds if x != 'node_modules')
        for x in ds:
            if os.path.islink(os.path.join(d, x)):
                refuse('deps', f'{name}: symlinked directory {x}')
        for f in sorted(fs):
            out[os.path.relpath(os.path.join(d, f), base)] = read_once(os.path.join(d, f), CAP_BIN)
    return out


def derive_l1_config(orig_bytes, checkpoint_path):
    c = json.loads(orig_bytes)
    if not isinstance(c, dict) or 'checkpointFile' not in c:
        refuse('l1_config', 'the l1-authority config has no checkpointFile')
    d = dict(c); d['checkpointFile'] = str(checkpoint_path)
    if {k: v for k, v in d.items() if k != 'checkpointFile'} != {k: v for k, v in c.items() if k != 'checkpointFile'}:
        refuse('l1_config', 'derivation changed more than checkpointFile')
    return json.dumps(d, indent=2, sort_keys=True).encode()


def derive_a1_config(mode, example_bytes, portal_bytes, helios_url, el_url, pins):
    """exactly the reviewed runners' derivation (run.py / run-recheck.py), from the COPIES; the verifier recomputes it"""
    proven = json.loads(portal_bytes)
    if proven.get('readSucceeded') is not True or str(proven.get('asr', '')).lower() != pins.asr:
        refuse('portal_result', 'portal-result.json is not a succeeded verified getter read naming the pinned ASR')
    if mode == 'initial':
        cfg = json.loads(example_bytes); cfg.pop('_notes', None)
        cfg['heliosUrl'] = helios_url; cfg['asr'] = proven['asr']; cfg['maxFinalizedAgeSec'] = 1800
        cfg['asrCandidates'] = list(cfg.get('asrCandidates', [])) + [{'address': proven['asr'], 'provenance': 'root Helios-verified portal getter at ' + str((proven.get('block') or {}).get('hash'))}]
    else:
        cfg = {'heliosUrl': helios_url, 'elUrl': el_url, 'expectedChainId': 1, 'pinBy': 'hash', 'portal': pins.portal, 'asr': pins.asr,
               'portalAsrGetter': 'anchorStateRegistry()', 'maxFinalizedAgeSec': 1800, 'initialEvidenceSha256': pins.initial, **RECHECK_ORIGINAL}
    if str(cfg.get('portal', '')).lower() != pins.portal or str(cfg.get('asr', '')).lower() != pins.asr or cfg.get('expectedChainId') != 1:
        refuse('a1_config', 'derived A1 config does not name the pinned mainnet portal/ASR/chain')
    return json.dumps(cfg, indent=2, sort_keys=True).encode()


def load_module(path, name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def capture(mode, out, src=None, pins=None, hooks=None, helios_timeout=90, a1_timeout=240):
    src, pins, hooks = src or Sources(), pins or Pins(), hooks or {}
    if mode not in MODULES:
        refuse('mode', 'mode is initial or recheck')
    out = pathlib.Path(out)
    os.mkdir(out, 0o700)                                            # EXCLUSIVE: an existing OUT (or a race) refuses here
    stage = out / f'.partial-{os.getpid()}'; os.mkdir(stage, 0o700)
    files, rec, res, helios = {}, None, {'format': FORMAT}, None

    def put(rel, b, role, source, mode_bits=0o400):
        write_new(stage / rel, b, mode_bits); files[rel] = {'sha256': sha(b), 'size': len(b), 'role': role, 'source': str(source)}
        return stage / rel
    try:
        mdir = src.initial_dir if mode == 'initial' else src.recheck_dir
        for rel, want in pins.modules[mode].items():
            b = read_once(mdir / rel)
            if sha(b) != want:
                refuse('module_pin', f'{rel} is not the reviewed {want[:12]}')
            put(f'code/{rel}', b, 'module', mdir / rel)
        b = read_once(src.l1_authority)
        if sha(b) != pins.l1_authority:
            refuse('l1_authority_pin', 'l1_authority.py is not the reviewed launcher')
        l1a = put('code/l1_authority.py', b, 'l1-authority', src.l1_authority)
        b = read_once(pathlib.Path(src.deps_root, 'package-lock.json'), 64 << 20)
        if sha(b) != pins.lock:
            refuse('deps_lock', 'package-lock.json is not the pinned lock')
        put('code/deps/package-lock.json', b, 'deps-lock', pathlib.Path(src.deps_root, 'package-lock.json'))
        lock = json.loads(b)['packages']
        put('code/deps/package.json', DEPS_PACKAGE_JSON, 'deps-root', '(constant)')
        for name, (ver, digest) in sorted(pins.deps.items()):
            pf = read_package(src.deps_root, name)
            if (lock.get(f'node_modules/{name}') or {}).get('version') != ver or json.loads(pf.get('package.json', b'{}')).get('version') != ver:
                refuse('deps_version', f'{name} is not {ver} in the lock and the installed package.json')
            if tree_rows({r: sha(x) for r, x in pf.items()}) != digest:
                refuse('deps_content', f'{name} {ver} content differs from the pinned digest')
            for r, x in pf.items():
                put(f'code/deps/node_modules/{name}/{r}', x, 'dep', pathlib.Path(src.deps_root, 'node_modules', name, r))
        nb = read_once(os.path.realpath(src.node), CAP_BIN)
        node = put('bin/node', nb, 'node', os.path.realpath(src.node), 0o500)
        py = sys.executable and os.path.realpath(sys.executable)
        l1b = read_once(src.l1_config)
        put('inputs/l1-authority-config.json', l1b, 'l1-config', src.l1_config)
        cpb = read_once(json.loads(l1b)['checkpointFile'])
        cp = put('inputs/l1-checkpoint.json', cpb, 'l1-checkpoint', json.loads(l1b)['checkpointFile'])
        l1d = put('inputs/l1-authority-config.derived.json', derive_l1_config(l1b, cp), 'l1-config-derived', '(derived)')
        L = load_module(l1a, 'l1_authority_copy')                       # the COPY, never the source path
        c = L.load_config(str(l1d))
        if c['cfg']['binary']['sha256'] != pins.helios:
            refuse('helios_pin', 'the l1-authority config pins another Helios binary')
        helios_url = f"http://{c['listenIp']}:{c['listenPort']}"
        pb = read_once(src.portal_result)
        put('inputs/portal-result.json', pb, 'portal-result', src.portal_result)
        if mode == 'initial':
            eb = read_once(src.initial_dir / 'a1-config.example.json')
            if sha(eb) != pins.a1_example:
                refuse('a1_example_pin', 'a1-config.example.json is not the reviewed template')
            put('inputs/a1-config.example.json', eb, 'a1-template', src.initial_dir / 'a1-config.example.json')
        else:
            eb = None
            ib = read_once(src.initial_receipt)
            if sha(ib) != pins.initial:
                refuse('initial_pin', 'the initial receipt is not the pinned one')
            put('inputs/initial-a1-evidence.json', ib, 'initial-receipt', src.initial_receipt)
        a1c = put('inputs/a1-config.json', derive_a1_config(mode, eb, pb, helios_url, src.el_url, pins), 'a1-config', '(derived)')
        a1_argv = [str(node), str(stage / 'code' / ENTRY[mode]), str(a1c)] + ([str(stage / 'inputs/initial-a1-evidence.json')] if mode == 'recheck' else [])
        a1_env = {'ANCHOR_DEPS_ROOT': str(stage / 'code/deps'), 'PATH': '/usr/bin:/bin'}
        h_argv = [py, '-I', str(l1a), 'run', str(l1d)]
        rec = {'format': FORMAT, 'captureId': secrets.token_hex(16), 'mode': mode, 'startedAt': utcnow().isoformat(), 'files': files,
               'argv': {'helios': h_argv, 'a1': a1_argv}, 'env': {'a1': a1_env}, 'stageName': stage.name, 'outPath': str(out),
               'python': {'executable': py, 'sha256': sha(read_once(py, CAP_BIN)), 'version': sys.version},
               'pins': {'helios': pins.helios, 'lock': pins.lock}}
        rb = json.dumps(rec, indent=1, sort_keys=True).encode()
        write_new(stage / 'capture.json', rb, 0o400)                 # bound BEFORE anything executes
        res['captureSha256'], res['captureId'] = sha(rb), rec['captureId']
        fd = os.open(stage / 'helios.out', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, 'wb') as log:
            helios = subprocess.Popen(h_argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, env={'PATH': '/usr/bin:/bin'})
        end = time.monotonic() + helios_timeout
        while True:
            time.sleep(hooks.get('poll', 3))
            try:
                res['heliosStatus'] = L.status(c); break
            except Exception:
                if time.monotonic() > end or helios.poll() is not None:
                    raise
        if 'before_exec' in hooks:
            hooks['before_exec'](stage)                               # tests: swap SOURCES here; only copies execute
        res['copiesBeforeExec'] = rehash(stage, files)
        fo = os.open(stage / 'evidence.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        fe = os.open(stage / 'a1.stderr', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            x = subprocess.run(a1_argv, env=a1_env, stdin=subprocess.DEVNULL, stdout=fo, stderr=fe, cwd=stage / 'code', timeout=a1_timeout)
        finally:
            os.close(fo); os.close(fe)
        res['a1Exit'] = x.returncode
    except Refused as e:
        res['error'] = str(e)[:500]
    except Exception as e:                                           # recorded, never verifies
        res['error'] = f'{type(e).__name__}: {str(e)[:400]}'
    finally:
        if helios is not None and helios.poll() is None:
            os.killpg(helios.pid, signal.SIGTERM)
            try:
                helios.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(helios.pid, signal.SIGKILL); helios.wait(timeout=5)
        res['processStopped'] = helios is not None and helios.poll() is not None
        res['copiesAfterRun'] = rehash(stage, files) if rec else False
        for n in ('evidence.json', 'a1.stderr', 'helios.out'):
            if (stage / n).exists():
                os.chmod(stage / n, 0o400); res[n.replace('.', '_') + 'Sha256'] = sha((stage / n).read_bytes())
        res['finishedAt'] = utcnow().isoformat()
        write_new(stage / 'result.json', json.dumps(res, indent=1, sort_keys=True).encode(), 0o400)
        for d, _, _ in os.walk(stage):
            fsync_dir(d)
        os.rename(stage, out / 'capture'); fsync_dir(out)
    ok = res.get('a1Exit') == 0 and res['processStopped'] and res.get('copiesBeforeExec') is True and res['copiesAfterRun'] is True and 'error' not in res
    return ok, res


def fsync_dir(d):
    fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def rehash(stage, files):
    for rel, f in files.items():
        p = pathlib.Path(stage, rel); st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode) or sha(read_once(p, CAP_BIN)) != f['sha256']:
            return False
    return True


# ---- verifier ---------------------------------------------------------------------------------------------------------
RECORDS = {'capture.json', 'result.json', 'evidence.json', 'a1.stderr', 'helios.out'}


def _trusted_tree(d):
    """every entry: no symlink, owned by OWNER, not group/other writable; files regular, directories directories"""
    out = set()
    for r, ds, fs in os.walk(d):
        for x in ds + fs:
            p = os.path.join(r, x); st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode) or st.st_uid != OWNER or st.st_mode & 0o022:
                refuse('untrusted', f'{os.path.relpath(p, d)} is a symlink, foreign-owned or group/other writable')
            if x in fs:
                if not stat.S_ISREG(st.st_mode):
                    refuse('untrusted', f'{os.path.relpath(p, d)} is not a regular file')
                out.add(os.path.relpath(p, d))
    return out


def gate(evidence, mode, initial, node, pins, workdir):
    """the PINNED A1 gate (fresh-initial / original-game-recheck) over the exact bytes, from a private copy"""
    import tempfile
    d = pathlib.Path(tempfile.mkdtemp(prefix='a1gate-', dir=workdir))
    try:
        for name, want in pins.gate.items():
            b = read_once(HERE / 'a1gate' / name)
            if sha(b) != want:
                refuse('gate_pin', f'{name} differs from its pin')
            (d / name).write_bytes(b)
        i = {'mode': 'fresh-initial', 'initial': base64.b64encode(evidence).decode()} if mode == 'initial' else \
            {'mode': 'original-game-recheck', 'initial': base64.b64encode(initial).decode(), 'initialSha256': pins.initial, 'recheck': base64.b64encode(evidence).decode()}
        script = ("const g=await import(process.env.G);const fs=await import('node:fs');const i=JSON.parse(fs.readFileSync(0,'utf8'));"
                  "try{console.log(JSON.stringify({ok:true,summary:g.gate(i)}))}catch(e){console.log(JSON.stringify({ok:false,code:e.code||'error',"
                  "error:String(e.message||e).slice(0,300)}));process.exit(3)}")
        p = subprocess.run([node, '--input-type=module', '-e', script], input=json.dumps(i), capture_output=True, text=True,
                           env={'G': (d / 'a1-gate.mjs').as_uri(), 'PATH': '/usr/bin:/bin'}, timeout=60)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        refuse('gate_tool', f'the A1 gate produced no verdict: {p.stderr[-300:]}')
    if p.returncode != 0 or r.get('ok') is not True:
        refuse('gate', f'{r.get("code")}: {r.get("error")}')
    return r['summary']


def _utc(s, what):
    try:
        t = datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError:
        t = None
    if t is None or t.tzinfo is None:
        refuse('time', f'{what} {s!r} is not an ISO UTC time')
    return t


def verify(out, pins=None, node='/usr/bin/node', workdir='/tmp', run_gate=True):
    """-> summary of a CLEAN capture-bound A1 run; refuses on any deviation. Stateless: replay is the CONSUMER's ledger (admit)."""
    pins = pins or Pins(); out = pathlib.Path(out)
    st = os.lstat(out)
    if stat.S_ISLNK(st.st_mode) or st.st_uid != OWNER or st.st_mode & 0o077 or os.listdir(out) != ['capture']:
        refuse('layout', 'OUT must be a private OWNER directory holding exactly capture/ (no partial, nothing else)')
    d = out / 'capture'; present = _trusted_tree(d)
    cb = read_once(d / 'capture.json'); rec = json.loads(cb); res = json.loads(read_once(d / 'result.json'))
    mode = rec.get('mode')
    if rec.get('format') != FORMAT or res.get('format') != FORMAT or mode not in MODULES or not re.fullmatch(r'[0-9a-f]{32}', str(rec.get('captureId'))):
        refuse('record', 'not a capture record of this format')
    if res.get('captureSha256') != sha(cb) or res.get('captureId') != rec['captureId']:
        refuse('binding', 'result.json does not bind this capture.json')
    files = rec.get('files') or {}
    if present != set(files) | RECORDS:
        refuse('file_set', f'unexpected or missing files: {sorted(present ^ (set(files) | RECORDS))[:6]}')
    for rel, f in files.items():
        if sha(read_once(d / rel, CAP_BIN)) != f['sha256']:
            refuse('tampered', f'{rel} differs from its capture-time hash')
    want = {f'code/{r}': h for r, h in pins.modules[mode].items()}
    want['code/l1_authority.py'] = pins.l1_authority
    for rel, h in want.items():
        if (files.get(rel) or {}).get('sha256') != h:
            refuse('code_pin', f'{rel} did not run as the reviewed bytes')
    if (files.get('code/deps/package-lock.json') or {}).get('sha256') != pins.lock or (files.get('code/deps/package.json') or {}).get('sha256') != sha(DEPS_PACKAGE_JSON):
        refuse('deps_pin', 'the dependency lock/root is not the pinned one')
    for name, (ver, digest) in pins.deps.items():
        pre = f'code/deps/node_modules/{name}/'
        if tree_rows({k[len(pre):]: f['sha256'] for k, f in files.items() if k.startswith(pre)}) != digest:
            refuse('deps_pin', f'{name} did not run as the pinned content')
    if any(k.startswith('code/deps/node_modules/') and not any(k.startswith(f'code/deps/node_modules/{n}/') for n in pins.deps) for k in files):
        refuse('deps_pin', 'an unpinned package was present in the executed dependency root')
    if res.get('a1Exit') != 0 or res.get('processStopped') is not True or res.get('copiesBeforeExec') is not True or res.get('copiesAfterRun') is not True or 'error' in res:
        refuse('run', f'not a clean run: exit {res.get("a1Exit")}, stopped {res.get("processStopped")}, error {res.get("error")}')
    hs = res.get('heliosStatus') or {}
    if hs.get('verdict') != 'fresh-finalized' or hs.get('binarySha256') != pins.helios:
        refuse('helios', 'Helios was not the pinned binary at a fresh-finalized status')
    for n in ('evidence.json', 'a1.stderr', 'helios.out'):
        if res.get(n.replace('.', '_') + 'Sha256') != sha(read_once(d / n, CAP_BIN)):
            refuse('tampered', f'{n} differs from result.json')
    # the run inputs are re-derived from the bound copies: nothing else could have been executed under these names
    if rec.get('outPath') != str(out) or not re.fullmatch(r'\.partial-[0-9]+', str(rec.get('stageName'))):
        refuse('moved', 'verify the capture in place: OUT differs from the path it was captured at')
    stage_cp = out / rec['stageName'] / 'inputs/l1-checkpoint.json'
    l1d = derive_l1_config(read_once(d / 'inputs/l1-authority-config.json'), stage_cp)
    if json.loads(read_once(d / 'inputs/l1-authority-config.derived.json')) != json.loads(l1d):
        refuse('derivation', 'the l1-authority config that ran is not the derivation of the bound copy')
    lc = json.loads(read_once(d / 'inputs/l1-authority-config.json'))
    if (lc.get('binary') or {}).get('sha256') != pins.helios:
        refuse('helios_pin', 'the bound l1-authority config pins another Helios binary')
    hurl = f"http://{(lc.get('listen') or {}).get('ip')}:{(lc.get('listen') or {}).get('port')}"
    a1c = json.loads(read_once(d / 'inputs/a1-config.json'))
    ex = read_once(d / 'inputs/a1-config.example.json') if mode == 'initial' else None
    if a1c != json.loads(derive_a1_config(mode, ex, read_once(d / 'inputs/portal-result.json'), hurl, a1c.get('elUrl'), pins)):
        refuse('derivation', 'the A1 config that ran is not the derivation of the bound template and portal read')
    if mode == 'initial' and (files.get('inputs/a1-config.example.json') or {}).get('sha256') != pins.a1_example:
        refuse('a1_example_pin', 'another A1 template was bound')
    initial = read_once(d / 'inputs/initial-a1-evidence.json') if mode == 'recheck' else None
    if mode == 'recheck' and sha(initial) != pins.initial:
        refuse('initial_pin', 'the recheck ran against another initial receipt')
    sp = str(out / rec['stageName'])
    if rec['argv'] != {'helios': [rec['python']['executable'], '-I', f'{sp}/code/l1_authority.py', 'run', f'{sp}/inputs/l1-authority-config.derived.json'],
                       'a1': [f'{sp}/bin/node', f'{sp}/code/{ENTRY[mode]}', f'{sp}/inputs/a1-config.json'] + ([f'{sp}/inputs/initial-a1-evidence.json'] if mode == 'recheck' else [])} \
            or rec['env'] != {'a1': {'ANCHOR_DEPS_ROOT': f'{sp}/code/deps', 'PATH': '/usr/bin:/bin'}}:
        refuse('argv', 'the recorded processes did not execute exactly the bound copies')
    ev = read_once(d / 'evidence.json')
    e = json.loads(ev)
    if not _utc(rec['startedAt'], 'startedAt') <= _utc(e.get('at'), 'evidence at') <= _utc(res['finishedAt'], 'finishedAt'):
        refuse('window', 'the receipt time lies outside its capture window')
    summary = gate(ev, mode, initial, node, pins, workdir) if run_gate else None
    return {'captureId': rec['captureId'], 'captureSha256': sha(cb), 'mode': mode, 'evidenceSha256': sha(ev), 'startedAt': rec['startedAt'],
            'finishedAt': res['finishedAt'], 'node': files['bin/node'], 'python': rec['python'], 'boundInputs': {k: v['sha256'] for k, v in files.items() if k.startswith('inputs/')},
            'gate': summary}


def admit(summary, ledger):
    """consumer-side replay refusal: a capture id or evidence hash is admitted at most once (ledger: set of strings)"""
    keys = {'capture:' + summary['captureId'], 'evidence:' + summary['evidenceSha256'], 'record:' + summary['captureSha256']}
    if keys & ledger:
        refuse('replayed', 'this capture (or its evidence) was already admitted')
    ledger |= keys
    return summary


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    try:
        if len(argv) == 4 and argv[1] == 'capture':
            ok, res = capture(argv[2], argv[3]); print(json.dumps({'ok': ok, **{k: v for k, v in res.items() if k != 'heliosStatus'}})); return 0 if ok else 1
        if len(argv) == 3 and argv[1] == 'verify':
            print(json.dumps({'ok': True, **verify(argv[2])})); return 0
    except Refused as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(__doc__); return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
