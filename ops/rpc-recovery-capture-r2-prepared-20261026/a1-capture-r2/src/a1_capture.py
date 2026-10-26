#!/usr/bin/env python3
"""a1_capture.py r2: CAPTURE-BOUND A1 runner and verifier (a1-capture-binding-stage/r2, PREPARED; NOT run; not enabled).

r1 (../src/a1_capture.py f1c9ca5c, FROZEN; root run root-a1-capture-0232: 24/25, the one error a test-fixture defect) plus:
  - an ACCEPTED-RUNTIME policy: the node binary that executes and the interpreter running this file (executable AND the
    mapped libpython) must be one of the OPERATOR-OBSERVED identities below, else refuse (capture and verify);
  - node is executed only from an fd whose bytes were hashed (verifier's gate) or from the private 0500 copy (capture);
  - explicit durability: every published file is fsynced after its final write and mode change, every directory after its
    entries, OUT's parent after the exclusive mkdir, OUT after the publishing rename;
  - mode `recheck-capture`: an original-game recheck of a NEWLY CAPTURED initial receipt. The initial is never a hash from
    config: it is a capture this module verifies, and the CONSUMER must name (from its own reviewed record) the exact
    initial capture it accepts (expected capture.json sha256). Mode `recheck` (the one pinned initial b9a90847) is unchanged.
Reused unchanged: the reviewed A1 modules, l1_authority.py and the pinned A1 gate; the cryptographic checks are theirs.

  capture  python3 -I a1_capture.py capture initial|recheck OUT
           python3 -I a1_capture.py capture recheck-capture OUT INITIAL_OUT
  verify   python3 -I a1_capture.py verify OUT [INITIAL_OUT EXPECTED_INITIAL_CAPTURE_SHA256]   (the last two for recheck-capture)

Threat model (unchanged, stated, not exceeded): root and the host are trusted to run THIS runner honestly. The binding records
which reviewed bytes an honest run executed and detects later replacement of copies, records or evidence. It gives NO
resistance to a malicious root (no attestation). Runtime acceptance is by executable-image hash only: shared libraries
(node: libuv, OpenSSL, ICU, ...; python: its stdlib and extension modules) are NOT pinned.
"""
import base64, dataclasses, datetime, hashlib, json, os, pathlib, re, secrets, shutil, signal, stat, subprocess, sys, tempfile, time

W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo'); P = W / 'work/rpc-production-final-20261025'
O = W / 'outputs/rpc-production-final-20261025'; HERE = pathlib.Path(__file__).resolve().parent.parent
OPS = P / 'source/ops/rpc-backend-bootstrap/2026-10-25'
FORMAT = 'enclave-a1-capture/v2'
OWNER = 0
CAP_FILE, CAP_BIN = 1 << 20, 512 << 20

# ---- reviewed code pins (published SHA256SUMS of l1-anchor-a1 and a1-original-game-prepared; harness RECHECK_INPUT_PINS) ----
_RECHECK = {'a1-recheck-read.mjs': '41b83975e96fc816bd5743e56626dd309aa7f0ee03c6efb9912788eb184a7715',
            'a1-recheck.mjs': 'f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8',
            'a1-read.mjs': 'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8',
            'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d',
            'vendor/anchor-bootstrap.mjs': '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8',
            'test/deps.mjs': 'b7b08e8e2ddc55f68e7c9cf1e9cea7a99ce4ce8598270cdc8497a8a4f9cec6c4'}
MODULES = {
    'initial': {'a1-read.mjs': 'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8',
                'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d',
                'vendor/anchor-bootstrap.mjs': '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8',
                'test/deps.mjs': 'b7b08e8e2ddc55f68e7c9cf1e9cea7a99ce4ce8598270cdc8497a8a4f9cec6c4'},
    'recheck': dict(_RECHECK), 'recheck-capture': dict(_RECHECK)}
