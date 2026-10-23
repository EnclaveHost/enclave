#!/usr/bin/env python3
"""Root-run SNP startup-recovery canary: ONE disposable quote-only custodian guest, booted three times on the same
fresh, canary-only sealed state.
  1 fresh  - new isolated state dir; the guest seals a new identity; fresh AMD-verified quote.
  2 fault  - the canary host COPY answers GET /state with 503; the guest must refuse: never HTTP-ready, no PUT,
             sealed state bytes unchanged.
  3 reopen - fault cleared; the guest must reopen the SAME identity and encKey; fresh AMD-verified quote.
Startup-recovery evidence only. Never a production activation: no registry/submitter key, committee, genesis, operator,
secret or production state. Root allocation unchanged: 3072 MiB guest, exclusive 5120 MiB scope + tree cap, both shared
queue lanes, 16384 MiB reserve + 1024 MiB margin. Root only runs this.
  python3 canary/recovery_canary.py --dist D --repo R --expected-commit C --expected-host-sha256 H --expected-copy-sha256 K
                                    --expected-measurement M --expected-manifest-sha256 S
"""
import argparse, datetime, fcntl, hashlib, json, os, pathlib, re, shutil, signal, stat, subprocess, sys, time
import urllib.error, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
HARNESS = HERE.parent
RUNS = HARNESS / 'runs'
WORK = HARNESS.parent
OVMF = pathlib.Path('/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd')
MEMORY_GUARD = WORK / 'enclave/test/helpers/memory-guard.mjs'
REVIEWED_CANARY = WORK / 'custody-v2-release-20261023/canary'
REVIEWED = {  # the reviewed quote-only canary's helpers, used unchanged
    REVIEWED_CANARY / 'verify-custodian-quote.mjs': '5acfa74a659c95cf7706a783558f8d0bf392d7588d99940e05876d7e26050579',
    REVIEWED_CANARY / 'headroom-check.sh': '5ba4bf3ccdd30e8712b98e97cdbcec654bfbb48392919bce067be797aa7010f7',
}
VERIFIER, HEADROOM = list(REVIEWED)
INJECT_FILE = HERE / 'fault-inject.mjs.txt'
REGISTER = HERE / 'resolve-register.mjs'
HOOK = HERE / 'resolve-as-original.mjs'
HOST_PORT, MGMT_PORT = 18970, 18971
GUEST_MIB, CAP_MIB, RESERVE_MIB, MARGIN_MIB = 3072, 5120, 16384, 1024
ENDPOINT = 'https://custody-recovery-canary.invalid'
CHILD_TIMEOUT_S, READY_S, VERIFY_S, FAULT_FIRST_S, FAULT_HOLD_S = 1080, 240, 65, 240, 45
TERM_GRACE_S, KILL_GRACE_S = 8, 5
PHASES = ('fresh', 'fault', 'reopen')
FAULT = 'get-503'
MARKER = 'CANARY-ONLY STATE-STORE FAULT INJECTION'
# The state server's opening and its GET /state line, exactly as in a5eae96c custody/v2/host.mjs. The fault lines go
# between `try {` and the GET line, once.
ANCHOR_HEAD = ('const srv = http.createServer(async (req, res) => {\n'
    '  const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };\n'
    '  try {\n')
ANCHOR_GET = '    if (req.url === "/state" && req.method === "GET") return fs.existsSync(STATE) ? send(200, fs.readFileSync(STATE), "application/octet-stream") : send(404, { error: "none" });\n'
SERIAL_NEW = 'new custodian identity sealed'
SERIAL_OPENED = 'sealed state opened'
SERIAL_LISTEN = 'custodian-v2 on :8787'
SERIAL_REFUSED = 'sealed state read failed: HTTP 503'
SERIAL_RESTART = 'custodian exited code=1'
HEX64, HEX96, HEX40 = re.compile(r'^[0-9a-f]{64}$'), re.compile(r'^[0-9a-f]{96}$'), re.compile(r'^[0-9a-f]{40}$')
RUN_NAME = re.compile(r'^\d{8}T\d{6}Z$')


class CanaryError(Exception):
    pass


