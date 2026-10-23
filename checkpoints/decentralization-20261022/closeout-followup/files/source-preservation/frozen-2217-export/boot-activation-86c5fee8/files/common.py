# Shared by every script here (prepared by Claude 2026-10-23; ROOT EXECUTES each phase after review). A SECOND image-only attempt
# for metal0's control, adapted from work/custody-recipient-activation-20261023 (7426b29), whose rollback restored deabf8f90
# at 21:37Z: config.json "dist" moves from dist-leasegas-deabf8f90 (ed918e4b) to the ROOT-APPROVED build of the boot-registration
# fix 9f6d37bd (reviewed-build JSON -> plan.json; no measurement is accepted from anywhere else). Nothing else is written: not the
# rest of config.json (leaseGas and every other byte stay), not the drop-ins, not WorkingDirectory (metal-deabf8f90), not
# lease-gas journals, not guestd or its guests. NEW vs the first attempt: the reviewed-build pins, the 36 -> 37 additive admission,
# the pre-cutover baseline from root's authenticated guestd listing (the old control is NOT registered, so /availability has no
# instanceSweep.held), and the mandatory boot-funding preflight before the restart. The rollback, journal, rewrite,
# protected-field and remote-script code below is the first attempt's, byte for byte (tests/test_activation.py pins it).
# No keys, env files, private state or release journals are read; journal lines are filtered to the prefixes below.
from pathlib import Path
import hashlib, json, os, re, stat, subprocess, time, datetime, urllib.request

W = Path('/home/steven/Documents/Codex/2026-10-18/wo')
A = Path(__file__).resolve().parent
EVIDENCE = A / 'evidence'
CONFIG = Path('/home/steven/Projects/enclave/metal/config.json')
UNIT = 'enclave-metal.service'
DROPIN_DIR = Path('/home/steven/.config/systemd/user/enclave-metal.service.d')
RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io']
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
sha = lambda b: hashlib.sha256(b).hexdigest()

# ---- current production: the first attempt's baseline, restored by its rollback at 21:37Z (root: config sha 58aa9653) ----------
CURRENT = {
    'configSha256': '58aa9653586b6e4d67f2198dde111fad0329d2b33770c4f4a4ba14d5ddc220b3',
    'dist': '/home/steven/enclave-prod/dist-leasegas-deabf8f90',
    'measurement': 'ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2',
    'leaseGasDigest': '3570d276b92175e8125a152d15eb7f5a7022301b15535c604923020971672562',
    'workingDirectory': '/home/steven/enclave-prod/metal-deabf8f90',
    'killMode': 'control-group',
    'dropins': {'80-shield-inference.conf': '9f3acb480ce85b85cb02acd3fa0a9d5eb50e5b0a823a3a09b150cbe88eddd40b',
                '95-app-funded-leases.conf': '71b3feb343f3f02ac4fc555df33d8571ffeb2e92d7dd0b4f33474ad549037daa'},
}
# ---- the candidate: ONLY the root-reviewed source commit, and ONLY a build root approved (APPROVED-BUILD.txt) --------------------
H_REPO = W / 'work/custody-boot-registration-20261023/repo'
RESTORE = W / 'work/custody-recipient-restore-20261023'
REVIEWED = {
    'commit': '9f6d37bd858ad44be1171b6415353910214c2fa5',          # root-reviewed boot-registration fix (H), never another head
    'parent': 'a6b1378cdf430217025987d90c040d0e25a9993d',          # the restore commit (ee5df6b8)
    'supervisorSha256': '37e6a34078c2fa1d5ca835a619a115c86e7aca273324924eecda45e7346bab0b',
    'delta': ['supervisor.js', 'test/registry-advertise-retry.test.mjs'],
    'stage': RESTORE / 'stage-approved',
    'name': 'dist-leasegas-9f6d37bd8',
    'unchanged': {'cmdline': 'd9e04c2c4769a4aadeaf4591e8e825ac513bf89f2677918d7e74638d8c9c90b8',      # = a6b1378cd = deabf8f90
                  'vmlinuz': '1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7'},
    'a6': {'initramfs.cpio.gz': '5ce61b6f590ed6b84f6d463a949234562c4a6fd8646b74b3de69d6e2e442f1de',
           'manifest.json': '3874066dff197d154f51f1fe791ab66e5000e81017670cb6c39cb861e79ec12b'},
}
PRIOR = {'measurement': 'ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec'}   # a6b1378cd, admitted 21:30Z
FILES = ['MEASUREMENT', 'cmdline', 'initramfs.cpio.gz', 'manifest.json', 'vmlinuz']
NEW = None   # set by load_new() from plan.json (stage.py), re-checked against root's APPROVED-BUILD.txt
APPS = {'0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9': {'url': 'https://da09d0f2.app.enclave.host/', 'kind': 'html'},       # image-generator
        '0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c': {'url': 'https://9eb4e600.app.enclave.host/ping', 'kind': 'json-ping'}}  # EyesOff