ENTRY = {'initial': 'a1-read.mjs', 'recheck': 'a1-recheck-read.mjs', 'recheck-capture': 'a1-recheck-read.mjs'}
RECHECKS = ('recheck', 'recheck-capture')
L1_AUTHORITY_SHA256 = 'f4a5160b131f4d6880eaabc5f7ba70cb1447c7ad7dc39b30ed881a18212e8f12'
HELIOS_SHA256 = 'cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0'
A1_EXAMPLE_SHA256 = '2eeadf2457f108de71ea8199724e36dbc58f805b2afa74d23f904a2219774270'
INITIAL_SHA256 = 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'           # mode `recheck` only
LOCK_SHA256 = '9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20'
# closure of @noble/hashes + viem in that lock; content digest (tree_rows over read_package) of the INSTALLED tree observed
# 2026-10-25 at source/node_modules -> work/enclave/node_modules. An observation of what is installed, not an upstream review.
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
# ---- ACCEPTED RUNTIME (OPERATOR-OBSERVED; provenance stated, NOT upstream-verified) ----------------------------------------
# Observed by Claude on the root host 2026-10-25: sha256 of the file bytes, owning package from the pacman database. No
# signature, reproducible build or upstream checksum was checked: these are pending ROOT REVIEW and are the ONLY accepted
# runtimes. Any other node/python image refuses. Shared libraries are not covered (module docstring).
OBSERVED = 'operator-observed 2026-10-25 (sha256 of the file; pacman owner); NOT upstream-verified; pending root review'
ACCEPTED_NODE = {'7af789e55afc0975d66bb19ccbc5a3b60c4b838f61d1ec10a117832ba70baaf9':
                 {'path': '/usr/bin/node', 'package': 'nodejs-lts-jod 22.23.3-2', 'size': 56530480, 'provenance': OBSERVED}}
ACCEPTED_PYTHON = {'375532f83be620283ab780c14ca6bcc5907dc379d2b621de0c5d0a112cf5458b':
                   {'path': '/usr/bin/python3.14', 'package': 'python 3.14.8-1', 'size': 14424, 'provenance': OBSERVED}}
ACCEPTED_LIBPYTHON = {'0a5be42fd90e91b9d96010310ac288037a001fe7aa582345cda4e37d15a01500':
                      {'path': '/usr/lib/libpython3.14.so.1.0', 'package': 'python 3.14.8-1', 'size': 6344456, 'provenance': OBSERVED}}
MAINNET = {'portal': '0x49048044d57e1c92a77f79988d21fa8faf74e97e', 'asr': '0x909f6cf47ed12f010a796527f562bfc26c7f4e72'}
RECHECK_ORIGINAL = {'originalGame': '0x343b3a99527af07d2cfb2652747b9e37715e21ac', 'originalN': '52866960',
                    'originalOutputRoot': '0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700'}
A1_GATE_PINS = {'a1-gate.mjs': '06cc29612d1d380e91c932dc13ed676e153c8aab368103eac673c4004409414c',
                'a1-recheck.mjs': 'f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8',
                'a1-anchor.mjs': 'ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d'}


@dataclasses.dataclass
class Sources:
    initial_dir: pathlib.Path = OPS / 'l1-anchor-a1'
    recheck_dir: pathlib.Path = OPS / 'a1-original-game-prepared'
    l1_authority: pathlib.Path = P / 'finality-stage/l1-authority/l1_authority.py'
    l1_config: pathlib.Path = O / 'l1-authority-live-1941/config.json'
    portal_result: pathlib.Path = O / 'l1-proof-window/retest-30s/portal-result.json'
    initial_receipt: pathlib.Path = OPS / 'l1-anchor-a1/live-1958/a1-evidence.json'     # mode `recheck` only
    initial_capture: pathlib.Path = None                                                   # mode `recheck-capture` only
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
    node_accepted: dict = dataclasses.field(default_factory=lambda: ACCEPTED_NODE)
    python_accepted: dict = dataclasses.field(default_factory=lambda: ACCEPTED_PYTHON)
    libpython_accepted: dict = dataclasses.field(default_factory=lambda: ACCEPTED_LIBPYTHON)