def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha256(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def sha256b(data): return hashlib.sha256(data).hexdigest()


# ---------- fault transformation (pure) ----------
def transform_host(source: bytes, expected_sha256: str, inject: str) -> bytes:
    """The canary copy: the exact pinned host.mjs plus the inject lines, inserted once. Anything else refuses."""
    if not HEX64.match(expected_sha256 or ''): raise CanaryError('expected host sha256 must be 64 lowercase hex')
    if sha256b(source) != expected_sha256: raise CanaryError('host.mjs is not the pinned source')
    try: text = source.decode('utf-8')
    except UnicodeDecodeError as e: raise CanaryError('host.mjs is not UTF-8') from e
    if not inject.endswith('\n') or inject.count(MARKER) != 1 or inject.count('canaryStateFault') != 1:
        raise CanaryError('inject lines malformed')
    if MARKER in text or 'canaryStateFault' in text or 'canaryEventLog' in text: raise CanaryError('host.mjs already carries canary lines')
    anchor = ANCHOR_HEAD + ANCHOR_GET
    if text.count(anchor) != 1 or text.count(ANCHOR_GET) != 1: raise CanaryError('the state-server anchor must occur exactly once')
    out = text.replace(anchor, ANCHOR_HEAD + inject + ANCHOR_GET, 1)
    if (len(out) != len(text) + len(inject) or out.count(MARKER) != 1 or out.count(ANCHOR_HEAD + inject + ANCHOR_GET) != 1
            or out.replace(inject, '', 1) != text):
        raise CanaryError('transformation was not exactly one insertion')
    return out.encode('utf-8')


# ---------- path guards ----------
def guard_dir(path: pathlib.Path, mode=0o700):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode): raise CanaryError(f'{path}: not a real directory')
    if os.path.realpath(path) != str(path): raise CanaryError(f'{path}: path has a symlink component')
    if st.st_uid != os.getuid(): raise CanaryError(f'{path}: not owned by this user')
    if stat.S_IMODE(st.st_mode) != mode: raise CanaryError(f'{path}: mode {oct(stat.S_IMODE(st.st_mode))}, want {oct(mode)}')


def fresh_dir(path: pathlib.Path):
    """mkdir that refuses an existing path, then forces and proves 0700 (umask-independent)."""
    os.mkdir(path, 0o700)
    os.chmod(path, 0o700)
    guard_dir(path)
    if any(path.iterdir()): raise CanaryError(f'{path}: not empty')
    return path


def guard_run(run: pathlib.Path, runs: pathlib.Path = RUNS):
    if run.parent != runs or not RUN_NAME.match(run.name): raise CanaryError(f'{run}: not a canary run directory')
    guard_dir(runs); guard_dir(run)
    return run


def snapshot_state(state_dir: pathlib.Path):
    """Names, modes, sizes and sha256 of the canary state dir (contents never leave this function)."""
    guard_dir(state_dir)
    out = {}
    for e in sorted(state_dir.iterdir()):
        st = os.lstat(e)
        if not stat.S_ISREG(st.st_mode): raise CanaryError(f'{e}: not a regular file')
        out[e.name] = dict(mode=oct(stat.S_IMODE(st.st_mode)), size=st.st_size, sha256=sha256(e))
    return out


def sealed_files(snap):
    return {k: v for k, v in snap.items() if k == 'state.bin' or k.startswith('state.bin.')}


# ---------- /proc ----------
def proc_stat(pid, proc=pathlib.Path('/proc')):
    st = (proc / str(pid) / 'stat').read_text()
    rest = st[st.rfind(')') + 2:].split()
    return dict(pid=int(pid), comm=st[st.find('(') + 1:st.rfind(')')], state=rest[0], ppid=int(rest[1]), pgid=int(rest[2]),
                starttime=int(rest[19]))


def processes(proc=pathlib.Path('/proc')):
    out = []
    for p in proc.iterdir():
        if not p.name.isdigit(): continue
        try: out.append(proc_stat(p.name, proc))
        except (OSError, IndexError, ValueError): pass
    return out


def ident(p): return (p['pid'], p['starttime'])


def qemus(procs):
    return {str(p['pid']): str(p['starttime']) for p in procs if p['comm'].startswith('qemu')}


def descendants(root, procs):
    """Identities of root and its live descendants, root given as (pid, starttime); empty if root is gone."""
    byid = {p['pid']: p for p in procs}
    if root[0] not in byid or ident(byid[root[0]]) != root: return set()
    out, queue = {root}, [root[0]]
    while queue:
        pid = queue.pop()
        for p in procs:
            if p['ppid'] == pid and ident(p) not in out: out.add(ident(p)); queue.append(p['pid'])
    return out


def owned_alive(pgid, owned, procs):
    return [p for p in procs if p['pgid'] == pgid and ident(p) in owned and p['state'] != 'Z']


def stop_group(pgid, owned, *, procs, killpg, reap, monotonic=time.monotonic, sleep=time.sleep,
               term_grace=TERM_GRACE_S, kill_grace=KILL_GRACE_S):
    """Signal ONLY this group, and only while one of its members is a recorded (pid, starttime) of this phase."""
    ev = dict(signals=[])
    for sig, grace in ((signal.SIGTERM, term_grace), (signal.SIGKILL, kill_grace)):
        if not owned_alive(pgid, owned, procs()): break
        killpg(pgid, sig); ev['signals'].append(sig.name)
        deadline = monotonic() + grace
        while monotonic() < deadline:
            reap()
            if not [p for p in procs() if p['pgid'] == pgid]: break
            sleep(0.2)
    reap()
    left = [p for p in procs() if p['pgid'] == pgid]
    ev['groupEmpty'] = not left
    ev['left'] = [dict(pid=p['pid'], starttime=p['starttime'], comm=p['comm'], state=p['state']) for p in left]
    return ev