# ---- the API relay's measurement admission (root's SSH, as the Oct-21 admit.py) ------------------------------------------
RELAY = {'env': '/etc/nan-relay/linux-leasegas-measurements.env',
         'dropin': '/etc/systemd/system/enclave-api-relay.service.d/zzzzz-linux-leasegas-measurement.conf',
         'dropinSha256': '21fadc7209de6f7ba82fd614bcddd2fe1ba2cfa9feba988d34ab36b68d5caf9a',
         'installedSha256': '85d5f14db002499e995d688c457c2c43f9aebecfe272c8c884ada1e1115626e6',   # the 21:30Z admission (35 + ee5df6b8)
         'expectedCount': 36, 'service': 'enclave-api-relay.service'}
SSH = ['ssh', '-p', '32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=work/control-vm/known_hosts',
       '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', 'sudo -n python3 -']
MEASUREMENT_RE = re.compile(r'[0-9a-f]{96}')

# ---- the one config change ---------------------------------------------------------------------------------------------------
def rewrite_dist(raw, old_dist, new_dist):
    """-> the config bytes with ONLY the "dist" value replaced, every other byte preserved; refuses an ambiguous file."""
    text = raw.decode('utf-8')
    needle = json.dumps(old_dist)
    hits = [m.start() for m in re.finditer(r'"dist"\s*:\s*' + re.escape(needle), text)]
    if len(hits) != 1: raise AssertionError(f'expected exactly one "dist": {needle} entry, found {len(hits)}')
    if text.count(needle) != 1: raise AssertionError(f'{needle} occurs elsewhere in the config: refusing a textual rewrite')
    new = text.replace(needle, json.dumps(new_dist), 1).encode('utf-8')
    a, b = json.loads(raw), json.loads(new)
    if b != {**a, 'dist': new_dist} or list(a) != list(b): raise AssertionError('the rewrite changed more than dist')
    return new

def protected_problems(config_raw, unit, dropins, current=CURRENT):
    """Every protected field that is not what the reviewed baseline recorded -> list of problems (empty = ok)."""
    out = []
    c = json.loads(config_raw)
    if sha(config_raw) != current['configSha256']: out.append(f'config sha {sha(config_raw)[:16]} is not the baseline {current["configSha256"][:16]}')
    if c.get('dist') != current['dist']: out.append(f'config dist {c.get("dist")!r} is not {current["dist"]!r}')
    if c.get('mode') != 'snp': out.append(f'config mode {c.get("mode")!r} is not snp')
    if not c.get('leaseGas'): out.append('config has no leaseGas')
    elif sha(json.dumps(c['leaseGas'], sort_keys=True).encode()) != current['leaseGasDigest']: out.append('config leaseGas digest changed')
    if c.get('direct'): out.append('config carries direct settings')
    if unit.get('WorkingDirectory') != current['workingDirectory']: out.append(f'WorkingDirectory {unit.get("WorkingDirectory")!r}')
    if unit.get('KillMode') != current['killMode']: out.append(f'KillMode {unit.get("KillMode")!r}')
    if unit.get('ActiveState') != 'active': out.append(f'unit ActiveState {unit.get("ActiveState")!r}')
    if dropins != current['dropins']: out.append(f'drop-ins {dropins} are not the baseline {current["dropins"]}')
    return out

def read_unit():
    keys = ['ActiveState', 'SubState', 'MainPID', 'WorkingDirectory', 'KillMode']
    r = subprocess.check_output(['systemctl', '--user', 'show', UNIT] + [x for k in keys for x in ('-p', k)], text=True)
    return dict(l.split('=', 1) for l in r.splitlines() if '=' in l)

def read_dropins(d=DROPIN_DIR):
    return {p.name: sha(p.read_bytes()) for p in sorted(d.glob('*.conf'))}

def atomic_config(raw, mode, config=CONFIG):
    tmp = config.with_name(config.name + '.custody-restore-tmp'); assert not tmp.exists(), f'{tmp} exists: inspect'
    tmp.write_bytes(raw); tmp.chmod(mode); os.replace(tmp, config)

# ---- the API relay admission ---------------------------------------------------------------------------------------------
def admission_body(remote_body, public_list, new, old=CURRENT['measurement'], prior=PRIOR['measurement'], expected=RELAY['expectedCount']):
    """-> (existing list in the installed order, the new env file text). Additive: every installed measurement is kept."""
    m = re.fullmatch(r'METAL_ALLOWED_MEASUREMENTS=([0-9a-f,]+)\n', remote_body)
    if not m: raise AssertionError('the installed env file is not exactly one METAL_ALLOWED_MEASUREMENTS= line')
    existing = m.group(1).split(',')
    if not all(MEASUREMENT_RE.fullmatch(x) for x in existing) or len(set(existing)) != len(existing): raise AssertionError('malformed or duplicate measurement')
    if len(existing) != expected: raise AssertionError(f'{len(existing)} installed measurements, the reviewed state is {expected}')
    if set(existing) != set(public_list) or len(public_list) != len(set(public_list)): raise AssertionError('the installed list is not the public allowlist')
    if old not in existing: raise AssertionError('the running measurement is not admitted')
    if prior not in existing: raise AssertionError('the first attempt\'s ee5df6b8 is not admitted: the installed state is not the reviewed one')
    if not MEASUREMENT_RE.fullmatch(new): raise AssertionError('malformed candidate measurement')
    if new in existing: raise AssertionError('the candidate is already admitted: inspect')
    return existing, 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(existing + [new]) + '\n'

