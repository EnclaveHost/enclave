"""Shared rig for the REAL-binary tests: the official reth v2.8.0 under `l1pair.py run-el` (via run_side.py, which runs
the canonical config exactly as the unit would, with test paths/ports substituted after validation), plus helpers.
Everything runs inside a network-denied namespace (loopback only) with an empty datadir under $SCRATCH."""
import base64, copy, hashlib, hmac, http.client, importlib.util, json, os, re, secrets, signal, socket, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
spec = importlib.util.spec_from_file_location('l1pair', PKG / 'l1pair.py')
L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
sys.path.insert(0, str(HERE))
from test_l1pair import good  # noqa: E402


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def listeners():
    out = set()
    for f, v6 in (('/proc/net/tcp', False), ('/proc/net/tcp6', True)):
        try:
            rows = Path(f).read_text().splitlines()[1:]
        except OSError:
            continue
        for r in rows:
            p = r.split()
            if p[3] != '0A':
                continue
            a, port = p[1].rsplit(':', 1)
            ip = ('v6:' + a) if v6 else '.'.join(str(int(a[i:i + 2], 16)) for i in (6, 4, 2, 0))
            out.add((ip, int(port, 16)))
    return out


def jwt_token(secret_hex, iat=None):
    """Engine API JWT (HS256 over {"iat"}), per the execution-apis authentication spec; stdlib HMAC only."""
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=')
    head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    body = b64(json.dumps({'iat': int(iat if iat is not None else time.time())}, separators=(',', ':')).encode())
    sig = b64(hmac.new(bytes.fromhex(secret_hex), head + b'.' + body, hashlib.sha256).digest())
    return (head + b'.' + body + b'.' + sig).decode()


def engine_call(port, token, method='engine_exchangeCapabilities', params=None):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        h = {'Content-Type': 'application/json'}
        if token:
            h['Authorization'] = 'Bearer ' + token
        conn.request('POST', '/', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method,
                                              'params': params if params is not None else [['engine_newPayloadV4', 'engine_forkchoiceUpdatedV3']]}), h)
        r = conn.getresponse()
        return r.status, r.read(1 << 16).decode(errors='replace')
    finally:
        conn.close()


def rpc_raw(port, method, params):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        conn.request('POST', '/', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}), {'Content-Type': 'application/json'})
        return json.loads(conn.getresponse().read(16 << 20))
    finally:
        conn.close()


class RethRig:
    def __init__(self, reth_bin, scratch, mutate=None, seam=None):
        self.tmp = Path(tempfile.mkdtemp(prefix='l1el-', dir=scratch))
        mnt = self.tmp / 'mnt'; mnt.mkdir(); os.chmod(mnt, 0o700)
        (self.tmp / 'run').mkdir()
        secret = secrets.token_hex(32)               # generated locally, test-only, deleted with the scratch dir
        jwt = self.tmp / 'jwt.hex'; jwt.write_text(secret + '\n'); os.chmod(jwt, 0o600)
        c = L.validate(good())
        c['execution']['binary']['path'] = str(reth_bin)
        c['storage']['mountPoint'] = str(mnt)
        c['execution']['datadir'] = str(mnt / 'data' / 'el')
        c['consensus']['datadir'] = str(mnt / 'data' / 'cl')
        c['engineAuthPath'] = str(jwt)
        c['execution']['httpPort'], c['execution']['authPort'] = free_port(), free_port()
        c['consensus']['httpPort'] = free_port()
        c['p2p'].update(executionPort=free_port(), executionDiscv5Port=free_port())
        c['limits'].update(readyTimeoutSec=240, stopTimeoutSec=120)
        if mutate:
            mutate(c)
        self.c, self.secret = c, secret
        self.cfg = self.tmp / 'canonical.json'; self.cfg.write_text(json.dumps(c))
        self.before = listeners()
        self.log = open(self.tmp / 'el.log', 'w')
        self.t0 = time.monotonic()
        self.proc = subprocess.Popen([sys.executable, '-I', str(HERE / 'run_side.py'), str(self.cfg), 'el'] + (['--seam=' + json.dumps(seam)] if seam else []),
                                     env={'PATH': '/usr/bin:/bin', 'RUNTIME_DIRECTORY': str(self.tmp / 'run')},
                                     stdout=self.log, stderr=subprocess.STDOUT)

    def wait_ready(self, timeout=240):
        st = self.tmp / 'run' / 'status.json'
        while time.monotonic() - self.t0 < timeout and self.proc.poll() is None:
            try:
                if json.loads(st.read_text()).get('ready'):
                    return round(time.monotonic() - self.t0, 1)
            except (OSError, ValueError):
                pass
            time.sleep(0.25)
        return None

    def stop(self):
        t = time.monotonic()
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
        rc = self.proc.wait(180)
        self.log.close()
        return rc, round(time.monotonic() - t, 2)

    def text(self):
        return (self.tmp / 'el.log').read_text(errors='replace')

    def du(self):
        files = [f for f in (self.tmp / 'mnt').rglob('*') if f.is_file()]
        return {'apparent': sum(f.stat().st_size for f in files), 'allocated': sum(f.stat().st_blocks * 512 for f in files), 'files': len(files)}


class ClRig:
    """The VERIFIED official lighthouse v8.3.2 under `l1pair.py run-cl` (via run_side.py), sharing the reth rig's canonical
    config (engine port). `extra` is the labelled test seam appended to the rendered argv; `jwt` overrides the engine
    secret file (counter-control)."""
    def __init__(self, el, lh_bin, name, extra=(), jwt=None, mode='resume'):
        self.tmp = el.tmp / name
        (self.tmp / 'run').mkdir(parents=True)
        c = copy.deepcopy(el.c)
        c['consensus']['binary']['path'] = str(lh_bin)
        c['consensus']['datadir'] = str(Path(c['storage']['mountPoint']) / 'data' / name)
        c['consensus']['checkpoint'] = {'mode': mode}
        c['consensus']['httpPort'] = free_port()
        c['p2p'].update(consensusPort=free_port(), consensusQuicPort=free_port())
        if jwt:
            c['engineAuthPath'] = str(jwt)
        self.c = c
        self.cfg = self.tmp / 'canonical.json'; self.cfg.write_text(json.dumps(c))
        self.before = listeners()
        self.log = open(self.tmp / 'cl.log', 'w')
        self.t0 = time.monotonic()
        self.proc = subprocess.Popen([sys.executable, '-I', str(HERE / 'run_side.py'), str(self.cfg), 'cl', *extra],
                                     env={'PATH': '/usr/bin:/bin', 'RUNTIME_DIRECTORY': str(self.tmp / 'run')},
                                     stdout=self.log, stderr=subprocess.STDOUT)

    wait_ready = RethRig.wait_ready
    stop = RethRig.stop

    def text(self):
        return re.sub(r'\x1b\[[0-9;]*m', '', (self.tmp / 'cl.log').read_text(errors='replace'))