def cgroup_extra(self_pid, cg_pids, procs):
    """Members of this scope's cgroup other than this process and its ancestors inside the cgroup (timeout, guard)."""
    byid = {p['pid']: p for p in procs}
    allowed, pid = set(), self_pid
    while pid in cg_pids and pid not in allowed:
        allowed.add(pid)
        pid = byid[pid]['ppid'] if pid in byid else None
    return sorted(set(cg_pids) - allowed)


def own_cgroup():
    line = next(l for l in pathlib.Path('/proc/self/cgroup').read_text().splitlines() if l.startswith('0::'))
    return pathlib.Path('/sys/fs/cgroup' + line[3:])


def cgroup_pids(cg: pathlib.Path):
    try: return {int(x) for x in (cg / 'cgroup.procs').read_text().split()}
    except FileNotFoundError: return set()


def listening_ports(texts):
    """Ports in LISTEN state from /proc/net/tcp and tcp6 contents."""
    out = set()
    for text in texts:
        for line in text.splitlines()[1:]:
            f = line.split()
            if len(f) > 3 and f[3] == '0A': out.add(int(f[1].rsplit(':', 1)[1], 16))
    return out


def ports_in_use(ports):
    texts = []
    for name in ('tcp', 'tcp6'):
        try: texts.append(pathlib.Path('/proc/net', name).read_text())
        except FileNotFoundError: pass
    return sorted(set(ports) & listening_ports(texts))


def ancestors_and_self():
    procs = {p['pid']: p for p in processes()}
    out, pid = set(), os.getpid()
    while pid in procs and pid not in out and pid > 1: out.add(pid); pid = procs[pid]['ppid']
    return out