# Remote scripts (run as `sudo -n python3 -` on the API relay; ARGS is substituted with a repr'd tuple). SYSTEMCTL is an
# argument so the tests can run the SAME text against temp files with a stub.
REMOTE_READ = '''import hashlib, json, subprocess
from pathlib import Path
ENV, DROP, SYSTEMCTL, SERVICE = ARGS
e, d = Path(ENV).read_bytes(), Path(DROP).read_bytes()
active = subprocess.run([SYSTEMCTL, 'is-active', SERVICE], capture_output=True, text=True).stdout.strip()
print(json.dumps({'envSha256': hashlib.sha256(e).hexdigest(), 'envBody': e.decode(), 'dropinSha256': hashlib.sha256(d).hexdigest(), 'serviceActive': active}))
'''
REMOTE_CAS = '''import hashlib, os, subprocess
from pathlib import Path
ENV, DROP, BACKUP, BODY, EXPECT, DROPSHA, TAG, SYSTEMCTL, SERVICE = ARGS
e, dr, b = Path(ENV), Path(DROP), Path(BACKUP)
assert hashlib.sha256(e.read_bytes()).hexdigest() == EXPECT, 'installed admission changed since prepare-admission: inspect first'
assert hashlib.sha256(dr.read_bytes()).hexdigest() == DROPSHA, 'admission drop-in changed: inspect first'
assert not b.exists(), 'a backup from an earlier attempt exists: inspect first'
assert subprocess.run([SYSTEMCTL, 'is-active', SERVICE], capture_output=True, text=True).stdout.strip() == 'active'
old = e.read_bytes(); b.write_bytes(old); b.chmod(0o600)
try:
    t = e.with_name(e.name + '.tmp-' + TAG); assert not t.exists(); t.write_text(BODY); t.chmod(0o644); os.replace(t, e)
    subprocess.run([SYSTEMCTL, 'restart', SERVICE], check=True, timeout=45)
    subprocess.run([SYSTEMCTL, 'is-active', '--quiet', SERVICE], check=True)
    print('ADMISSION-UPDATED API service active')
except BaseException:
    e.write_bytes(old); subprocess.run([SYSTEMCTL, 'restart', SERVICE], check=True, timeout=45)
    print('ADMISSION-RESTORED after failure')
    raise
'''
REMOTE_RESTORE = '''import hashlib, os, subprocess
from pathlib import Path
ENV, BACKUP, NEW, OLD, TAG, SYSTEMCTL, SERVICE = ARGS
e, b = Path(ENV), Path(BACKUP)
assert hashlib.sha256(e.read_bytes()).hexdigest() == NEW, 'the installed env is not the one admit.py wrote'
assert hashlib.sha256(b.read_bytes()).hexdigest() == OLD, 'the backup is not the replaced env'
t = e.with_name(e.name + '.restore-' + TAG); assert not t.exists(); t.write_bytes(b.read_bytes()); t.chmod(0o644); os.replace(t, e)
subprocess.run([SYSTEMCTL, 'restart', SERVICE], check=True, timeout=45)
print('ADMISSION-RESTORED')
'''
def remote(template, args):
    return template.replace('ARGS', repr(tuple(args)))

def run_remote(script, timeout=60, ssh=SSH):
    r = subprocess.run(ssh, input=script, text=True, capture_output=True, timeout=timeout, cwd=str(W))
    return r.returncode, r.stdout, r.stderr

def public_attestation(get):
    import secrets
    st, body = get('https://api.enclave.host/v1/enclaves/metal0/attestation?nonce=' + secrets.token_hex(32))
    assert st == 200, f'attestation -> {st}'
    return json.loads(body)

def get(url, timeout=12):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'user-agent': 'enclave-custody-restore/1'}), timeout=timeout) as r: return r.status, r.read(1 << 20)
    except urllib.error.HTTPError as e: return e.code, b''
    except Exception as e: return None, type(e).__name__.encode()

# ---- journal, deadlines, verified block (as the Oct-21 common.py) ---------------------------------------------------------
PREFIXES = ('[claim] ', '[release] ', '[bill] ', '[instance] ', '[isolation] ', '[lease-gas] ')
def journal(since):
    r = subprocess.run(['journalctl', '--user', '-u', UNIT, '--since', since, '-o', 'cat', '--no-pager'], capture_output=True, text=True, timeout=30)
    if r.returncode != 0: raise RuntimeError(f'journal unreadable (exit {r.returncode}): {r.stderr.strip()[:160]}')   # fail closed
    return [l for l in r.stdout.splitlines() if l.startswith(PREFIXES)]

def pending_deadlines(lines):
    return sorted({int(x) for l in lines for x in re.findall(r'deadline (\d{10})', l)})