class Refused(Exception):
    def __init__(self, code, why):
        super().__init__(f'{code}: {why}'); self.code = code


def refuse(code, why):
    raise Refused(code, why)


sha = lambda b: hashlib.sha256(b).hexdigest()
utcnow = lambda: datetime.datetime.now(datetime.timezone.utc)
H32, ADDR, DEC = re.compile(r'0x[0-9a-f]{64}'), re.compile(r'0x[0-9a-f]{40}'), re.compile(r'[1-9][0-9]*')


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


def fsync_dir(d):
    fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(p, b, mode=0o400):
    """exclusive create; content, then mode, then fsync of the file; new parent directories are fsynced by publish()"""
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        v = memoryview(b)
        while v:
            v = v[os.write(fd, v):]
        os.fchmod(fd, mode); os.fsync(fd)
    finally:
        os.close(fd)


def seal(p):
    """a file another process wrote (evidence, stderr, Helios log): final mode, then fsync of content+mode, then its bytes"""
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fchmod(fd, 0o400); os.fsync(fd)
    finally:
        os.close(fd)
    return read_once(p, CAP_BIN)


def tree_rows(files):
    return hashlib.sha256(('\n'.join(f'{r} {h}' for r, h in sorted(files.items())) + '\n').encode()).hexdigest()


def read_package(root, name):
    base = pathlib.Path(root, 'node_modules', name); out = {}
    for d, ds, fs in os.walk(base):
        ds[:] = sorted(x for x in ds if x != 'node_modules')
        for x in ds:
            if os.path.islink(os.path.join(d, x)):
                refuse('deps', f'{name}: symlinked directory {x}')
        for f in sorted(fs):
            out[os.path.relpath(os.path.join(d, f), base)] = read_once(os.path.join(d, f), CAP_BIN)
    return out


def python_identity(pins):
    """the RUNNING interpreter: its executable image and the libpython actually mapped into this process, both accepted"""
    exe = os.path.realpath(sys.executable); xs = sha(read_once(exe, CAP_BIN))
    libs = sorted({l.split()[-1] for l in pathlib.Path('/proc/self/maps').read_text().splitlines() if 'libpython' in l and '/' in l})
    if len(libs) != 1:
        refuse('python_identity', f'expected exactly one mapped libpython, found {libs}')
    ls = sha(read_once(libs[0], CAP_BIN))
    if xs not in pins.python_accepted or ls not in pins.libpython_accepted:
        refuse('python_identity', f'the interpreter ({exe} {xs[:12]}, {libs[0]} {ls[:12]}) is not an accepted runtime')
    return {'executable': exe, 'sha256': xs, 'libpython': libs[0], 'libpythonSha256': ls, 'version': sys.version}


def run_node_fd(node, pins, argv, **kw):
    """execute node from an fd whose bytes were hashed and accepted (no path re-resolution between hash and exec)"""
    fd = os.open(os.path.realpath(node), os.O_RDONLY | os.O_CLOEXEC)
    try:
        h = hashlib.sha256()
        while (b := os.read(fd, 1 << 20)):
            h.update(b)
        if h.hexdigest() not in pins.node_accepted:
            refuse('node_identity', f'node {node} ({h.hexdigest()[:12]}) is not an accepted runtime')
        os.lseek(fd, 0, 0)
        return subprocess.run([f'/proc/self/fd/{fd}', *argv], pass_fds=(fd,), **kw)
    finally:
        os.close(fd)


def derive_l1_config(orig_bytes, checkpoint_path):
    c = json.loads(orig_bytes)
    if not isinstance(c, dict) or 'checkpointFile' not in c:
        refuse('l1_config', 'the l1-authority config has no checkpointFile')
    d = dict(c); d['checkpointFile'] = str(checkpoint_path)
    if {k: v for k, v in d.items() if k != 'checkpointFile'} != {k: v for k, v in c.items() if k != 'checkpointFile'}:
        refuse('l1_config', 'derivation changed more than checkpointFile')
    return json.dumps(d, indent=2, sort_keys=True).encode()


