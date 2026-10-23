# Shared by every script here (prepared by Claude 2026-10-23; ROOT EXECUTES each phase after review). Adapted from the
# reviewed work/linux-post-adoption-release/activation/common.py (Oct-21) to an IMAGE-ONLY change: config.json "dist" moves
# from dist-leasegas-deabf8f90 (ed918e4b) to dist-leasegas-a6b1378cd (ee5df6b8). Nothing else is written: not the rest of
# config.json (leaseGas and every other byte stay), not the drop-ins (80-shield-inference, 95-app-funded-leases), not the
# unit's WorkingDirectory (metal-deabf8f90: the launcher files are byte-identical), not lease-gas journals, not guestd.
# No keys, env files, private state or release journals are read; journal lines are filtered to the prefixes below.
from pathlib import Path
import hashlib, json, os, re, subprocess, time, datetime, urllib.request

W = Path('/home/steven/Documents/Codex/2026-10-18/wo')
A = Path(__file__).resolve().parent
EVIDENCE = A / 'evidence'
CONFIG = Path('/home/steven/Projects/enclave/metal/config.json')
UNIT = 'enclave-metal.service'
DROPIN_DIR = Path('/home/steven/.config/systemd/user/enclave-metal.service.d')
RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io']
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
sha = lambda b: hashlib.sha256(b).hexdigest()

# ---- current production, as root's read-only baseline recorded it (evidence/baseline.json, 2026-10-23T21:13:41Z) -----------
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
# ---- the candidate (work/custody-recipient-restore-20261023, commit a6b1378c, stage/INVENTORY.sha256) ------------------------
NEW = {
    'commit': 'a6b1378cdf430217025987d90c040d0e25a9993d',
    'staged': W / 'work/custody-recipient-restore-20261023/stage/dist-leasegas-a6b1378cd',
    'dist': '/home/steven/enclave-prod/dist-leasegas-a6b1378cd',
    'measurement': 'ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec',
    'files': {'MEASUREMENT': 'd99cb42849311fb017b76b35bb200ff847ea2d548b369ddffabf5e6c954660c9',
              'cmdline': 'd9e04c2c4769a4aadeaf4591e8e825ac513bf89f2677918d7e74638d8c9c90b8',
              'initramfs.cpio.gz': '5ce61b6f590ed6b84f6d463a949234562c4a6fd8646b74b3de69d6e2e442f1de',
              'manifest.json': '3874066dff197d154f51f1fe791ab66e5000e81017670cb6c39cb861e79ec12b',
              'vmlinuz': '1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7'},
}
APPS = {'0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9': {'url': 'https://da09d0f2.app.enclave.host/', 'kind': 'html'},       # image-generator
        '0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c': {'url': 'https://9eb4e600.app.enclave.host/ping', 'kind': 'json-ping'}}  # EyesOff
# ---- the API relay's measurement admission (root's SSH, as the Oct-21 admit.py) ------------------------------------------
RELAY = {'env': '/etc/nan-relay/linux-leasegas-measurements.env',
         'dropin': '/etc/systemd/system/enclave-api-relay.service.d/zzzzz-linux-leasegas-measurement.conf',
         'dropinSha256': '21fadc7209de6f7ba82fd614bcddd2fe1ba2cfa9feba988d34ab36b68d5caf9a',
         'installedSha256': 'f33a6c9145bf6448f99ff434c98568a2a157ee6a4e1d13a866b67ba874b18062',   # the deabf8f90 admission (2026-10-21T08:04Z)
         'expectedCount': 35, 'service': 'enclave-api-relay.service'}
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
def admission_body(remote_body, public_list, old=CURRENT['measurement'], new=NEW['measurement'], expected=RELAY['expectedCount']):
    """-> (existing list in the installed order, the new env file text). Additive: every installed measurement is kept."""
    m = re.fullmatch(r'METAL_ALLOWED_MEASUREMENTS=([0-9a-f,]+)\n', remote_body)
    if not m: raise AssertionError('the installed env file is not exactly one METAL_ALLOWED_MEASUREMENTS= line')
    existing = m.group(1).split(',')
    if not all(MEASUREMENT_RE.fullmatch(x) for x in existing) or len(set(existing)) != len(existing): raise AssertionError('malformed or duplicate measurement')
    if len(existing) != expected: raise AssertionError(f'{len(existing)} installed measurements, the reviewed state is {expected}')
    if set(existing) != set(public_list) or len(public_list) != len(set(public_list)): raise AssertionError('the installed list is not the public allowlist')
    if old not in existing: raise AssertionError('the running measurement is not admitted')
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

def baseline_problems(recorded, fresh_guests, fresh_titles):
    """Root's recorded baseline (evidence/baseline.json) must be ready and name exactly the guests and app identity seen now."""
    out = []
    if recorded.get('readyForPlan') is not True: out.append('root baseline not readyForPlan')
    if recorded.get('config', {}).get('sha256') != CURRENT['configSha256']: out.append('root baseline recorded another config')
    rec = {i: recorded['baseline'][i] for i in recorded.get('baseline', {})}
    if set(rec) != set(APPS): out.append('root baseline does not cover exactly the two apps')
    for i in APPS:
        if i in rec and (rec[i]['guest'], sorted(rec[i]['history'])) != (fresh_guests[i]['guest'], sorted(fresh_guests[i]['history'])):
            out.append(f'{i[:10]}: guest now {fresh_guests[i]} is not root\'s baseline {rec[i]}: rerun root baseline.py and review')
        want = (recorded.get('health', {}).get(i, {}).get('spec') or {}).get('title')
        if APPS[i]['kind'] == 'html' and want != fresh_titles.get(i): out.append(f'{i[:10]}: title {fresh_titles.get(i)!r} is not the baseline {want!r}')
    return out