def rpc(url, method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    req = urllib.request.Request(url, data=body, headers={'content-type': 'application/json', 'user-agent': 'enclave-custody-restore/1'})
    with urllib.request.urlopen(req, timeout=15) as r: return json.load(r)['result']

def verified_block_after(ts, rpcs, limit_s):
    """Wait until >= 2 public RPCs agree (same number AND hash) on a block whose timestamp is past ts. -> the block."""
    end = time.monotonic() + limit_s
    while time.monotonic() < end:
        heads = []
        for u in rpcs:
            try: heads.append(int(rpc(u, 'eth_blockNumber', []), 16))
            except Exception: pass
        if len(heads) >= 2:
            n = sorted(heads, reverse=True)[1]
            seen = {}
            for u in rpcs:
                try:
                    b = rpc(u, 'eth_getBlockByNumber', [hex(n), False]); seen.setdefault((b['hash'], int(b['timestamp'], 16)), []).append(u)
                except Exception: pass
            for (h, t), who in seen.items():
                if len(who) >= 2 and t > ts: return {'number': n, 'hash': h, 'timestamp': t, 'agreeing': who}
        time.sleep(10)
    raise RuntimeError(f'no two RPCs agreed on a block past {ts} within {limit_s}s')

def systemctl(*args, timeout=60):
    subprocess.run(['systemctl', '--user', *args], check=True, timeout=timeout)

class Ops:
    """The side effects safe_rollback needs; tests substitute every one."""
    systemctl = staticmethod(systemctl); journal = staticmethod(journal); verified_block_after = staticmethod(verified_block_after)
    now = staticmethod(lambda: int(time.time())); read_dropins = staticmethod(read_dropins)

def safe_rollback(result, save, *, since, old_config, new_config, config=CONFIG, ops=Ops, rpcs=RPCS):
    """Stop the new control FIRST (it signs nothing more), let every sponsored request it signed expire on a verified block,
    restore the previous config by compare-and-swap and start the previous control. Drop-ins are never written (they must
    still be the baseline's); guestd, its guests and lease journals are never touched."""
    ops.systemctl('stop', UNIT)
    result.update(state='new control stopped; waiting out its pending sponsored requests', stoppedAt=utc()); save()
    stopped = ops.now()
    try: deadlines = pending_deadlines(ops.journal(since))
    except Exception as e:
        # an unreadable journal is no evidence that nothing is pending: every sponsored request has a deadline <= its
        # authority block + the lease client's 300 s ttl, and nothing was signed after the stop
        deadlines = [stopped + 300 + 60]; result['journalUnreadableAtRollback'] = str(e)[:200]
    result['pendingSponsoredDeadlines'] = deadlines; save()
    if deadlines:
        wait = max(0, deadlines[-1] - ops.now()) + 900
        result['deadlineBlock'] = ops.verified_block_after(deadlines[-1], rpcs, wait); save()
    assert config.read_bytes() == new_config, 'config changed concurrently: refuse overwriting it'
    assert ops.read_dropins() == CURRENT['dropins'], 'drop-ins changed concurrently: refuse restarting into an unknown unit'
    atomic_config(old_config, config.stat().st_mode & 0o777, config)
    ops.systemctl('start', UNIT)
    result.update(state='rolled back to the previous control image (deabf8f90, ed918e4b)', rolledBackAt=utc(), productionActivated=False); save()

# ---- activation preconditions (pure functions: tested with stubs) ---------------------------------------------------------
ATTACH_S, ADOPT_S = 120, 300
ROLLBACK_MARGIN_S = 480   # stop + the 300 s sponsored ttl + slack, as the Oct-21 activate.py

def preflight_problems(pre, ids, now):
    """The lease/funding preflight (evidence/lease-preflight.json) must be fresh and cover both apps with margin."""
    out = []
    age = now - float(pre['block']['timestamp'])
    if age >= 360: out.append(f'preflight is {int(age)} s old: refresh it (< 360 s)')
    rows = {r['id'].lower(): r for r in pre['rows']}
    for i in ids:
        r = rows.get(i)
        if not r: out.append(f'{i[:10]}: not in the preflight'); continue
        if not r.get('active'): out.append(f'{i[:10]}: deployment not active')
        if int(r['leaseRemainingSeconds']) - age <= ROLLBACK_MARGIN_S + ADOPT_S: out.append(f'{i[:10]}: lease margin {int(r["leaseRemainingSeconds"]) - int(age)} s too small for adoption + a controlled rollback')
        if not (r['reserve']['enabled'] and int(r['reserve']['balanceWei']) > 0): out.append(f'{i[:10]}: reserve disabled or empty')
        if r.get('hostActive') is not True: out.append(f'{i[:10]}: runner registry entry not active')
    if len({str(rows[i]['runner']).lower() for i in ids if i in rows}) != 1: out.append('the apps are not leased by one runner')
    return out

# ---- the reviewed build (build-record.py writes build.json; root reviews it and writes APPROVED-BUILD.txt) --------------------
APPROVED_COMMIT_TEXT = f"commit {REVIEWED['commit']}\nextra NONE\n"
def git(*args, repo=H_REPO):
    return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, check=True, timeout=60).stdout

def source_problems(git=git, rev=REVIEWED):
    """The reviewed commit itself: child of a6b1378c, changes exactly supervisor.js + its test, supervisor.js = the reviewed bytes."""
    out = []
    try:
        if git('rev-parse', rev['commit'] + '^').decode().strip() != rev['parent']: out.append('the reviewed commit is not a child of a6b1378c')
        names = sorted(git('diff', '--name-only', rev['parent'], rev['commit']).decode().split())
        if names != sorted(rev['delta']): out.append(f'the reviewed commit changes {names}, not {rev["delta"]}')
        if sha(git('show', rev['commit'] + ':supervisor.js')) != rev['supervisorSha256']: out.append('supervisor.js at the reviewed commit is not the reviewed bytes')
    except Exception as e: out.append(f'source unreadable: {type(e).__name__}: {str(e)[:120]}')
    return out