def original_of(initial_gate, evidence_sha):
    """recheck-capture: the ORIGINAL game/N/root come from the verified initial capture's GATE-normalized receipt, never config"""
    g = initial_gate or {}
    o = {'originalGame': str(g.get('game', '')).lower(), 'originalN': str(g.get('N', '')), 'originalOutputRoot': str(g.get('outputRoot', '')).lower()}
    if not ADDR.fullmatch(o['originalGame']) or not DEC.fullmatch(o['originalN']) or not H32.fullmatch(o['originalOutputRoot']) or not re.fullmatch(r'[0-9a-f]{64}', evidence_sha):
        refuse('initial_binding', 'the initial capture does not name a game/N/output root')
    return {**o, 'initialEvidenceSha256': evidence_sha}


def derive_a1_config(mode, example_bytes, portal_bytes, helios_url, el_url, pins, original=None):
    """the reviewed runners' derivation (run.py / run-recheck.py), from the COPIES; recheck-capture takes `original` from
    original_of(); the verifier recomputes it"""
    proven = json.loads(portal_bytes)
    if proven.get('readSucceeded') is not True or str(proven.get('asr', '')).lower() != pins.asr:
        refuse('portal_result', 'portal-result.json is not a succeeded verified getter read naming the pinned ASR')
    if mode == 'initial':
        cfg = json.loads(example_bytes); cfg.pop('_notes', None)
        cfg['heliosUrl'] = helios_url; cfg['asr'] = proven['asr']; cfg['maxFinalizedAgeSec'] = 1800
        cfg['asrCandidates'] = list(cfg.get('asrCandidates', [])) + [{'address': proven['asr'], 'provenance': 'root Helios-verified portal getter at ' + str((proven.get('block') or {}).get('hash'))}]
    else:
        orig = {**RECHECK_ORIGINAL, 'initialEvidenceSha256': pins.initial} if mode == 'recheck' else original
        if not orig:
            refuse('initial_binding', 'recheck-capture needs the verified initial capture')
        cfg = {'heliosUrl': helios_url, 'elUrl': el_url, 'expectedChainId': 1, 'pinBy': 'hash', 'portal': pins.portal, 'asr': pins.asr,
               'portalAsrGetter': 'anchorStateRegistry()', 'maxFinalizedAgeSec': 1800, **orig}
    if str(cfg.get('portal', '')).lower() != pins.portal or str(cfg.get('asr', '')).lower() != pins.asr or cfg.get('expectedChainId') != 1:
        refuse('a1_config', 'derived A1 config does not name the pinned mainnet portal/ASR/chain')
    return json.dumps(cfg, indent=2, sort_keys=True).encode()