def run_path_survivors(run, exclude):
    out = []
    for d in pathlib.Path('/proc').iterdir():
        if not d.name.isdigit() or int(d.name) in exclude: continue
        try: cl = (d / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf8', 'replace')
        except OSError: continue
        if str(run) in cl: out.append(int(d.name))
    return out


# ---------- host event log (method, path, status only) ----------
def parse_events(text, final=False):
    lines = text.split('\n')
    if lines[-1] != '' and final: raise CanaryError('event log ends with a partial line')
    out = []
    for line in lines[:-1]:
        e = json.loads(line)
        if (not isinstance(e, dict) or e.get('ev') not in ('req', 'res') or not isinstance(e.get('method'), str)
                or not isinstance(e.get('url'), str) or (e['ev'] == 'res' and not isinstance(e.get('status'), int))):
            raise CanaryError('malformed event')
        out.append(e)
    return out


def summarize_events(events):
    def n(ev, method, url, status=None):
        return sum(1 for e in events if e['ev'] == ev and e['method'] == method and e['url'] == url and (status is None or e['status'] == status))
    gets = [e['status'] for e in events if e['ev'] == 'res' and e['method'] == 'GET' and e['url'] == '/state']
    return dict(stateGetRequests=n('req', 'GET', '/state'), stateGetStatuses=gets,
                stateGet404=gets.count(404), stateGet200=gets.count(200), stateGet503=gets.count(503),
                stateWriteRequests=sum(1 for e in events if e['ev'] == 'req' and e['url'] == '/state' and e['method'] != 'GET'),
                statePut200=n('res', 'PUT', '/state', 200), submitRequests=sum(1 for e in events if e['ev'] == 'req' and e['url'] == '/submit'),
                otherRequests=sorted({f"{e['method']} {e['url']}" for e in events if e['ev'] == 'req' and e['url'] not in ('/state', '/submit')}),
                responses503=sum(1 for e in events if e['ev'] == 'res' and e['status'] == 503))


# ---------- phase verdicts (pure) ----------
MACHINE_KEYS = ('identity', 'encKey', 'endpoint', 'chipId', 'registryId', 'measurement')


def public_identity(info):
    m = info.get('machine') or {}
    return {k: m.get(k) for k in MACHINE_KEYS}


def _boundary(ph):
    return {'stop.groupEmpty': ph['stop']['groupEmpty'] is True, 'stop.portsFree': ph['portsAfter'] == [],
            'stop.cgroupClean': ph['cgroupExtraAfter'] == [], 'stop.protectedQemusUnchanged': ph['protectedUnchanged'] is True,
            'launch.pinsReverified': ph['pinsOk'] is True, 'launch.portsFree': ph['portsBefore'] == [],
            'launch.cgroupClean': ph['cgroupExtraBefore'] == []}


def _quote(ph, measurement, info):
    v = ph.get('verdict') or {}
    obs = v.get('observed') or {}
    return {'quote.verified': ph.get('verifierExit') == 0 and v.get('ok') is True,
            'quote.measurementPinned': obs.get('measurement') == measurement,
            'quote.bindsServedMachine': bool(info) and obs.get('machine') == info.get('machine'),
            'quote.freshNonce': bool(HEX64.match(str(v.get('nonce', ''))))}


def _info_shape(info):
    m = (info or {}).get('machine') or {}
    return (info or {}).get('v') == 2 and m.get('endpoint') == ENDPOINT and m.get('identity') == info.get('identity') \
        and m.get('encKey') == info.get('encKey') and info.get('hostSig') is None and info.get('epochs') == []


def verdict_fresh(ph, measurement):
    ev, serial, info = ph['events'], ph['serial'], ph.get('info')
    r = {'fresh.stateAbsentAtLaunch': ph['stateBefore'] == {},
         'fresh.firstStateGet404': ev['stateGetStatuses'][:1] == [404],
         'fresh.identitySealedByPut': ev['statePut200'] >= 1,
         'fresh.no503': ev['responses503'] == 0, 'fresh.noSubmit': ev['submitRequests'] == 0,
         'fresh.serialNewIdentity': SERIAL_NEW in serial and SERIAL_OPENED not in serial,
         'fresh.httpReady': info is not None, 'fresh.infoIsQuoteOnlyCanary': _info_shape(info),
         'fresh.stateModes': ph['stateDirMode'] == '0o700' and ph['stateAfter'].get('state.bin', {}).get('mode') == '0o600'
             and all(v['mode'] == '0o600' for v in ph['stateAfter'].values())}
    r.update({'fresh.' + k: v for k, v in _quote(ph, measurement, info).items()})
    r.update({'fresh.' + k: v for k, v in _boundary(ph).items()})
    return r


def verdict_fault(ph, saved):
    ev, serial = ph['events'], ph['serial']
    r = {'fault.stateMatchesSavedAtLaunch': sealed_files(ph['stateBefore']) == saved['stateFiles'],
         'fault.observed503': ev['stateGet503'] >= 1,
         'fault.everyStateGetAnswered503': ev['stateGetStatuses'] != [] and set(ev['stateGetStatuses']) == {503},
         'fault.noStateWrite': ev['stateWriteRequests'] == 0, 'fault.noSubmit': ev['submitRequests'] == 0,
         'fault.neverHttpReady': ph['mgmtResponses'] == [] and ph['mgmtProbes'] >= FAULT_HOLD_S // 3,
         'fault.heldForWindow': ph['heldS'] >= FAULT_HOLD_S, 'fault.launcherAliveThroughout': ph['launcherExit'] is None,
         'fault.serialRefusal': SERIAL_REFUSED in serial,
         'fault.serialNoReplacement': SERIAL_NEW not in serial and SERIAL_OPENED not in serial and SERIAL_LISTEN not in serial,
         'fault.sealedStateUnchanged': sealed_files(ph['stateAfter']) == saved['stateFiles'] and saved['stateFiles'] != {}}
    r.update({'fault.' + k: v for k, v in _boundary(ph).items()})
    return r


def verdict_reopen(ph, saved, fresh_nonce, measurement):
    ev, serial, info = ph['events'], ph['serial'], ph.get('info')
    pub = public_identity(info or {})
    v = ph.get('verdict') or {}
    r = {'reopen.stateMatchesSavedAtLaunch': sealed_files(ph['stateBefore']) == saved['stateFiles'],
         'reopen.firstStateGet200': ev['stateGetStatuses'][:1] == [200],
         'reopen.no404or503': ev['stateGet404'] == 0 and ev['responses503'] == 0, 'reopen.noSubmit': ev['submitRequests'] == 0,
         'reopen.serialOpened': SERIAL_OPENED in serial and SERIAL_NEW not in serial,
         'reopen.httpReady': info is not None, 'reopen.infoIsQuoteOnlyCanary': _info_shape(info),
         'reopen.sameIdentity': info is not None and pub['identity'] == saved['identity']['identity'] and info.get('identity') == saved['identity']['identity'],
         'reopen.sameEncKey': info is not None and pub['encKey'] == saved['identity']['encKey'] and info.get('encKey') == saved['identity']['encKey'],
         'reopen.sameMachineRecord': info is not None and pub == saved['identity'],
         'reopen.nonceDiffersFromFresh': v.get('nonce') != fresh_nonce}
    r.update({'reopen.' + k: v for k, v in _quote(ph, measurement, info).items()})
    r.update({'reopen.' + k: v for k, v in _boundary(ph).items()})
    return r


def phase_config(base, phase, state_dir, event_log):
    if phase not in PHASES: raise CanaryError('unknown phase')
    cfg = dict(base, stateDir=str(state_dir), canaryEventLog=str(event_log))
    if phase == 'fault': cfg['canaryStateFault'] = FAULT
    return cfg


def base_config(manifest, dist):
    if not re.match(r'^0x[0-9a-f]{40}$', str(manifest.get('vault', ''))): raise CanaryError('manifest vault')
    return dict(dist=str(dist), ovmf=str(OVMF), sevDevice='/dev/sev', cpus=2, memMiB=GUEST_MIB, tunnelName='custody-recovery-canary',
                endpoint=ENDPOINT, registryEndpoint=ENDPOINT, hostPort=HOST_PORT, mgmtPort=MGMT_PORT, genesis=False,
                vault=manifest['vault'], rpc='https://mainnet.base.org', submitterKeyEnv='ENCLAVE_QUOTE_ONLY_NO_KEY')


# ---------- pins ----------
def pinned_paths(a):
    d, r = pathlib.Path(a['dist']), pathlib.Path(a['repo'])
    return [d / 'manifest.json', d / 'vmlinuz', d / 'initramfs.cpio.gz', d / 'cmdline', OVMF, r / 'custody/v2/host.mjs',
            VERIFIER, HEADROOM, MEMORY_GUARD, INJECT_FILE, REGISTER, HOOK, pathlib.Path(__file__).resolve()] + \
        [p for p in [r / 'node_modules/viem/package.json'] if p.exists()]  # the unmeasured host's one bare dependency


def check_pins(a, git=subprocess.run):
    """Static pins; raises on the first failure."""
    dist, repo = pathlib.Path(a['dist']), pathlib.Path(a['repo'])
    for k, rx in (('expected_commit', HEX40), ('expected_host_sha256', HEX64), ('expected_copy_sha256', HEX64), ('expected_measurement', HEX96),
                  ('expected_manifest_sha256', HEX64)):
        if not rx.match(a[k] or ''): raise CanaryError(f'--{k.replace("_", "-")}: malformed')
    for p in (dist, repo):
        if not p.is_absolute() or os.path.realpath(p) != str(p) or not p.is_dir(): raise CanaryError(f'{p}: absolute, non-symlinked directory required')
    if sha256(dist / 'manifest.json') != a['expected_manifest_sha256']: raise CanaryError('manifest sha256 differs from the pin')
    m = json.loads((dist / 'manifest.json').read_text())
    if m.get('role') != 'enclave-custodian-v2' or m.get('transport') != 'direct': raise CanaryError('not a direct enclave-custodian-v2 manifest')
    if m.get('measurement') != a['expected_measurement']: raise CanaryError('manifest measurement differs from the pin')
    if m.get('commit') != a['expected_commit']: raise CanaryError('manifest commit differs from the pinned source commit')
    head = git(['git', '-C', str(repo), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=20)
    if head.returncode or head.stdout.strip() != a['expected_commit']: raise CanaryError('source repo HEAD differs from the pinned commit')
    dirty = git(['git', '-C', str(repo), 'status', '--porcelain', '--untracked-files=no'], capture_output=True, text=True, timeout=60)
    if dirty.returncode or dirty.stdout.strip(): raise CanaryError('source repo has modified tracked files')
    blob = git(['git', '-C', str(repo), 'show', 'HEAD:custody/v2/host.mjs'], capture_output=True, timeout=20)
    if blob.returncode or sha256b(blob.stdout) != a['expected_host_sha256']: raise CanaryError('committed host.mjs differs from the pin')
    host = repo / 'custody/v2/host.mjs'
    if os.path.realpath(host) != str(host) or sha256(host) != a['expected_host_sha256']: raise CanaryError('host.mjs on disk differs from the pin')
    for p, want in REVIEWED.items():
        if sha256(p) != want: raise CanaryError(f'{p.name}: not the reviewed helper')
    return m


def hashes(a): return {str(p): sha256(p) for p in pinned_paths(a)}


# ---------- child: the three phases inside the scope ----------
def http_json(url, timeout, data=None):
    """('response', status, json|None) for ANY HTTP answer, ('none', reason) when no HTTP answer arrived."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, data=data, method='POST' if data else 'GET')
    try:
        with opener.open(req, timeout=timeout) as r:
            body = r.read(1 << 20)
            try: return ('response', r.status, json.loads(body))
            except ValueError: return ('response', r.status, None)
    except urllib.error.HTTPError as e: return ('response', e.code, None)
    except Exception as e: return ('none', type(e).__name__)


class Phase:
    def __init__(self, run, args, att, phase, cg, protected, child_env):
        self.run, self.args, self.att, self.name, self.cg, self.protected, self.env = run, args, att, phase, cg, protected, child_env
        self.state = run / 'private/state'
        self.events_file = run / f'events-{phase}.jsonl'
        self.ev = dict(phase=phase, startedAt=now())
        self.launcher = None; self.root = None; self.owned = set(); self.qemu_seen = set()

    def sample(self):
        procs = processes()
        cur = descendants(self.root, procs)
        self.owned |= cur
        self.qemu_seen |= {ident(p) for p in procs if ident(p) in cur and p['comm'].startswith('qemu')}

    def launch(self):
        ev, run = self.ev, self.run
        try: check_pins(self.args); static = True
        except CanaryError as e: static = False; ev['pinError'] = str(e)
        ev['pinsOk'] = static and hashes(self.args) == self.att['hashes'] and sha256(run / 'private/host-canary.mjs') == self.att['hostCopySha256']
        procs = processes()
        ev['cgroupExtraBefore'] = cgroup_extra(os.getpid(), cgroup_pids(self.cg), procs)
        ev['portsBefore'] = ports_in_use([HOST_PORT, MGMT_PORT])
        ev['protectedBefore'] = qemus(procs) == self.protected
        ev['stateBefore'] = snapshot_state(self.state)
        ev['stateDirMode'] = oct(stat.S_IMODE(os.lstat(self.state).st_mode))
        if not (ev['pinsOk'] and ev['cgroupExtraBefore'] == [] and ev['portsBefore'] == [] and ev['protectedBefore']):
            raise CanaryError(f'{self.name}: launch boundary not clean')
        cfg_path = run / f'private/config-{self.name}.json'
        with cfg_path.open('x') as f: json.dump(phase_config(self.att['baseConfig'], self.name, self.state, self.events_file), f, indent=1)
        os.close(os.open(self.events_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        copy = run / 'private/host-canary.mjs'
        env = dict(self.env, CANARY_HOST_COPY_URL=copy.as_uri(), CANARY_HOST_ORIGINAL_URL=(pathlib.Path(self.args['repo']) / 'custody/v2/host.mjs').as_uri())
        self.serial = (run / f'serial-{self.name}.log').open('x')
        self.launcher = subprocess.Popen(['node', '--import', REGISTER.as_uri(), str(copy), str(cfg_path)], cwd=str(run / 'private'),
                                         env=env, stdin=subprocess.DEVNULL, stdout=self.serial, stderr=subprocess.STDOUT, start_new_session=True)
        st = proc_stat(self.launcher.pid)
        self.root = ident(st); self.owned = {self.root}
        ev['launcher'] = dict(pid=st['pid'], starttime=st['starttime'], pgid=st['pgid'], at=now())
        if st['pgid'] != st['pid']: raise CanaryError('launcher is not its own process-group leader')

    def wait_ready(self):
        t0 = time.monotonic()
        while time.monotonic() - t0 < READY_S:
            self.sample()
            if self.launcher.poll() is not None: raise CanaryError(f'{self.name}: host launcher exited {self.launcher.returncode}')
            r = http_json(f'http://127.0.0.1:{MGMT_PORT}/v2/custody/info', 2)
            if r[0] == 'response' and r[1] == 200 and isinstance(r[2], dict):
                self.ev['readyAfterS'] = round(time.monotonic() - t0, 1); self.ev['info'] = r[2]; return r[2]
            time.sleep(2)
        raise CanaryError(f'{self.name}: guest evidence service not ready within {READY_S} s')

    def verify(self):
        out = self.run / f'verdict-{self.name}.json'
        with (self.run / f'verify-{self.name}.log').open('x') as log:
            v = subprocess.run(['node', str(VERIFIER), '--manifest', str(pathlib.Path(self.args['dist']) / 'manifest.json'), '--source', self.args['repo'],
                                '--url', f'http://127.0.0.1:{MGMT_PORT}', '--out', str(out)], env=self.env, stdout=log, stderr=subprocess.STDOUT, timeout=VERIFY_S)
        self.ev['verifierExit'] = v.returncode
        if out.exists(): self.ev['verdict'] = json.loads(out.read_text())

    def hold_fault(self):
        ev, t0, first = self.ev, time.monotonic(), None
        ev['mgmtProbes'], ev['mgmtResponses'] = 0, []
        while True:
            self.sample()
            if self.launcher.poll() is not None: break
            r = http_json(f'http://127.0.0.1:{MGMT_PORT}/v2/custody/info', 2)
            ev['mgmtProbes'] += 1
            if r[0] == 'response': ev['mgmtResponses'].append(r[1])
            if first is None and summarize_events(parse_events(self.events_file.read_text()))['stateGet503'] >= 1:
                first = time.monotonic(); ev['first503AfterS'] = round(first - t0, 1)
            if first is None and time.monotonic() - t0 >= FAULT_FIRST_S: break
            if first is not None and time.monotonic() - first >= FAULT_HOLD_S: break
            time.sleep(1)
        ev['heldS'] = round(time.monotonic() - first, 1) if first is not None else 0
        ev['launcherExit'] = self.launcher.poll()

    def stop(self):
        ev = self.ev
        if self.launcher is None: return
        self.sample()
        ev['stop'] = stop_group(self.launcher.pid, self.owned, procs=processes, killpg=os.killpg, reap=self.launcher.poll)
        self.serial.close()
        procs = processes()
        ev['launcherReturncode'] = self.launcher.returncode
        ev['qemuIdentities'] = sorted([list(q) for q in self.qemu_seen])
        ev['cgroupExtraAfter'] = cgroup_extra(os.getpid(), cgroup_pids(self.cg), procs)
        ev['portsAfter'] = ports_in_use([HOST_PORT, MGMT_PORT])
        ev['protectedUnchanged'] = qemus(procs) == self.protected
        ev['stateAfter'] = snapshot_state(self.state)
        ev['events'] = summarize_events(parse_events(self.events_file.read_text(), final=True))
        ev['serial'] = (self.run / f'serial-{self.name}.log').read_text(errors='replace')
        ev['daemonRestartsSeen'] = ev['serial'].count(SERIAL_RESTART)
        ev['stoppedAt'] = now()


def public_phase(ev):
    """What result.json keeps: metadata and selected public fields. The serial log stays in its own file."""
    keep = {k: v for k, v in ev.items() if k not in ('serial', 'verdict', 'info', 'stateBefore', 'stateAfter')}
    if ev.get('info'): keep['identity'] = public_identity(ev['info'])
    v = ev.get('verdict')
    if v: keep['verdict'] = dict(ok=v.get('ok'), reasons=v.get('reasons'), nonce=v.get('nonce'), checkedAt=v.get('checkedAt'),
                                 observed={k: (v.get('observed') or {}).get(k) for k in ('measurement', 'hostData', 'policy', 'vmpl', 'chipIdSha256')})
    for k in ('stateBefore', 'stateAfter'):
        if k in ev: keep[k] = {n: dict(size=f['size'], sha256=f['sha256'], mode=f['mode']) for n, f in ev[k].items()}
    return keep


def child(run):
    def interrupted(signum, frame): raise KeyboardInterrupt('canary interrupted')
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    guard_run(run)
    att = json.loads((run / 'attempt.json').read_text())
    args = att['pins']
    guard_dir(run / 'private'); guard_dir(run / 'private/state')
    cg = own_cgroup()
    with (run / 'scope.json').open('x') as f: json.dump(dict(cgroup=str(cg), pid=os.getpid(), at=now()), f)
    protected = qemus(processes())
    (run / 'protected-before.json').write_text(json.dumps(protected, indent=1))
    env = dict(PATH='/usr/local/bin:/usr/bin:/bin', HOME=os.environ['HOME'], LANG='C.UTF-8')
    result = dict(startedAt=now(), scope='startup-recovery evidence only; quote-only; not secret release or lifecycle',
                  quoteOnly=True, noRegistryKey=True, noSubmitterKey=True, noCommittee=True, genesis=False, productionActivated=False,
                  cgroup=str(cg), phases={}, required={}, diagnostic={})
    saved, cur = None, None
    try:
        for name in PHASES:
            cur = Phase(run, args, att, name, cg, protected, env)
            result['phases'][name] = cur.ev
            cur.launch()
            if name == 'fault': cur.hold_fault()
            else: cur.wait_ready(); cur.verify()
            cur.stop()
            if name == 'fresh':
                result['required'].update(verdict_fresh(cur.ev, args['expected_measurement']))
                saved = dict(stateFiles=sealed_files(cur.ev['stateAfter']), identity=public_identity(cur.ev.get('info') or {}),
                             nonce=(cur.ev.get('verdict') or {}).get('nonce'), at=now())
                with (run / 'saved-after-fresh.json').open('x') as f: json.dump(saved, f, indent=1)
                if not all(result['required'].values()): raise CanaryError('fresh phase failed; not continuing')
            elif name == 'fault':
                result['required'].update(verdict_fault(cur.ev, saved))
                if not all(result['required'].values()): raise CanaryError('fault phase failed; not continuing')
            else:
                result['required'].update(verdict_reopen(cur.ev, saved, saved['nonce'], args['expected_measurement']))
            cur = None
    except BaseException as e:
        result['error'] = f'{type(e).__name__}: {e}'
    finally:
        if cur is not None and cur.launcher is not None and 'stop' not in cur.ev:
            try: cur.stop()
            except BaseException as e: result['stopError'] = f'{type(e).__name__}: {e}'
        procs = processes()
        after = qemus(procs)
        (run / 'protected-after.json').write_text(json.dumps(after, indent=1))
        result['required']['end.protectedQemuIdentitiesUnchanged'] = after == protected
        result['required']['end.cgroupClean'] = cgroup_extra(os.getpid(), cgroup_pids(cg), procs) == []
        result['required']['end.allPhasesRan'] = all('stop' in result['phases'].get(n, {}) for n in PHASES)
        for n, ev in result['phases'].items():
            result['diagnostic'][n] = {k: ev.get(k) for k in ('readyAfterS', 'first503AfterS', 'daemonRestartsSeen', 'qemuIdentities', 'launcherReturncode')}
            result['diagnostic'][n]['events'] = ev.get('events')
        result['phases'] = {n: public_phase(ev) for n, ev in result['phases'].items()}
        result['ok'] = 'error' not in result and 'stopError' not in result and all(result['required'].values())
        result['finishedAt'] = now()
        with (run / 'result.json').open('x') as f: json.dump(result, f, indent=1)
    print(json.dumps(dict(ok=result['ok'], error=result.get('error'), failed=[k for k, v in result['required'].items() if not v]), indent=1), flush=True)
    return 0 if result['ok'] else 1


# ---------- parent: locks, preflight, scope, cleanup ----------
def available():
    return next(int(l.split()[1]) // 1024 for l in pathlib.Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))


def main(argv):
    if argv[:1] == ['--child']: return child(pathlib.Path(argv[1]))
    ap = argparse.ArgumentParser()
    for k in ('dist', 'repo', 'expected-commit', 'expected-host-sha256', 'expected-copy-sha256', 'expected-measurement', 'expected-manifest-sha256'):
        ap.add_argument('--' + k, required=True)
    a = vars(ap.parse_args(argv))
    locks = []
    for name in ('claude-test-queue.lock', 'claude-test-small-queue.lock'):
        f = (WORK / name).open('a+')
        try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: print('NOT STARTED: shared test lane busy', flush=True); return 98
        locks.append(f)
    if available() < RESERVE_MIB + CAP_MIB + MARGIN_MIB: print('NOT STARTED: reserve unavailable', flush=True); return 98
    if not RUNS.exists(): os.mkdir(RUNS, 0o700); os.chmod(RUNS, 0o700)
    run = fresh_dir(RUNS / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))  # never repeats a prior attempt
    guard_run(run)
    try: manifest = check_pins(a)
    except CanaryError as e:
        (run / 'pins.log').write_text(f'PIN FAIL {e}\n'); print('NOT STARTED: pin failure:', e, flush=True); return 2
    pre = subprocess.run(['bash', str(HEADROOM), a['dist'], str(GUEST_MIB), str(HOST_PORT), str(MGMT_PORT), str(run)], capture_output=True, text=True, timeout=60)
    (run / 'preflight.log').write_text(pre.stdout + pre.stderr)
    if pre.returncode: print('NOT STARTED: preflight failed', flush=True); return pre.returncode
    private = fresh_dir(run / 'private'); fresh_dir(private / 'state')
    copy = private / 'host-canary.mjs'
    data = transform_host((pathlib.Path(a['repo']) / 'custody/v2/host.mjs').read_bytes(), a['expected_host_sha256'], INJECT_FILE.read_text())
    if sha256b(data) != a['expected_copy_sha256']: print('NOT STARTED: canary host copy differs from the pinned copy hash', flush=True); return 2
    fd = os.open(copy, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'wb') as f: f.write(data)
    att = dict(at=now(), pins=a, guestMiB=GUEST_MIB, memoryCapMiB=CAP_MIB, reserveMiB=RESERVE_MIB, marginMiB=MARGIN_MIB, exclusiveBothQueueLanes=True,
               ports=[HOST_PORT, MGMT_PORT], baseConfig=base_config(manifest, a['dist']), hostCopySha256=sha256b(data), hashes=hashes(a))
    with (run / 'attempt.json').open('x') as f: json.dump(att, f, indent=2)
    unit = 'enclave-custody-snp-recovery-canary-' + run.name.lower()
    cmd = ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no', f'--unit={unit}', '-p', f'MemoryMax={CAP_MIB}M', '-p', 'MemorySwapMax=0',
           'node', str(MEMORY_GUARD), '--max-rss-mib', str(CAP_MIB), '--floor-available-mib', str(RESERVE_MIB), '--log', str(run / 'memory.log'), '--',
           'timeout', '--signal=TERM', '--kill-after=20s', f'{CHILD_TIMEOUT_S}s', 'python3', str(pathlib.Path(__file__).resolve()), '--child', str(run)]
    with (run / 'execution.log').open('x') as out:
        p = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT)
        try: code = p.wait(timeout=CHILD_TIMEOUT_S + 120)
        except subprocess.TimeoutExpired:
            subprocess.run(['systemctl', '--user', 'stop', f'{unit}.scope'], capture_output=True, timeout=30); code = p.wait(timeout=30) or 1
    cg = None
    try: cg = pathlib.Path(json.loads((run / 'scope.json').read_text())['cgroup'])
    except (OSError, ValueError, KeyError): pass
    if cg is not None and not str(cg).endswith(f'/{unit}.scope'): cg = None  # only this run's own transient scope is accepted
    left = sorted(cgroup_pids(cg)) if cg else None
    stop = subprocess.run(['systemctl', '--user', 'stop', f'{unit}.scope'], capture_output=True, text=True, timeout=30)  # ONLY this run's scope
    left_after = sorted(cgroup_pids(cg)) if cg else None
    survivors = run_path_survivors(run, ancestors_and_self())
    proven = left_after == [] and survivors == []
    if proven: shutil.rmtree(private)  # this run's disposable sealed identity, fw_cfg, configs and host copy
    terminal = dict(at=now(), childExit=code, scopeStop=stop.returncode, cgroup=str(cg) if cg else None, cgroupLeftAtExit=left,
                    cgroupEmpty=left_after == [], survivors=survivors, privateScrubbed=proven and not private.exists())
    if not (code == 0 and terminal['cgroupEmpty'] and terminal['privateScrubbed']): code = code or 1
    terminal['exitCode'] = code
    with (run / 'terminal.json').open('x') as f: json.dump(terminal, f, indent=2)
    print('CANARY TERMINAL', code, str(run), flush=True)
    return code


if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