def parse_inventory(text, name=REVIEWED['name']):
    """`<sha256>  <name>/<file>` lines -> {file: sha256}; refuses anything else, any other file or a duplicate."""
    inv = {}
    for l in text.splitlines():
        m = re.fullmatch(r'([0-9a-f]{64})  ' + re.escape(name) + r'/([A-Za-z0-9._-]+)', l)
        if not m or m.group(2) in inv: raise AssertionError(f'inventory line {l[:100]!r} is not one file of {name}')
        inv[m.group(2)] = m.group(1)
    if sorted(inv) != sorted(FILES): raise AssertionError(f'inventory files {sorted(inv)} are not {FILES}')
    return inv

def build_problems(log_text, approved_text, inventory_text, measurement_text, rev=REVIEWED):
    """The completed build of the reviewed commit, from its own log + the stage's INVENTORY + MEASUREMENT. -> (record, problems)."""
    out = []
    if approved_text != APPROVED_COMMIT_TEXT: out.append('APPROVED-COMMIT.txt is not exactly the reviewed commit with extra NONE')
    lines = log_text.splitlines()
    want = [f"APPROVED {rev['commit']} extra=[] delta: {' '.join(rev['delta'])} "]
    want += [f'CONTROL-IDENTICAL {f}' for f in ('initramfs.cpio.gz', 'vmlinuz', 'cmdline', 'manifest.json')]
    want += [f'REPRODUCIBLE {f}' for f in ('initramfs.cpio.gz', 'vmlinuz', 'cmdline', 'manifest.json')]
    want += ["MANIFEST-DELTA-EXACT ['/app/supervisor.js']",
             "ENTRY-DELTA-EXACT vs a6 ['app/supervisor.js', 'opt/metal/manifest.json'] vs production ['app/supervisor.js', 'opt/metal/gsup.mjs', 'opt/metal/manifest.json']",
             "IMAGE-FILES-ARE-SOURCE ['app/supervisor.js', 'opt/metal/gsup.mjs']",
             'MEASURE-RECIPE-REPRODUCES-PRODUCTION', 'MEASURE-RECIPE-REPRODUCES-A6', '[queue] EXIT 0']
    for w in want:
        if lines.count(w) != 1: out.append(f'build log: {w[:90]!r} appears {lines.count(w)} times, not once')
    if any(re.search(r'REFUSED|DIFFERS|NOT-REPRODUCIBLE|MISMATCH|Traceback|AssertionError', l) for l in lines): out.append('build log reports a refusal or failure')
    ms = [l.split(' ', 1)[1] for l in lines if l.startswith('MEASURE-CANDIDATE ')]
    m = ms[0] if len(ms) == 1 else None
    if m is None or not MEASUREMENT_RE.fullmatch(m): out.append('build log: not exactly one well-formed MEASURE-CANDIDATE'); m = None
    elif m in (CURRENT['measurement'], PRIOR['measurement']): out.append('the candidate measurement is a previous image\'s')
    if m is not None and measurement_text != m + '\n': out.append('MEASUREMENT file is not the logged candidate measurement')
    try: inv = parse_inventory(inventory_text, rev['name'])
    except AssertionError as e: return None, out + [str(e)]
    logged = [l for l in lines if re.fullmatch(r'[0-9a-f]{64}  ' + re.escape(rev['name']) + r'/\S+', l)]
    if sorted(logged) != sorted(inventory_text.splitlines()): out.append('the logged inventory is not stage INVENTORY.sha256')
    for f, h in rev['unchanged'].items():
        if inv[f] != h: out.append(f'{f} changed: only the initramfs and manifest may differ')
    for f, h in rev['a6'].items():
        if inv[f] == h: out.append(f'{f} equals a6b1378cd\'s: not the new build')
    if measurement_text is not None and sha(measurement_text.encode()) != inv['MEASUREMENT']: out.append('MEASUREMENT does not hash to its inventory entry')
    rec = {'commit': rev['commit'], 'parent': rev['parent'], 'supervisorSha256': rev['supervisorSha256'], 'measurement': m,
           'name': rev['name'], 'files': inv, 'approvedCommitSha256': sha(approved_text.encode()), 'buildLogSha256': sha(log_text.encode())}
    return rec, out

def file_sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''): h.update(c)
    return h.hexdigest()

def staged_problems(d, files):
    """Every file of the image dir d hashes to the record (streamed: the initramfs is ~280 MB); no other file."""
    d = Path(d)
    if not d.is_dir(): return [f'{d} missing']
    out = [] if sorted(p.name for p in d.iterdir()) == sorted(files) else [f'{d} holds {sorted(p.name for p in d.iterdir())}']
    for f, h in files.items():
        if (d/f).is_file() and file_sha(d/f) != h: out.append(f'{d.name}/{f} does not hash to the reviewed build')
    return out