def load_module(path, name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def publish(stage, out):
    """crash-safe publication: every directory fsynced bottom-up, then ONE rename into a fresh name inside the exclusive OUT,
    then OUT fsynced. Before the rename completes, OUT holds only .partial-<pid> and never verifies."""
    for d, _, _ in os.walk(stage, topdown=False):
        fsync_dir(d)
    os.rename(stage, out / 'capture'); fsync_dir(out)


def capture(mode, out, src=None, pins=None, hooks=None, helios_timeout=90, a1_timeout=240, gate_fn=None):
    src, pins, hooks = src or Sources(), pins or Pins(), hooks or {}
    if mode not in MODULES:
        refuse('mode', 'mode is initial, recheck or recheck-capture')
    out = pathlib.Path(out)
    os.mkdir(out, 0o700); fsync_dir(out.parent)                      # EXCLUSIVE and durable before anything else
    stage = out / f'.partial-{os.getpid()}'; os.mkdir(stage, 0o700); fsync_dir(out)
    files, rec, res, helios = {}, None, {'format': FORMAT}, None

    def put(rel, b, role, source, mode_bits=0o400):
        write_new(stage / rel, b, mode_bits); files[rel] = {'sha256': sha(b), 'size': len(b), 'role': role, 'source': str(source)}
        return stage / rel
    try:
        py = python_identity(pins)                                     # the interpreter running this capture
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
        if sha(nb) not in pins.node_accepted:
            refuse('node_identity', f'node {os.path.realpath(src.node)} ({sha(nb)[:12]}) is not an accepted runtime')
        node = put('bin/node', nb, 'node', os.path.realpath(src.node), 0o500)
        l1b = read_once(src.l1_config)
        put('inputs/l1-authority-config.json', l1b, 'l1-config', src.l1_config)
        cpb = read_once(json.loads(l1b)['checkpointFile'])
        cp = put('inputs/l1-checkpoint.json', cpb, 'l1-checkpoint', json.loads(l1b)['checkpointFile'])
        l1d = put('inputs/l1-authority-config.derived.json', derive_l1_config(l1b, cp), 'l1-config-derived', '(derived)')
        L = load_module(l1a, 'l1_authority_copy')
        c = L.load_config(str(l1d))
        if c['cfg']['binary']['sha256'] != pins.helios:
            refuse('helios_pin', 'the l1-authority config pins another Helios binary')
        helios_url = f"http://{c['listenIp']}:{c['listenPort']}"
        pb = read_once(src.portal_result)
        put('inputs/portal-result.json', pb, 'portal-result', src.portal_result)
        eb, original, initial_capture = None, None, None
        if mode == 'initial':
            eb = read_once(src.initial_dir / 'a1-config.example.json')
            if sha(eb) != pins.a1_example:
                refuse('a1_example_pin', 'a1-config.example.json is not the reviewed template')
            put('inputs/a1-config.example.json', eb, 'a1-template', src.initial_dir / 'a1-config.example.json')
        elif mode == 'recheck':
            ib = read_once(src.initial_receipt)
            if sha(ib) != pins.initial:
                refuse('initial_pin', 'the initial receipt is not the pinned one')
            put('inputs/initial-a1-evidence.json', ib, 'initial-receipt', src.initial_receipt)
        else:
            if src.initial_capture is None:
                refuse('initial_binding', 'recheck-capture needs INITIAL_OUT (a verified initial capture)')
            ini = verify(src.initial_capture, pins=pins, node=src.node, workdir=str(out), gate_fn=gate_fn)
            if ini['mode'] != 'initial':
                refuse('initial_binding', 'INITIAL_OUT is not an initial capture')
            ib = read_once(pathlib.Path(src.initial_capture, 'capture/evidence.json'))
            if sha(ib) != ini['evidenceSha256']:
                refuse('initial_binding', 'the initial evidence changed after its verification')
            put('inputs/initial-a1-evidence.json', ib, 'initial-receipt-captured', pathlib.Path(src.initial_capture, 'capture/evidence.json'))
            original = original_of(ini['gate'], ini['evidenceSha256'])
            initial_capture = {'outPath': str(src.initial_capture), 'captureId': ini['captureId'], 'captureSha256': ini['captureSha256'],
                               'evidenceSha256': ini['evidenceSha256'], 'original': original}
        a1c = put('inputs/a1-config.json', derive_a1_config(mode, eb, pb, helios_url, src.el_url, pins, original), 'a1-config', '(derived)')
        a1_argv = [str(node), str(stage / 'code' / ENTRY[mode]), str(a1c)] + ([str(stage / 'inputs/initial-a1-evidence.json')] if mode in RECHECKS else [])
        a1_env = {'ANCHOR_DEPS_ROOT': str(stage / 'code/deps'), 'PATH': '/usr/bin:/bin'}
        h_argv = [py['executable'], '-I', str(l1a), 'run', str(l1d)]
        rec = {'format': FORMAT, 'captureId': secrets.token_hex(16), 'mode': mode, 'startedAt': utcnow().isoformat(), 'files': files,
               'argv': {'helios': h_argv, 'a1': a1_argv}, 'env': {'a1': a1_env}, 'stageName': stage.name, 'outPath': str(out),
               'python': py, 'runtimePolicy': {'node': files['bin/node']['sha256'], 'python': py['sha256'], 'libpython': py['libpythonSha256'], 'provenance': OBSERVED},
               'pins': {'helios': pins.helios, 'lock': pins.lock}, **({'initialCapture': initial_capture} if initial_capture else {})}
        rb = json.dumps(rec, indent=1, sort_keys=True).encode()
        write_new(stage / 'capture.json', rb, 0o400); fsync_dir(stage)   # bound and durable BEFORE anything executes
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
            hooks['before_exec'](stage)
        res['copiesBeforeExec'] = rehash(stage, files)
        fo = os.open(stage / 'evidence.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        fe = os.open(stage / 'a1.stderr', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            x = subprocess.run(a1_argv, env=a1_env, stdin=subprocess.DEVNULL, stdout=fo, stderr=fe, cwd=stage / 'code', timeout=a1_timeout)
        finally:
            os.close(fo); os.close(fe)
        res['a1Exit'] = x.returncode
        if 'after_exec' in hooks:
            hooks['after_exec'](stage)
    except Refused as e:
        res['error'] = str(e)[:500]
    except Exception as e:
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
        for n in ('evidence.json', 'a1.stderr', 'helios.out'):               # child-written: mode + fsync BEFORE hashing
            if (stage / n).exists():
                res[n.replace('.', '_') + 'Sha256'] = sha(seal(stage / n))
        res['finishedAt'] = utcnow().isoformat()
        write_new(stage / 'result.json', json.dumps(res, indent=1, sort_keys=True).encode(), 0o400)
        publish(stage, out)
    ok = res.get('a1Exit') == 0 and res['processStopped'] and res.get('copiesBeforeExec') is True and res['copiesAfterRun'] is True and 'error' not in res
    return ok, res


def rehash(stage, files):
    for rel, f in files.items():
        p = pathlib.Path(stage, rel); st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode) or sha(read_once(p, CAP_BIN)) != f['sha256']:
            return False
    return True


# ---- verifier ---------------------------------------------------------------------------------------------------------
RECORDS = {'capture.json', 'result.json', 'evidence.json', 'a1.stderr', 'helios.out'}


def _trusted_tree(d):
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


def gate(evidence, mode, initial, initial_sha, node, pins, workdir):
    """the PINNED A1 gate over the exact bytes, from a private copy, executed by an ACCEPTED node from a hashed fd"""
    d = pathlib.Path(tempfile.mkdtemp(prefix='.a1gate-', dir=workdir))
    try:
        for name, want in pins.gate.items():
            b = read_once(HERE / 'a1gate' / name)
            if sha(b) != want:
                refuse('gate_pin', f'{name} differs from its pin')
            (d / name).write_bytes(b)
        i = {'mode': 'fresh-initial', 'initial': base64.b64encode(evidence).decode()} if mode == 'initial' else \
            {'mode': 'original-game-recheck', 'initial': base64.b64encode(initial).decode(), 'initialSha256': initial_sha, 'recheck': base64.b64encode(evidence).decode()}
        script = ("const g=await import(process.env.G);const fs=await import('node:fs');const i=JSON.parse(fs.readFileSync(0,'utf8'));"
                  "try{console.log(JSON.stringify({ok:true,summary:g.gate(i)}))}catch(e){console.log(JSON.stringify({ok:false,code:e.code||'error',"
                  "error:String(e.message||e).slice(0,300)}));process.exit(3)}")
        p = run_node_fd(node, pins, ['--input-type=module', '-e', script], input=json.dumps(i), capture_output=True, text=True,
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


def verify(out, pins=None, node='/usr/bin/node', workdir='/tmp', gate_fn=None, initial_out=None, expected_initial_capture_sha256=None):
    """-> summary of a CLEAN capture-bound A1 run, else Refused. Stateless: replay is the consumer's ledger (admit).
    recheck-capture: the CONSUMER passes the initial capture it reviewed (INITIAL_OUT) and its expected capture.json sha256
    from its OWN reviewed record; the recheck's own record is never the source of that expectation."""
    pins = pins or Pins(); out = pathlib.Path(out)
    gate_fn = gate_fn or (lambda ev, mode, ini, isha: gate(ev, mode, ini, isha, node, pins, workdir))
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
    if (files.get('bin/node') or {}).get('sha256') not in pins.node_accepted:
        refuse('node_identity', 'the node that executed is not an accepted runtime')
    py = rec.get('python') or {}
    if py.get('sha256') not in pins.python_accepted or py.get('libpythonSha256') not in pins.libpython_accepted:
        refuse('python_identity', 'the interpreter that ran the capture is not an accepted runtime')
    if res.get('a1Exit') != 0 or res.get('processStopped') is not True or res.get('copiesBeforeExec') is not True or res.get('copiesAfterRun') is not True or 'error' in res:
        refuse('run', f'not a clean run: exit {res.get("a1Exit")}, stopped {res.get("processStopped")}, error {res.get("error")}')
    hs = res.get('heliosStatus') or {}
    if hs.get('verdict') != 'fresh-finalized' or hs.get('binarySha256') != pins.helios:
        refuse('helios', 'Helios was not the pinned binary at a fresh-finalized status')
    for n in ('evidence.json', 'a1.stderr', 'helios.out'):
        if res.get(n.replace('.', '_') + 'Sha256') != sha(read_once(d / n, CAP_BIN)):
            refuse('tampered', f'{n} differs from result.json')
    if rec.get('outPath') != str(out) or not re.fullmatch(r'\.partial-[0-9]+', str(rec.get('stageName'))):
        refuse('moved', 'verify the capture in place: OUT differs from the path it was captured at')
    stage_cp = out / rec['stageName'] / 'inputs/l1-checkpoint.json'
    if json.loads(read_once(d / 'inputs/l1-authority-config.derived.json')) != json.loads(derive_l1_config(read_once(d / 'inputs/l1-authority-config.json'), stage_cp)):
        refuse('derivation', 'the l1-authority config that ran is not the derivation of the bound copy')
    lc = json.loads(read_once(d / 'inputs/l1-authority-config.json'))
    if (lc.get('binary') or {}).get('sha256') != pins.helios:
        refuse('helios_pin', 'the bound l1-authority config pins another Helios binary')
    hurl = f"http://{(lc.get('listen') or {}).get('ip')}:{(lc.get('listen') or {}).get('port')}"
    initial, initial_sha, init_summary, original = None, None, None, None
    if mode in RECHECKS:
        initial = read_once(d / 'inputs/initial-a1-evidence.json'); initial_sha = sha(initial)
    if mode == 'recheck' and initial_sha != pins.initial:
        refuse('initial_pin', 'the recheck ran against another initial receipt')
    if mode == 'recheck-capture':
        ic = rec.get('initialCapture') or {}
        if initial_out is None or not re.fullmatch(r'[0-9a-f]{64}', str(expected_initial_capture_sha256 or '')):
            refuse('initial_binding', 'the consumer must name the initial capture it reviewed (INITIAL_OUT + expected capture sha256)')
        if str(pathlib.Path(initial_out)) != ic.get('outPath'):
            refuse('initial_binding', 'the recheck was bound to another initial capture directory')
        init_summary = verify(initial_out, pins=pins, node=node, workdir=workdir, gate_fn=gate_fn)
        if init_summary['mode'] != 'initial':
            refuse('initial_binding', 'the bound initial capture is not an initial capture')
        if not (init_summary['captureSha256'] == expected_initial_capture_sha256 == ic.get('captureSha256')):
            refuse('initial_binding', 'the initial capture is not the one the consumer reviewed (expected capture sha256)')
        if not (init_summary['evidenceSha256'] == ic.get('evidenceSha256') == initial_sha) or init_summary['captureId'] != ic.get('captureId'):
            refuse('initial_binding', 'the recheck did not run against that initial capture\'s evidence')
        original = original_of(init_summary['gate'], initial_sha)
        if original != ic.get('original'):
            refuse('initial_binding', 'the recorded original game/N/root differ from the initial capture\'s receipt')
    a1c = json.loads(read_once(d / 'inputs/a1-config.json'))
    ex = read_once(d / 'inputs/a1-config.example.json') if mode == 'initial' else None
    if a1c != json.loads(derive_a1_config(mode, ex, read_once(d / 'inputs/portal-result.json'), hurl, a1c.get('elUrl'), pins, original)):
        refuse('derivation', 'the A1 config that ran is not the derivation of the bound template, portal read and initial')
    if mode == 'initial' and (files.get('inputs/a1-config.example.json') or {}).get('sha256') != pins.a1_example:
        refuse('a1_example_pin', 'another A1 template was bound')
    sp = str(out / rec['stageName'])
    if rec['argv'] != {'helios': [py.get('executable'), '-I', f'{sp}/code/l1_authority.py', 'run', f'{sp}/inputs/l1-authority-config.derived.json'],
                       'a1': [f'{sp}/bin/node', f'{sp}/code/{ENTRY[mode]}', f'{sp}/inputs/a1-config.json'] + ([f'{sp}/inputs/initial-a1-evidence.json'] if mode in RECHECKS else [])} \
            or rec['env'] != {'a1': {'ANCHOR_DEPS_ROOT': f'{sp}/code/deps', 'PATH': '/usr/bin:/bin'}}:
        refuse('argv', 'the recorded processes did not execute exactly the bound copies')
    ev = read_once(d / 'evidence.json'); e = json.loads(ev)
    if not _utc(rec['startedAt'], 'startedAt') <= _utc(e.get('at'), 'evidence at') <= _utc(res['finishedAt'], 'finishedAt'):
        refuse('window', 'the receipt time lies outside its capture window')
    if init_summary is not None and not _utc(init_summary['finishedAt'], 'initial finishedAt') <= _utc(rec['startedAt'], 'startedAt'):
        refuse('initial_binding', 'the recheck did not start after its initial capture finished')
    summary = gate_fn(ev, mode, initial, initial_sha)
    return {'captureId': rec['captureId'], 'captureSha256': sha(cb), 'mode': mode, 'evidenceSha256': sha(ev), 'startedAt': rec['startedAt'],
            'finishedAt': res['finishedAt'], 'node': files['bin/node'], 'python': py, 'runtimePolicy': rec.get('runtimePolicy'),
            'boundInputs': {k: v['sha256'] for k, v in files.items() if k.startswith('inputs/')}, 'gate': summary,
            **({'initialCapture': {k: init_summary[k] for k in ('captureId', 'captureSha256', 'evidenceSha256')}} if init_summary else {})}


def admit(summary, ledger):
    """consumer-side replay refusal: a capture id, evidence or record is admitted at most once (ledger: set of strings)"""
    keys = {'capture:' + summary['captureId'], 'evidence:' + summary['evidenceSha256'], 'record:' + summary['captureSha256']}
    if keys & ledger:
        refuse('replayed', 'this capture (or its evidence) was already admitted')
    ledger |= keys
    return summary


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    try:
        if argv[1:2] == ['capture'] and (len(argv) == 4 and argv[2] in ('initial', 'recheck') or len(argv) == 5 and argv[2] == 'recheck-capture'):
            src = Sources(initial_capture=pathlib.Path(argv[4]) if len(argv) == 5 else None)
            ok, res = capture(argv[2], argv[3], src=src); print(json.dumps({'ok': ok, **{k: v for k, v in res.items() if k != 'heliosStatus'}})); return 0 if ok else 1
        if argv[1:2] == ['verify'] and len(argv) in (3, 5):
            print(json.dumps({'ok': True, **verify(argv[2], initial_out=argv[3] if len(argv) == 5 else None,
                                                    expected_initial_capture_sha256=argv[4] if len(argv) == 5 else None)})); return 0
    except Refused as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(__doc__); return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