def approved_build(build_path, approval_path):
    """-> the build record, only if root's APPROVED-BUILD.txt names exactly these bytes ('build-sha256 <hex>')."""
    raw = Path(build_path).read_bytes(); appr = Path(approval_path).read_text()
    if appr != f'build-sha256 {sha(raw)}\n': raise AssertionError('APPROVED-BUILD.txt does not approve exactly this build.json: root review first')
    rec = json.loads(raw)
    if (rec.get('commit'), rec.get('supervisorSha256'), rec.get('name')) != (REVIEWED['commit'], REVIEWED['supervisorSha256'], REVIEWED['name']):
        raise AssertionError('build.json is not a build of the reviewed commit')
    return rec, sha(raw)

def load_new(a=None):
    """The candidate from plan.json (stage.py), re-checked against root's approval: never a measurement from anywhere else."""
    a = Path(a or A); global NEW
    rec, h = approved_build(a/'build.json', a/'APPROVED-BUILD.txt')
    plan = json.loads((a/'plan.json').read_text())
    if plan.get('buildSha256') != h or plan.get('measurement') != rec['measurement'] or plan.get('files') != rec['files']:
        raise AssertionError('plan.json is not the approved build')
    NEW = {'commit': rec['commit'], 'dist': plan['image'], 'measurement': rec['measurement'], 'files': rec['files'], 'buildSha256': h}
    return NEW

# ---- pre-cutover baseline from root's AUTHENTICATED guestd listing (GET /vms) ----------------------------------------------------
# The old control is not registered (no adoption), so /availability carries no instanceSweep.held: the baseline is guestd's own
# list, which root reads with its existing authenticated client and saves privately. Only id/name/status/recordSha256/createdAt
# are kept. Each app (guestd "name" = deployment id) must have exactly ONE nonterminal guest, running, with a record digest, and
# it must be the guest of the ORIGINAL 21:31:30Z baseline (the first attempt's pre-cutover record), with the same failed history.
ORIGINAL = {'file': A / 'evidence/original-baseline-20261023T213130Z.json',
            'sha256': '45554dc55f4cfc38302e922dccf67190c41e00c3b061a4ea52e3f1f530092af0',
            'guests': {'0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9': 'gd9d4a391d',     # image-generator
                       '0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c': 'gdd0646f2c'}}    # EyesOff
GUESTD_MAX_AGE_S = 300
KEEP = ('id', 'name', 'status', 'recordSha256', 'createdAt')

def original_baseline(o=ORIGINAL):
    raw = Path(o['file']).read_bytes()
    if sha(raw) != o['sha256']: raise AssertionError('the original 21:31 baseline file changed')
    b = json.loads(raw)['baseline']
    if {i: b[i]['guest'] for i in b} != o['guests']: raise AssertionError('the original baseline does not name the pinned guests')
    return {i: {'guest': b[i]['guest'], 'history': sorted(b[i]['history'])} for i in b}

def guestd_baseline(listing, apps, original):
    """listing: guestd's GET /vms body ({"vms": [...]}). -> (baseline {app: {guest, status, recordSha256, history, createdAt}},
    every row reduced to KEEP, problems)."""
    vms = listing.get('vms') if isinstance(listing, dict) else None
    if not isinstance(vms, list): return {}, [], ['not a guestd GET /vms listing ({"vms": [...]})']
    rows = [{k: r.get(k) for k in KEEP} for r in vms if isinstance(r, dict)]
    out, base = [], {}
    if len(rows) != len(vms): out.append('a guestd row is not an object')
    ids = [str(r['id']) for r in rows]
    if len(set(ids)) != len(ids): out.append('duplicate guest ids in the listing')
    for app in apps:
        mine = [r for r in rows if str(r.get('name', '')).lower() == app]
        live = [r for r in mine if r.get('status') != 'failed']
        hist = sorted(str(r['id']) for r in mine if r.get('status') == 'failed')
        want = original[app]
        if len(live) != 1: out.append(f'{app[:10]}: {len(live)} nonterminal guests, not exactly one'); continue
        r = live[0]
        if r.get('status') != 'running': out.append(f'{app[:10]}: guest {r.get("id")} is {r.get("status")!r}, not running')
        if not re.fullmatch(r'[A-Za-z0-9-]{1,64}', str(r.get('id'))): out.append(f'{app[:10]}: malformed guest id')
        if str(r.get('id')) != want['guest']: out.append(f'{app[:10]}: guest {r.get("id")} is not the original baseline guest {want["guest"]}: never adopt a replacement')
        if not re.fullmatch(r'[0-9a-f]{64}', str(r.get('recordSha256') or '')): out.append(f'{app[:10]}: no record digest')
        if hist != want['history']: out.append(f'{app[:10]}: failed history {hist} is not the original {want["history"]}')
        base[app] = {'guest': str(r.get('id')), 'status': r.get('status'), 'recordSha256': r.get('recordSha256'), 'history': hist, 'createdAt': r.get('createdAt')}
    return base, rows, out

def availability_cross_check(held, base, guestrows):
    """/availability instanceSweep.held: absent (the old control adopted nothing: recorded, never pretended), or it must agree."""
    if held is None: return 'absent: the old control is not registered and adopted nothing', []
    if not isinstance(held, list): return 'malformed', ['instanceSweep.held is not a list']
    try: seen = guestrows.baseline(held, list(base))
    except AssertionError as e: return 'present', [str(e)]
    bad = [f'{i[:10]}: /availability holds {seen[i]["guest"]}, guestd runs {base[i]["guest"]}' for i in base if seen[i]['guest'] != base[i]['guest']]
    return 'present and agrees with guestd', bad

def guestd_listing(path, now, max_age=GUESTD_MAX_AGE_S):
    """Root's private listing file: fresh (mtime) and parseable. -> (listing, sha256). The raw bytes are never copied."""
    p = Path(path); st = p.stat()
    if now - st.st_mtime > max_age or st.st_mtime - now > 30: raise AssertionError(f'guestd listing is {int(now - st.st_mtime)} s old: re-read it (<= {max_age} s)')
    if st.st_mode & 0o077: raise AssertionError('guestd listing must be private (0600)')
    raw = p.read_bytes(); return json.loads(raw), sha(raw)

# ---- MANDATORY boot-funding preflight (boot-funding.mjs collects, this decides) ----------------------------------------------
# The new boot's registration with the reviewed fix is ONE setProofKey (only the per-boot proof key differs) sent by the existing
# default sender (viem default fees). Refuse unless: the row is this operator's, active, every field exact (a full register()
# fallback is NOT accepted for this cutover); the registry and the operator's EIP-7702 delegation are unchanged; nonce = pending
# on both RPCs (no operator tx in flight); the worst case for the worst-case 20-byte test key fits the balance with 25% headroom.
FUNDING = {
    'registry': '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac',
    'registryCodeHash': '0x39911d6f53959c610b9108bb906fc36ea8f57016c4b2571b5cd52c9c32a6f518',
    'operator': '0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab',
    'operatorCode': '0xef01008900baca2167873ba2f8a8bae8b4876e6396d343',            # root 20:14 (ROOT-FUNDING-REVIEW): do not re-delegate
    'executor': '0x8900baca2167873ba2f8a8bae8b4876e6396d343',
    'executorCodeHash': '0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2',
    'endpoint': 'https://api.enclave.host/t/metal0', 'repo': 'EnclaveHost/enclave', 'measurement': '0x' + '00' * 32,
    'cpu': '834', 'gpu': '1667',                                                     # root 21:51Z: the box's actual public prices
    'testProofKey': '0x' + 'ff' * 20,                                                # fee estimation ONLY; the boot mints its own
    'maxAgeS': 360, 'headroomPct': 125,
}

def viem_default_max_fee(base, tip):
    return (int(base) * 12 + 9) // 10 + int(tip)

def boot_funding_problems(f, now, commit, supervisor_sha, P=FUNDING):
    out = []
    lc = lambda x: str(x if x is not None else '').lower()
    try:
        age = now - int(f['block']['timestamp'])
        if age >= P['maxAgeS'] or age < -30: out.append(f'funding preflight is {int(age)} s old: re-run it (< {P["maxAgeS"]} s)')
        if f.get('readOnly') is not True: out.append('not a read-only preflight')
        if len(f['rpcs']) != 2 or len({lc(u) for u in f['rpcs']}) != 2: out.append('not two distinct RPCs')
        if f['chainIds'] != [8453, 8453]: out.append('not Base on both RPCs')
        if f['source'] != {'commit': commit, 'supervisorSha256': supervisor_sha}: out.append('the decision was not sliced from the reviewed supervisor.js')
        if lc(f['registry']['address']) != P['registry'] or lc(f['registry']['codeHash']) != P['registryCodeHash']: out.append('registry address or code changed')
        if lc(f['operator']['address']) != P['operator']: out.append('another operator')
        if lc(f['operator']['code']) != P['operatorCode']: out.append('the operator\'s EIP-7702 delegation changed')
        if lc(f['executor']['address']) != P['executor'] or lc(f['executor']['codeHash']) != P['executorCodeHash']: out.append('the delegated executor code changed')
        r = f['row']
        if lc(r['operator']) != P['operator'] or r['active'] is not True: out.append('the metal0 row is not this operator\'s active row')
        if (r['endpoint'], r['repo'], lc(r['measurement']), str(r['cpu']), str(r['gpu'])) != (P['endpoint'], P['repo'], P['measurement'], P['cpu'], P['gpu']):
            out.append('the registered fields are not exactly endpoint/repo/measurement/prices: the boot would need a full register(), not accepted')
        d = f['desired']
        if (d['endpoint'], d['repo'], lc(d['measurement']), str(d['cpuPricePerSec6']), str(d['gpuPricePerSec6'])) != (P['endpoint'], P['repo'], P['measurement'], P['cpu'], P['gpu']):
            out.append('the preflight did not ask for the reviewed fields')
        if lc(f['testProofKey']) != P['testProofKey'] or lc(r['proofKey']) == P['testProofKey']: out.append('not the worst-case test proof key, or the row already holds it')
        if f['action'] != {'action': 'setProofKey', 'reason': 'only the proof key differs'}: out.append(f'the reviewed boot decision is {f["action"]}, not setProofKey')
        o = f['operator']; n = int(o['nonceAtBlock'])
        if [int(x) for x in o['latest']] != [n, n] or [int(x) for x in o['pending']] != [n, n]: out.append('operator nonce/pending disagree: a transaction is in flight or just landed')
        fe = f['fees']; sp = f['setProofKey']
        if fe.get('isthmus') is not True or not str(sp.get('operatorFeeWei', '')).isdigit(): out.append('the operator fee is undetermined')
        mf = viem_default_max_fee(fe['baseFeeWei'], fe['tipWei'])
        if int(sp['maxFeePerGas']) != mf: out.append('maxFeePerGas is not viem\'s default (ceil(1.2 x base) + tip)')
        gas = int(sp['gas'])
        if gas != max(int(x) for x in sp['gasEstimates']) or len(sp['gasEstimates']) != 2: out.append('gas is not the larger of the two estimates')
        worst = gas * mf + int(sp['l1FeeUpperBoundWei']) + int(sp.get('operatorFeeWei') or 0)
        if int(sp['worstCaseWei']) != worst: out.append('worst case does not add up')
        bal = int(o['balanceWei'])
        if bal < worst: out.append(f'setProofKey worst case {worst} wei exceeds the balance {bal}')
        elif bal * 100 < worst * P['headroomPct']: out.append(f'balance {bal} lacks the {P["headroomPct"] - 100}% headroom over the worst case {worst}')
    except (KeyError, TypeError, ValueError) as e: out.append(f'malformed funding preflight: {type(e).__name__} {e}')
    return out

def boot_funding(rpcs, commit, out_path, now=None, node='node', run=subprocess.run):
    """Run boot-funding.mjs (read-only) and decide. -> (facts, problems)."""
    r = run([node, str(A/'boot-funding.mjs'), '--rpc', rpcs[0], '--rpc', rpcs[1], '--commit', commit, '--out', str(out_path)],
            capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or '').strip(); first = next((l.strip() for l in err.splitlines() if re.match(r'\s*(\w*Error|Error):', l)), err[-300:])
        return None, [f'boot-funding.mjs failed ({r.returncode}): {first[:300]}']
    f = json.loads(Path(out_path).read_text())
    return f, boot_funding_problems(f, time.time() if now is None else now, commit, REVIEWED['supervisorSha256'])

# ---- keep: a STRICT fresh attestation verdict for the recovery target (never a substring of some evidence file) ----------------
# The schema is attest-control/1's (as the first attempt's check-attestation-verdict.py), generalized from the pinned ee5df6b8 to
# the approved candidate: a PASSED verdict, every required check PASS, observed == expected == the approved measurement, bound
# to the verifier's own nonce, VMPL 0, produced AFTER this activation attached and at most VERDICT_MAX_AGE_S before the keep,
# with its private raw answer (0600) hashing to rawSha256.
VERDICT_REQUIRED = ['report shape', 'product line', 'guest policy', 'chain', 'tcb policy', 'measurement', 'binding']
VERDICT_MAX_AGE_S = 1800

def attestation_verdict_problems(v, want, attached_at, now, raw_path):
    out = []
    if not isinstance(v, dict): return ['the attestation evidence is not a verdict object']
    if v.get('probe') != 'attest-control/1': out.append('not an attest-control/1 verdict')
    if v.get('pass') is not True: out.append('pass is not true')
    if v.get('status') != 'verified' or v.get('admissionSafe') is not True: out.append(f"status {v.get('status')!r} / admissionSafe {v.get('admissionSafe')!r}")
    if not MEASUREMENT_RE.fullmatch(str(want)) or v.get('expectedMeasurement') != want or v.get('observedMeasurement') != want or v.get('measurementMatches') is not True:
        out.append('the verdict is not for the approved measurement')
    req = v.get('required') or {}
    for k in VERDICT_REQUIRED:
        if req.get(k) != 'PASS': out.append(f'required check {k!r} is {req.get(k)!r}')
    if v.get('freshness') != 'verifier nonce' or not re.fullmatch(r'[0-9a-f]{64}', str(v.get('nonce', ''))): out.append('not bound to the verifier nonce')
    if v.get('vmpl') != 0: out.append(f"vmpl {v.get('vmpl')!r}")
    if v.get('failedChecks'): out.append(f"failed checks {v['failedChecks']}")
    try:
        at = datetime.datetime.fromisoformat(str(v.get('at')).replace('Z', '+00:00')).timestamp()
        if not attached_at or at <= datetime.datetime.fromisoformat(attached_at).timestamp(): out.append(f"verdict at {v.get('at')} is not after the attachment {attached_at}")
        if now - at > VERDICT_MAX_AGE_S or at - now > 60: out.append(f'verdict is {int(now - at)} s old (<= {VERDICT_MAX_AGE_S})')
    except (TypeError, ValueError): out.append('verdict time unreadable')
    raw = Path(raw_path)
    if not raw.is_file(): out.append('private raw answer missing')
    else:
        if stat.S_IMODE(raw.stat().st_mode) != 0o600: out.append('private raw answer is not 0600')
        if file_sha(raw) != v.get('rawSha256'): out.append('raw answer does not hash to rawSha256')
    return out
