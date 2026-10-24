# Shared by every script here (prepared by Claude 2026-10-23; ROOT EXECUTES each phase after review). A FOURTH image-only attempt
# for metal0's control: an isolated copy of work/custody-boot-price-activation-20261023 (8bbd0a74; its 23:1xZ attempt rolled back
# on "insufficient funds" for setProofKey; SUSPECTED cause, reproduced only with the SDK: viem's plain writeContract re-priced via
# eth_fillTransaction x 1.2 to ~13.2 mwei vs the 7 mwei that kit modelled - not a confirmed live fee). config.json "dist"
# moves from dist-leasegas-deabf8f90 (ed918e4b) to the ROOT-APPROVED build of the boot FEE fix - a single-parent child of 9f6d37bd
# (the reviewed 7dd delta + a sendOperatorTx that states explicit fresh fees and gas) that root approved in
# work/custody-boot-fee-release-20261023 (APPROVED-COMMIT.txt, 3-line format) and built there (build-price.sh);
# build-record.py turns that build into build.json, root approves build.json (APPROVED-BUILD.txt). No commit, measurement or
# decision hash is accepted from anywhere else. Nothing else is written: not the rest of config.json, not the drop-ins, not
# WorkingDirectory (metal-deabf8f90), not lease-gas journals, not guestd or its guests. NEW vs 86c5fee: the build-folder source,
# the 37 -> 38 additive admission, the boot decision checked for BOTH a pending (null) and the discovered (1667) GPU price, the
# config-derived shielded-GPU expectation, the full cutover lease margin re-checked at the write, the registry boot line
# recorded, and a stricter keep verdict (target priceRecovery). NEW vs 8bbd0a74: the build folder, the 38 -> 39 admission (b007d471
# retained) and the FEE CONTRACT: the approved sendOperatorTx is hash-pinned and must state explicit estimateFeesPerGas +
# estimateContractGas fees/gas, and the boot-funding preflight prices setProofKey by RUNNING that sender (inert) through viem. The rollback, journal, rewrite, protected-field and remote-script
# code is the first attempt's, byte for byte (tests/test_activation.py pins it).
# No keys, env files, private state or release journals are read; journal lines are filtered to the prefixes below.
from pathlib import Path
import hashlib, importlib.util, json, os, re, stat, subprocess, time, datetime, urllib.request

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
# ---- the candidate: ONLY the commit root approved in the build folder, and ONLY a build.json root approved (APPROVED-BUILD.txt) ---
H_REPO = W / 'work/custody-boot-registration-20261023/repo'
RESTORE = W / 'work/custody-recipient-restore-20261023'
BUILD = W / 'work/custody-boot-fee-release-20261023'
# FINAL RECOVERY (2026-10-24): REUSE, never re-make, root's approved + staged + admitted candidate of the fee kit (read in place,
# hash-pinned): build.json (approved by APPROVED-BUILD.txt), plan.json (stage.py), admission.json (the 39-entry admission, verified)
FEEKIT = W / 'work/custody-boot-fee-activation-20261023'
APPROVED_BUILD_SHA256 = '340dc3aeed0c18f3f4a2b258a5b6a94617bd9ab9799a18914eb2651a69db0938'   # 5db2be3f -> bc731956
PLAN_SHA256 = '50428dbce0150d13cf83efeb0ce99d8d36074339845d386a3e0b2c198b6f5892'
ADMISSION = {'file': FEEKIT / 'admission.json', 'sha256': '03125f7412eee8b1ce51875063ac3cf37d1fd6e85969d7805bb8138395fc103e', 'installedEnvSha256': '9fa50bfd8c329c724ad0b82316f73794dd5e85b3ed10631fdf818aa5851d7c18'}

def admission_record(a=ADMISSION):
    raw = Path(a['file']).read_bytes()
    if sha(raw) != a['sha256']: raise AssertionError('the fee kit admission.json changed since this kit pinned it: inspect')
    ad = json.loads(raw)
    if ad.get('stage') != 'verified active; old control still connected' or ad.get('environmentSha256') != a['installedEnvSha256']:
        raise AssertionError('the pinned admission is not the verified 39-entry one')
    return ad
PRECHECK_SHA256 = 'e6f3cb97502d4cdc0cc577178cb17b1967e147520d0e58c81d24841e2611bec3'   # the build folder's precheck.py at a340762 (root reviewed)
PARENT = '9f6d37bd858ad44be1171b6415353910214c2fa5'
NINE = {'name': 'dist-leasegas-9f6d37bd8', 'measurement': '08d1f838d51274571fdf17b635606d20a6e7250f74d6676217eea40733a8d269aaf52edb85aac4a9ad1cc5c53318a000',
        'files': {'MEASUREMENT': '6d55c0e2839e5a1aad1258ce80ec112181f155c50be9f5ad1f66f1bb44064537',
                  'cmdline': 'd9e04c2c4769a4aadeaf4591e8e825ac513bf89f2677918d7e74638d8c9c90b8',
                  'initramfs.cpio.gz': '02c7280a7020f29395d9e38e361d72aad8b39311218a1dd272dc2893e562dfaf',
                  'manifest.json': '64bd025db3ed62b82f016ed25f1bd24ab300dbe7520ca81498d3ccd293e43b16',
                  'vmlinuz': '1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7'}}   # root-built 21:54Z, admitted 22:10Z, never activated
PRIORS = ['ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec',     # a6b1378cd, admitted 21:30Z
          NINE['measurement'],                                                                                       # 9f6d37bd8, admitted 22:10Z
          'b007d47147d52ea01780abdee5f7b28d2eb02102a7915bf5f8dcafbf7d2a77b6a9ebb9d8b848acb8dd6377be5f1c09c6']   # 7dd3acd06, admitted ~22:5xZ (its cutover rolled back 23:15Z)
FILES = ['MEASUREMENT', 'cmdline', 'initramfs.cpio.gz', 'manifest.json', 'vmlinuz']
NEW = None   # set by load_new() from plan.json (stage.py), re-checked against root's APPROVED-BUILD.txt
APPS = {'0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9': {'url': 'https://da09d0f2.app.enclave.host/', 'kind': 'html'},       # image-generator
        '0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c': {'url': 'https://9eb4e600.app.enclave.host/ping', 'kind': 'json-ping'}}  # EyesOff
# ---- the API relay's measurement admission (root's SSH, as the Oct-21 admit.py) ------------------------------------------
RELAY = {'env': '/etc/nan-relay/linux-leasegas-measurements.env',
         'dropin': '/etc/systemd/system/enclave-api-relay.service.d/zzzzz-linux-leasegas-measurement.conf',
         'dropinSha256': '21fadc7209de6f7ba82fd614bcddd2fe1ba2cfa9feba988d34ab36b68d5caf9a',
         'installedSha256': '136a65535a104b83bed2251154a97c712a58736abb22e95341217099cd99532c',   # root: the 38-entry admission (37 + b007d471)
         'expectedCount': 38, 'service': 'enclave-api-relay.service'}
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

def require_keeper_stopped(run=subprocess.check_output):
    state = run(['systemctl', '--user', 'show', 'enclave-custody-protected-leases-20261023.service', '-p', 'ActiveState', '--value'], text=True, timeout=10).strip()
    if state not in ('inactive', 'failed'):
        raise AssertionError('temporary lease keeper is not confirmed stopped; refuse concurrent lease signers')

def read_dropins(d=DROPIN_DIR):
    return {p.name: sha(p.read_bytes()) for p in sorted(d.glob('*.conf'))}

def atomic_config(raw, mode, config=CONFIG):
    tmp = config.with_name(config.name + '.custody-restore-tmp'); assert not tmp.exists(), f'{tmp} exists: inspect'
    tmp.write_bytes(raw); tmp.chmod(mode); os.replace(tmp, config)

# ---- the API relay admission ---------------------------------------------------------------------------------------------
def admission_body(remote_body, public_list, new, old=CURRENT['measurement'], priors=PRIORS, expected=RELAY['expectedCount']):
    """-> (existing list in the installed order, the new env file text). Additive: every installed measurement is kept."""
    m = re.fullmatch(r'METAL_ALLOWED_MEASUREMENTS=([0-9a-f,]+)\n', remote_body)
    if not m: raise AssertionError('the installed env file is not exactly one METAL_ALLOWED_MEASUREMENTS= line')
    existing = m.group(1).split(',')
    if not all(MEASUREMENT_RE.fullmatch(x) for x in existing) or len(set(existing)) != len(existing): raise AssertionError('malformed or duplicate measurement')
    if len(existing) != expected: raise AssertionError(f'{len(existing)} installed measurements, the reviewed state is {expected}')
    if set(existing) != set(public_list) or len(public_list) != len(set(public_list)): raise AssertionError('the installed list is not the public allowlist')
    if old not in existing: raise AssertionError('the running measurement is not admitted')
    if any(p not in existing for p in priors): raise AssertionError('ee5df6b8, 08d1f838 or b007d471 is not admitted: the installed state is not the reviewed one')
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

# ---- the new boot's registry lines, RECORDED for root's receipt audit (never a pass/fail input) ------------------------------------
def registry_path(lines):
    """[registry] journal lines -> {path, setProofKeyTx, lines}: which boot registration the new control actually took."""
    txs = [m.group(1) for l in lines for m in [re.search(r'adopted the existing registration .* tx=(0x[0-9a-f]{64})', l)] if m]
    if any(l.startswith('[registry] registered ') for l in lines): path = 'full register()'
    elif txs: path = 'setProofKey + adopt'
    elif any(l.startswith('[registry] adopted the existing registration') for l in lines): path = 'read-only adopt'
    else: path = 'no registration line seen'
    return {'path': path, 'setProofKeyTx': txs[-1] if txs else None, 'lines': [l[:300] for l in lines][-12:]}

def record_registry(result, since, read=None):
    try:
        if read is None:
            r = subprocess.run(['journalctl', '--user', '-u', UNIT, '--since', since, '-o', 'cat', '--no-pager'], capture_output=True, text=True, timeout=30)
            if r.returncode != 0: raise RuntimeError(f'journal unreadable (exit {r.returncode})')
            lines = [l for l in r.stdout.splitlines() if l.startswith('[registry] ')]
        else: lines = read()
        result['registry'] = registry_path(lines)
    except Exception as e: result['registry'] = {'path': 'unrecorded', 'error': f'{type(e).__name__}: {str(e)[:160]}'}

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

# The cutover margin, re-checked immediately before the write (ROOT-MARGIN-REVIEW: the age elapsed at the actual cutover counts):
# every app's lease, as the preflight block saw it minus the seconds since that block, must EXCEED the attach wait + the adoption
# wait + a controlled rollback (120 + 300 + 480 = 900 s). The gate's own duration is NOT pre-paid (staggered 30-min leases can
# never both cover it); the gate is guarded while it runs by gate_watchdog below instead. An addition to preflight_problems
# (unchanged), never a replacement.
CUTOVER_MARGIN_S = ATTACH_S + ADOPT_S + ROLLBACK_MARGIN_S
# FEASIBILITY (H-REVIEW finding 1; root 22:44: REQUIRED): renewals land only in a lease's last 300 s, below the watchdog floor, so
# no renewal can help the gate; a PASS needs attach + adoption and then the gate's full stable 420 s window to end above
# WATCH_FLOOR_S. The cutover therefore needs > WATCH_FLOOR_S + GATE_WINDOW_S + ATTACH_S + ADOPT_S = 600 + 420 + 120 + 300 = 1440 s;
# the 900 s bound above only protects the rollback. Warm-up is not pre-paid (root waits for a paired renewal instead).
GATE_WINDOW_S = 420                        # verify-operational.py --window default, unchanged

def cutover_margin_problems(pre, ids, now, need=None):
    need = max(CUTOVER_MARGIN_S, CUTOVER_FEASIBLE_S) if need is None else need
    out = []
    age = now - float(pre['block']['timestamp'])
    rows = {r['id'].lower(): r for r in pre['rows']}
    for i in ids:
        if i not in rows: out.append(f'{i[:10]}: not in the preflight'); continue
        left = int(rows[i]['leaseRemainingSeconds']) - age
        if left <= need: out.append(f'{i[:10]}: lease {int(left)} s left at the cutover, not > {need} s (rollback bound {CUTOVER_MARGIN_S} = attach {ATTACH_S} + adopt {ADOPT_S} + rollback {ROLLBACK_MARGIN_S}; feasibility {CUTOVER_FEASIBLE_S} = watchdog floor {WATCH_FLOOR_S} + gate window {GATE_WINDOW_S} + attach {ATTACH_S} + adopt {ADOPT_S})')
    return out

def cutover_margins(pre, ids, now):
    """-> {app: seconds left at now} (recorded in result.json so root sees the remaining budget)."""
    age = now - float(pre['block']['timestamp']); rows = {r['id'].lower(): r for r in pre['rows']}
    return {i: int(int(rows[i]['leaseRemainingSeconds']) - age) for i in ids if i in rows}

# ---- the lease watchdog around the UNCHANGED operational gate (ROOT-MARGIN-REVIEW) --------------------------------------------
# While verify-operational.py (gate v4, its defaults untouched) runs as a child, the parent re-reads the leases with the EXISTING
# read-only, quorum-verified preflight.mjs: at the gate start, then every <= WATCH_POLL_S, each read capped at WATCH_READ_S. Each
# verified read fixes every app's expiry (block timestamp + leaseRemainingSeconds at that block); a renewal that lands only moves it
# through a later verified read. The gate is stopped (its whole process group: no orphan) - and the activation fails into the
# normal safe_rollback - when the last verified read is older than WATCH_STALE_S, or any app's expiry is <= WATCH_FLOOR_S away
# (the 480 s rollback + one poll + one read + 15 s). A stopped gate is never a PASS. After a gate PASS a fresh verified read must
# still leave > ROLLBACK_MARGIN_S.
WATCH_POLL_S, WATCH_READ_S = 60, 45
WATCH_STALE_S = WATCH_POLL_S + WATCH_READ_S
WATCH_FLOOR_S = ROLLBACK_MARGIN_S + WATCH_POLL_S + WATCH_READ_S + 15     # = 600
CUTOVER_FEASIBLE_S = WATCH_FLOOR_S + GATE_WINDOW_S + ATTACH_S + ADOPT_S   # = 1440 (see cutover_margin_problems)

def lease_read(ids, run=subprocess.run, evidence=None):
    """One bounded run of preflight.mjs (read-only, 2-of-3 RPC quorum) -> {'blockTs', 'block', 'expiry': {id: unix s}}; raises otherwise."""
    evidence = Path(evidence or EVIDENCE)
    r = run(['node', str(A/'preflight.mjs')], capture_output=True, text=True, timeout=WATCH_READ_S)
    if r.returncode != 0: raise RuntimeError(f'lease read failed ({r.returncode}): {(r.stderr or r.stdout).strip()[-160:]}')
    return parse_lease(json.loads((evidence/'lease-preflight.json').read_text()), ids)

def parse_lease(pre, ids):
    if pre.get('readOnly') is not True or int(pre.get('quorum', 0)) < 2: raise RuntimeError('lease read is not a quorum-verified read-only preflight')
    rows = {x['id'].lower(): x for x in pre['rows']}; ts = int(pre['block']['timestamp'])
    if any(i not in rows or rows[i].get('active') is not True for i in ids): raise RuntimeError('lease read: an app is missing or inactive')
    return {'blockTs': ts, 'block': str(pre['block'].get('number')), 'expiry': {i: ts + int(rows[i]['leaseRemainingSeconds']) for i in ids},
            'holder': {i: [str(rows[i].get('runner')).lower(), str(rows[i].get('runnerOperator')).lower(), rows[i].get('hostActive') is True] for i in ids}}

def read_problems(r, first, now):
    """A verified read is FRESH only if its agreed block is no older than WATCH_STALE_S and not from the future (> 30 s); the
    lease holder (runner, runner operator, host active) must be the gate start's."""
    stale = [] if -30 <= now - r['blockTs'] <= WATCH_STALE_S else [f'agreed block is {int(now - r["blockTs"])} s old (fresh: -30..{WATCH_STALE_S} s)']
    moved = [] if first is None or r.get('holder') == first.get('holder') else ['the lease holder (runner / operator / host active) changed']
    return stale, moved

def stop_gate(proc, grace=10):
    """SIGTERM then SIGKILL the gate's own process group (started with start_new_session), reap it, then SIGKILL the group once
    more so no descendant that outlived its parent (e.g. one ignoring SIGTERM) lingers."""
    import signal
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, grace)):
        try: os.killpg(proc.pid, sig)
        except ProcessLookupError: pass
        try: proc.wait(timeout=wait); break
        except subprocess.TimeoutExpired: continue
    try: os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError: pass

def gate_watchdog(proc, read, ids, wall=time.time, sleep=time.sleep, stop=stop_gate, tick=5, initial=None):
    """-> {'outcome': 'exited', 'returncode': rc, ...} once the gate ends by itself, or {'outcome': 'stopped', 'why': ...} after
    stopping it. Never reports a PASS: the caller still requires the gate's own exit code AND a fresh read after it."""
    reads, errors, last, first, moved, nxt = [], [], None, None, [], wall()
    if initial is not None:   # the FRESH read taken just before the gate (lease_before_gate): its own block age, never reset
        last = first = initial; nxt = initial['readAt'] + WATCH_POLL_S
    while True:
        rc = proc.poll()
        if rc is not None: return {'outcome': 'exited', 'returncode': rc, 'reads': reads, 'readErrors': errors, 'holder': (first or {}).get('holder')}
        now = wall()
        if now >= nxt:
            try:
                r = read(); r['readAt'] = wall()
                stale, moved = read_problems(r, first, r['readAt'])
                if stale: raise RuntimeError('; '.join(stale))
                first = first or r; last = r; nxt = now + WATCH_POLL_S
                reads.append({'at': r['readAt'], 'block': r['block'], 'expiry': r['expiry']})
            except Exception as e:   # retry at the next tick; WATCH_STALE_S since the last VERIFIED read still bounds it
                errors.append({'at': wall(), 'error': f'{type(e).__name__}: {str(e)[:160]}'}); nxt = wall()
            now = wall()
        why = '; '.join(moved) or None
        if why is not None: pass
        elif last is None or now - last['blockTs'] > WATCH_STALE_S: why = 'no fresh verified lease read' + ('' if last is None else f': the last agreed block is {int(now - last["blockTs"])} s old') + f' (> {WATCH_STALE_S} s)'
        else:
            low = {i[:10]: int(e - now) for i, e in last['expiry'].items() if e - now <= WATCH_FLOOR_S}
            if low: why = f'lease margin {low} s <= {WATCH_FLOOR_S} s (rollback {ROLLBACK_MARGIN_S} + poll + read)'
        if why is not None and proc.poll() is None:
            stop(proc)
            return {'outcome': 'stopped', 'why': why, 'returncode': proc.poll(), 'reads': reads, 'readErrors': errors, 'holder': (first or {}).get('holder')}
        sleep(tick)

def lease_problems(r, now, holder, need, when):
    """A read accepted only if FRESH (its agreed block -30..WATCH_STALE_S old), held by `holder`, every lease > need s from expiry."""
    stale, moved = read_problems(r, {'holder': holder} if holder is not None else None, now)
    if holder is None: moved = ['no lease holder to compare with']
    return stale + moved + [f'{i[:10]}: lease {int(e - now)} s left {when}, not > {need} s' for i, e in r['expiry'].items() if e - now <= need]

def fresh_lease(read, holder, need, when, wall=time.time, sleep=time.sleep, tick=5):
    """One fresh verified read, retried for at most WATCH_STALE_S (a failed or stale read retries; a margin or holder problem is
    final). -> (read with readAt, or None, problems)."""
    end, errs = wall() + WATCH_STALE_S, []
    while True:
        try:
            r = read(); r['readAt'] = wall(); p = lease_problems(r, r['readAt'], holder, need, when)
            if not p or not all(x.startswith('agreed block is') for x in p): return (r if not p else None), p
            errs = p
        except Exception as e: errs = [f'{type(e).__name__}: {str(e)[:160]}']
        if wall() >= end: return None, [f'no fresh verified lease read {when} within {WATCH_STALE_S} s: ' + '; '.join(errs)]
        sleep(tick)

def lease_before_gate(read, holder, **kw):   # root 22:44: a fresh read immediately BEFORE the gate seeds the watchdog
    return fresh_lease(read, holder, WATCH_FLOOR_S, 'before the gate', **kw)

def lease_after_gate(read, holder, **kw):    # H-REVIEW finding 3: after a gate PASS, > the 480 s rollback
    return fresh_lease(read, holder, ROLLBACK_MARGIN_S, 'after the gate', **kw)

def after_gate_problems(read_result, now, holder=None):
    return lease_problems(read_result, now, holder, ROLLBACK_MARGIN_S, 'after the gate')

# ---- the reviewed build (build-record.py writes build.json; root reviews it and writes APPROVED-BUILD.txt) --------------------
def git(*args, repo=H_REPO):
    return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, check=True, timeout=60).stdout

def precheck_module(build=BUILD, want=PRECHECK_SHA256):
    """The build folder's own precheck.py (root reviewed a340762), hash-pinned: the SAME source rules the build ran."""
    p = Path(build) / 'precheck.py'
    if sha(p.read_bytes()) != want: raise AssertionError('the build folder precheck.py is not the reviewed one')
    spec = importlib.util.spec_from_file_location('precheck_reviewed', p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

DECISION_RE = re.compile(r'function bootRegistrationAction\(row, want\) \{[\s\S]*?\n\}')
def decision_source(text):
    m = DECISION_RE.findall(text)
    if len(m) != 1: raise AssertionError(f'{len(m)} bootRegistrationAction definitions, not exactly one')
    return m[0]

def source_record(approval_text, repo=H_REPO, pc=None):
    """source_base + the FEE CONTRACT: the approved sendOperatorTx states explicit fresh fees and gas (sender_contract_problems)."""
    rec, sup = source_base(approval_text, repo, pc)
    sender = sender_source(sup.decode())
    p = sender_contract_problems(sender)
    if p: raise AssertionError('the approved sendOperatorTx breaks the fee contract: ' + '; '.join(p))
    return {**rec, 'senderSha256': sha(sender.encode())}

def source_base(approval_text, repo=H_REPO, pc=None):
    """Re-derived from git objects only: precheck.check (single parent 9f6d37bd, exact delta, builder, patch) + the hashes of the
    commit's supervisor.js, gsup.mjs and boot decision; the pending-GPU expectation must be present in both. -> record."""
    pc = pc or precheck_module()
    try: rec, patch, form = pc.check(Path(repo), approval_text)
    except pc.Refused as e: raise AssertionError(f'source refused: {e}')
    sup = git('show', rec['commit'] + ':supervisor.js', repo=repo); gs = git('show', rec['commit'] + ':metal/guest/gsup.mjs', repo=repo)
    if not rec['gsupReviewed']: raise AssertionError('gsup.mjs is unchanged: nothing states the shielded-GPU expectation (root approval says gsup UNCHANGED)')
    if b'SHIELDED_GPU_EXPECTED' not in gs or b'SHIELDED_GPU_EXPECTED' not in sup or b'function gpuPricePending(' not in sup:
        raise AssertionError('the commit does not carry the pending-GPU expectation (SHIELDED_GPU_EXPECTED / gpuPricePending)')
    return {k: rec[k] for k in ('commit', 'parent', 'gsupReviewed', 'tests', 'delta', 'imageFiles')} | {
        'patch': {'form': form, 'sha256': sha(patch)}, 'supervisorSha256': sha(sup), 'gsupSha256': sha(gs),
        'bootDecisionSha256': sha(decision_source(sup.decode()).encode())}, sup

SENDER_RE = re.compile(r'function sendOperatorTx\(address, abi, functionName, args\) \{[\s\S]*?\n\}')
def sender_source(text):
    m = SENDER_RE.findall(text)
    if len(m) != 1: raise AssertionError(f'{len(m)} sendOperatorTx definitions, not exactly one')
    return m[0]

def sender_contract_problems(text):
    """The FEE CONTRACT (the 23:15 rollback; SDK failure scenario, suspected cause): inside the existing operator queue the sender reads fresh fees and gas itself
    and states all three explicitly on writeContract, so viem's eth_fillTransaction path keeps them instead of re-padding them.
    The boot-funding preflight then RUNS this exact text; this check only refuses a sender that cannot be the fix."""
    out = []
    if '_txChain.then(' not in text: out.append('not inside the existing _txChain queue')
    if 'chainClient.estimateFeesPerGas(' not in text: out.append('no fresh chainClient.estimateFeesPerGas()')
    if 'chainClient.estimateContractGas(' not in text: out.append('no fresh chainClient.estimateContractGas()')
    w = re.search(r'wallet\.writeContract\(\{([^}]*)\}\)', text)
    if not w: out.append('no single wallet.writeContract({...}) call')
    elif not all(re.search(r'\b' + k + r'\b', w.group(1)) for k in ('gas', 'maxFeePerGas', 'maxPriorityFeePerGas')): out.append('writeContract does not state gas, maxFeePerGas and maxPriorityFeePerGas')
    return out

def parse_inventory(text, name):
    """`<sha256>  <name>/<file>` lines -> {file: sha256}; refuses anything else, any other file or a duplicate."""
    inv = {}
    for l in text.splitlines():
        m = re.fullmatch(r'([0-9a-f]{64})  ' + re.escape(name) + r'/([A-Za-z0-9._-]+)', l)
        if not m or m.group(2) in inv: raise AssertionError(f'inventory line {l[:100]!r} is not one file of {name}')
        inv[m.group(2)] = m.group(1)
    if sorted(inv) != sorted(FILES): raise AssertionError(f'inventory files {sorted(inv)} are not {FILES}')
    return inv

def build_markers(files):
    """Every line build-price.sh prints on success for these image files, each exactly once (the strings it echoes)."""
    w9 = sorted([p[1:] for p in files] + ['opt/metal/manifest.json']); wp = sorted(set(w9) | {'opt/metal/gsup.mjs'})
    src = sorted({p[1:] for p in files} | {'opt/metal/gsup.mjs'})
    return ([f'CONTROL-IDENTICAL {f}' for f in ('initramfs.cpio.gz', 'vmlinuz', 'cmdline', 'manifest.json')]
            + [f'REPRODUCIBLE {f}' for f in ('initramfs.cpio.gz', 'vmlinuz', 'cmdline', 'manifest.json')]
            + [f'MANIFEST-DELTA-EXACT {files!r}', f'ENTRY-DELTA-EXACT vs 08d1 {w9!r} vs production {wp!r}', f'IMAGE-FILES-ARE-SOURCE {src!r}',
               'UNCHANGED vmlinuz', 'UNCHANGED cmdline', 'MEASURE-RECIPE-REPRODUCES ed918e4b', 'MEASURE-RECIPE-REPRODUCES ee5df6b8',
               'MEASURE-RECIPE-REPRODUCES 08d1f838', '[queue] EXIT 0'])

def build_problems(log_text, approved_text, record_text, inventory_text, measurement_text, src):
    """The COMPLETED build-price.sh run of exactly the re-derived source record src. -> (build.json record, problems)."""
    out = []
    lines = log_text.splitlines()
    try: brec = json.loads(record_text)
    except ValueError: return None, ['stage/build-record.json is not JSON']
    keys = ('commit', 'parent', 'gsupReviewed', 'tests', 'delta', 'imageFiles')
    if {k: brec.get(k) for k in keys} != {k: src[k] for k in keys}: out.append('build-record.json is not a build of the re-derived source')
    if (brec.get('patch') or {}).get('sha256') != src['patch']['sha256'] or (brec.get('patch') or {}).get('form') != src['patch']['form']:
        out.append('build-record.json names another source patch')
    pcl = [l for l in lines if l.startswith('PRECHECK-PASS ')]
    if len(pcl) != 1: out.append(f'{len(pcl)} PRECHECK-PASS lines, not one')
    else:
        try: logged = json.loads(pcl[0][len('PRECHECK-PASS '):])
        except ValueError: logged = None
        if logged != {k: brec.get(k) for k in (logged or {})} or not logged or set(logged) != set(keys) | {'patch'}: out.append('the logged precheck is not build-record.json\'s')
    for w in build_markers(src['imageFiles']):
        if lines.count(w) != 1: out.append(f'build log: {w[:90]!r} appears {lines.count(w)} times, not once')
    if any(re.search(r'REFUSED|DIFFERS|NOT-REPRODUCIBLE|MISMATCH|VERIFY-FAILED|(?<!UN)CHANGED |CANDIDATE-EQUALS|Traceback|AssertionError', l) for l in lines):
        out.append('build log reports a refusal or failure')
    ms = [l.split(' ', 1)[1] for l in lines if l.startswith('MEASURE-CANDIDATE ')]
    m = ms[0] if len(ms) == 1 else None
    if m is None or not MEASUREMENT_RE.fullmatch(m): out.append('build log: not exactly one well-formed MEASURE-CANDIDATE'); m = None
    elif m in [CURRENT['measurement']] + PRIORS: out.append('the candidate measurement is a previous image\'s')
    if m is not None and (measurement_text != m + '\n' or brec.get('measurement') != m): out.append('MEASUREMENT / build-record.json do not name the logged candidate')
    name = 'dist-leasegas-' + src['commit'][:9]
    try: inv = parse_inventory(inventory_text, name)
    except AssertionError as e: return None, out + [str(e)]
    logged_inv = [l for l in lines if re.fullmatch(r'[0-9a-f]{64}  ' + re.escape(name) + r'/\S+', l)]
    if sorted(logged_inv) != sorted(inventory_text.splitlines()): out.append('the logged inventory is not stage INVENTORY.sha256')
    if brec.get('inventory') != {f'{name}/{f}': h for f, h in inv.items()}: out.append('build-record.json inventory is not INVENTORY.sha256')
    br = [l for l in lines if l.startswith('BUILD-RECORD ')]
    if br != [f'BUILD-RECORD {sha(record_text.encode())}']: out.append('the logged BUILD-RECORD hash is not build-record.json\'s')
    for f in ('cmdline', 'vmlinuz'):
        if inv[f] != NINE['files'][f]: out.append(f'{f} changed: only the initramfs and manifest may differ')
    for f in ('initramfs.cpio.gz', 'manifest.json'):
        if inv[f] == NINE['files'][f]: out.append(f'{f} equals 08d1\'s: not the new build')
    if measurement_text is not None and sha(measurement_text.encode()) != inv['MEASUREMENT']: out.append('MEASUREMENT does not hash to its inventory entry')
    rec = {**src, 'measurement': m, 'name': name, 'files': inv, 'approvedCommitSha256': sha(approved_text.encode()),
           'buildRecordSha256': sha(record_text.encode()), 'buildLogSha256': sha(log_text.encode())}
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
    c = str(rec.get('commit', ''))
    if (rec.get('parent'), rec.get('name')) != (PARENT, 'dist-leasegas-' + c[:9]) or not re.fullmatch(r'[0-9a-f]{40}', c) or c == PARENT:
        raise AssertionError('build.json is not a build of a child of 9f6d37bd')
    if not MEASUREMENT_RE.fullmatch(str(rec.get('measurement'))) or rec['measurement'] in [CURRENT['measurement']] + PRIORS:
        raise AssertionError('build.json carries no new measurement')
    for k in ('supervisorSha256', 'gsupSha256', 'bootDecisionSha256', 'senderSha256'):
        if not re.fullmatch(r'[0-9a-f]{64}', str(rec.get(k))): raise AssertionError(f'build.json has no {k}')
    return rec, sha(raw)

def load_new(a=None, want_build=APPROVED_BUILD_SHA256, want_plan=PLAN_SHA256):
    """The candidate from the fee kit's plan.json (stage.py), re-checked against root's approval AND the pinned build/plan hashes:
    never a measurement from anywhere else."""
    a = Path(a or FEEKIT); global NEW
    rec, h = approved_build(a/'build.json', a/'APPROVED-BUILD.txt')
    if want_build is not None and h != want_build: raise AssertionError('build.json is not the approved 5db2be3f build this kit pins')
    if want_plan is not None and sha((a/'plan.json').read_bytes()) != want_plan: raise AssertionError('plan.json is not the staged plan this kit pins')
    plan = json.loads((a/'plan.json').read_text())
    if plan.get('buildSha256') != h or plan.get('measurement') != rec['measurement'] or plan.get('files') != rec['files']:
        raise AssertionError('plan.json is not the approved build')
    NEW = {'commit': rec['commit'], 'dist': plan['image'], 'measurement': rec['measurement'], 'files': rec['files'], 'buildSha256': h,
           'supervisorSha256': rec['supervisorSha256'], 'bootDecisionSha256': rec['bootDecisionSha256'], 'senderSha256': rec['senderSha256'], 'name': rec['name']}
    return NEW

# ---- the shielded-GPU expectation the new gsup states, derived from host config (never assumed) --------------------------------
# The pinned launcher (WorkingDirectory metal-deabf8f90, metal/enclave-metal.mjs:307) sets runtimeCfg.isolationShieldedWorkers to
# the two ports 9501/9502 exactly when config.json isolation.shieldedInference === true (with valid shieldedPricing; :308-310), and
# the reviewed gsup counts those workers into SHIELDED_GPU_EXPECTED. Without it the new boot would NOT pend and would compare a 0.
LAUNCHER = {'path': CURRENT['workingDirectory'] + '/metal/enclave-metal.mjs', 'sha256': 'd59a6cab9a698ea53f7c6d064588988997bebf748eba42193b0a443be32c1cda',
            'ports': [9501, 9502]}

def shielded_expectation_problems(config_raw, launcher_raw, L=LAUNCHER):
    """-> (expected card count, problems)."""
    out = []
    if sha(launcher_raw) != L['sha256']: out.append('the launcher is not the pinned metal-deabf8f90 enclave-metal.mjs')
    if b"runtimeCfg.isolationShieldedWorkers = [9501,9502].map(" not in launcher_raw: out.append('the launcher no longer derives the two shielded workers')
    iso = json.loads(config_raw).get('isolation')
    if not isinstance(iso, dict): return 0, out + ['config.json has no isolation object: the boot states no shielded-GPU expectation']
    if iso.get('shieldedInference') is not True: return 0, out + ['config.json isolation.shieldedInference is not true: the boot states no shielded-GPU expectation']
    pr = iso.get('shieldedPricing')
    ok = isinstance(pr, dict) and all(isinstance(pr.get(k), (int, float)) and not isinstance(pr.get(k), bool) and 0 <= pr[k] <= 100 for k in ('tflopUsdHr', 'vramGiBUsdHr'))
    if not ok or pr['tflopUsdHr'] + pr['vramGiBUsdHr'] <= 0: out.append('config.json isolation.shieldedPricing is invalid: the launcher would refuse to start')
    return (len(L['ports']) if not out else 0), out

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
    # supervisor.js RPC_POOL (no BASE_RPC/BASE_RPCS in the image env): every write is priced on every member, the worst counts
    'pool': ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base'],
    # the ROLLBACK image (deabf8f90 = ed918e4b): its plain writeContract sendOperatorTx, sliced from git deabf8f90:supervisor.js
    'oldSender': {'commit': 'deabf8f90f64902d20d48620fd911d34c445859d', 'senderSha256': '63572e71795f4f0f2e57e8523cc3260fb2242adaf61fdface549330809992792'},
}

def ceil_pct(x, pct): return (int(x) * pct + 99) // 100

def write_worst(block, pool, explicit, what):
    """One write priced on every pool member -> (worst wei, problems). explicit: the approved sender states gas and fees and viem
    must keep them; otherwise (the rollback image's plain sender) it states nothing and the PREPARED values are what it signs."""
    out, worsts = [], []
    rows = block['perRpc']
    if [r['rpc'] for r in rows] != list(pool): return 0, [f'{what}: not priced on every node-pool member (cannot bound it: refuse)']
    for r in rows:
        sent = (r['senderGas'], r['senderMaxFeePerGas'], r['senderMaxPriorityFeePerGas'])
        prep = (r['gas'], r['maxFeePerGas'], r['maxPriorityFeePerGas'])
        if any(x is None or not str(x).isdigit() or int(x) <= 0 for x in prep): out.append(f"{what} {r['rpc']}: no prepared gas/fees"); continue
        if explicit:
            if any(x is None or not str(x).isdigit() or int(x) <= 0 for x in sent): out.append(f"{what} {r['rpc']}: the sender did not state explicit gas and fees")
            elif prep != sent: out.append(f"{what} {r['rpc']}: viem would not send the sender's own gas/fees (prepared {r['maxFeePerGas']} vs stated {r['senderMaxFeePerGas']}: re-priced by the fill path)")
        elif sent != (None, None, None): out.append(f"{what} {r['rpc']}: the rollback sender stated fees - not the deabf8f90 plain writeContract path")
        if not str(r.get('operatorFeeWei', '')).isdigit(): out.append(f"{what} {r['rpc']}: the operator fee is undetermined"); continue
        w = int(r['gas']) * int(r['maxFeePerGas']) + int(r['l1FeeUpperBoundWei']) + int(r['operatorFeeWei'])
        if int(r['worstCaseWei']) != w: out.append(f"{what} {r['rpc']}: worst case does not add up")
        worsts.append(w)
    worst = max(worsts) if worsts else 0
    if len(worsts) != len(pool) or int(block['worstCaseWei']) != worst: out.append(f'{what}: the worst case is not the worst node-pool member')
    return worst, out

def boot_funding_problems(f, now, new, P=FUNDING):
    out = []
    lc = lambda x: str(x if x is not None else '').lower()
    try:
        age = now - int(f['block']['timestamp'])
        if age >= P['maxAgeS'] or age < -30: out.append(f'funding preflight is {int(age)} s old: re-run it (< {P["maxAgeS"]} s)')
        if f.get('readOnly') is not True: out.append('not a read-only preflight')
        if len(f['rpcs']) != 2 or len({lc(u) for u in f['rpcs']}) != 2: out.append('not two distinct RPCs')
        if f['chainIds'] != [8453, 8453]: out.append('not Base on both RPCs')
        if f['source'] != {'commit': new['commit'], 'supervisorSha256': new['supervisorSha256'], 'bootDecisionSha256': new['bootDecisionSha256'], 'senderSha256': new['senderSha256']}:
            out.append('the decision was not sliced from the approved build\'s supervisor.js')
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
        SET = {'action': 'setProofKey', 'reason': 'only the proof key differs'}
        if f['actions'] != {'pending': SET, 'discovered': SET}: out.append(f'the approved boot decision is {f["actions"]}, not setProofKey both while the GPU price is pending and once discovered')
        if f['desiredPending'] != {**d, 'gpuPricePerSec6': None}: out.append('the pending decision was not asked with a null (pending) GPU price and otherwise the same fields')
        o = f['operator']; n = int(o['nonceAtBlock'])
        if [int(x) for x in o['latest']] != [n, n] or [int(x) for x in o['pending']] != [n, n]: out.append('operator nonce/pending disagree: a transaction is in flight or just landed')
        # FEES (final recovery): every write as ITS image's sender prepares it through viem, on EVERY node-pool member - never a model
        fe = f['fees']
        if fe.get('isthmus') is not True: out.append('the operator fee is undetermined')
        if f['pool'] != P['pool']: out.append('the writes were not priced on exactly the node RPC pool')
        cand, p1 = write_worst(f['setProofKey'], P['pool'], explicit=True, what='candidate setProofKey'); out += p1
        rb = f['rollback']
        if rb['sender'] != P['oldSender']: out.append('the rollback was not priced through the pinned deabf8f90 sender')
        reg, p2 = write_worst(rb['register'], P['pool'], explicit=False, what='rollback register'); out += p2
        spx, p3 = write_worst(rb['setPrices'], P['pool'], explicit=False, what='rollback setPrices'); out += p3
        reserve_c, reserve_r = ceil_pct(cand, P['headroomPct']), ceil_pct(reg + spx, P['headroomPct'])
        bal = int(o['balanceWei'])
        if bal < reserve_c + reserve_r:
            out.append(f'balance {bal} wei cannot reserve the candidate setProofKey ({reserve_c} = {P["headroomPct"]}% of {cand}) AND the rollback '
                       f'register + setPrices ({reserve_r} = {P["headroomPct"]}% of {reg + spx}): short {reserve_c + reserve_r - bal} wei')
    except (KeyError, TypeError, ValueError) as e: out.append(f'malformed funding preflight: {type(e).__name__} {e}')
    return out

def boot_funding(rpcs, new, out_path, now=None, node='node', run=subprocess.run):
    """Run boot-funding.mjs (read-only) on the approved build's decision and decide. -> (facts, problems)."""
    r = run([node, str(A/'boot-funding.mjs'), '--rpc', rpcs[0], '--rpc', rpcs[1], '--commit', new['commit'], '--supervisor-sha256', new['supervisorSha256'],
             '--decision-sha256', new['bootDecisionSha256'], '--sender-sha256', new['senderSha256'], '--out', str(out_path)],
            capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or '').strip(); first = next((l.strip() for l in err.splitlines() if re.match(r'\s*(\w*Error|Error):', l)), err[-300:])
        return None, [f'boot-funding.mjs failed ({r.returncode}): {first[:300]}']
    f = json.loads(Path(out_path).read_text())
    return f, boot_funding_problems(f, time.time() if now is None else now, new)

# ---- keep: ACTUAL normal renewal attribution (not /availability alone) --------------------------------------------------------
# For each app: the tx hash the NEW control itself logged ("[lease-gas] renew <id> landed in <tx>", renewal-watch.py, journal since
# this activation) must have the SAME successful receipt on two RPCs, carrying the ledger's Renewed(id, enclaveId, ...) log for
# THAT app and metal0's enclave id, in a block after the attachment. (The protected keeper also renews for metal0's enclave id,
# so the event alone cannot attribute a renewal: the hash must come from the new control's own journal, and root stops the keeper
# before the cutover - HANDOFF.md.)
LEDGER = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b'                                   # lease-gas deployment record (digest 1665c2...)
RENEWED_TOPIC = '0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e'    # keccak256("Renewed(bytes32,bytes32,uint64,uint256)")
ENCLAVE_ID = '0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be'       # keccak256("https://api.enclave.host/t/metal0")
CANON_RECEIPT = ('transactionHash', 'blockHash', 'blockNumber', 'status')

def renewal_attribution_problems(app, tx, receipts, block_ts, attached_ts):
    """receipts: the tx's receipt from two RPCs; block_ts: the agreed timestamp of its block. -> problems (empty = attributed)."""
    if not re.fullmatch(r'0x[0-9a-f]{64}', str(tx or '')): return [f'{app[:10]}: no renewal tx logged by the new control']
    if len(receipts) != 2 or any(not isinstance(x, dict) for x in receipts): return [f'{app[:10]}: {tx[:12]} has no receipt on both RPCs']
    if any({k: str(x.get(k)).lower() for k in CANON_RECEIPT} != {k: str(receipts[0].get(k)).lower() for k in CANON_RECEIPT} for x in receipts):
        return [f'{app[:10]}: the two RPCs disagree on the receipt of {tx[:12]}']
    out, rc = [], receipts[0]
    if str(rc.get('transactionHash')).lower() != tx.lower(): out.append(f'{app[:10]}: receipt is for another transaction')
    if rc.get('status') != '0x1': out.append(f'{app[:10]}: {tx[:12]} did not succeed')
    hit = [l for l in rc.get('logs') or [] if str(l.get('address')).lower() == LEDGER and [str(t).lower() for t in (l.get('topics') or [])[:3]] == [RENEWED_TOPIC, app.lower(), ENCLAVE_ID]]
    if len(hit) != 1: out.append(f'{app[:10]}: {tx[:12]} carries no ledger Renewed log for this app and metal0')
    if block_ts is None or attached_ts is None or block_ts <= attached_ts: out.append(f'{app[:10]}: {tx[:12]} is not after the attachment')
    return out

def renewal_receipts(tx, rpcs=RPCS[:2], call=None):
    """-> (receipts from two RPCs, the agreed block timestamp or None). Read-only."""
    call = call or rpc
    recs = []
    for u in rpcs:
        try: recs.append(call(u, 'eth_getTransactionReceipt', [tx]))
        except Exception: recs.append(None)
    ts = None
    if all(isinstance(x, dict) for x in recs) and recs[0].get('blockHash'):
        try:
            bs = [call(u, 'eth_getBlockByHash', [recs[0]['blockHash'], False]) for u in rpcs]
            if all(isinstance(b, dict) for b in bs) and len({(b['hash'], b['timestamp']) for b in bs}) == 1: ts = int(bs[0]['timestamp'], 16)
        except Exception: ts = None
    return recs, ts

# ---- keep: a STRICT fresh attestation verdict for the recovery target (never a substring of some evidence file) ----------------
# The schema is attest-control/1's (as the first attempt's check-attestation-verdict.py), generalized from the pinned ee5df6b8 to
# the approved candidate: a PASSED verdict, every required check PASS, observed == expected == the approved measurement, bound
# to the verifier's own nonce, VMPL 0, produced AFTER this activation attached and at most VERDICT_MAX_AGE_S before the keep,
# with its private raw answer (0600) hashing to rawSha256.
VERDICT_REQUIRED = ['report shape', 'product line', 'guest policy', 'chain', 'tcb policy', 'measurement', 'binding']
VERDICT_MAX_AGE_S = 1800

def attestation_verdict_problems(v, want, attached_at, now, raw_path, build_sha=None):
    out = []
    if not isinstance(v, dict): return ['the attestation evidence is not a verdict object']
    if v.get('probe') != 'attest-control/1' or v.get('wrapper') != 'attest-price/1': out.append('not an attest-price.mjs attest verdict')
    if v.get('buildSha256') != build_sha or not re.fullmatch(r'[0-9a-f]{64}', str(build_sha)): out.append('the verdict is not for the approved build.json')
    if v.get('target') != 'priceRecovery' or v.get('accepted') is not True: out.append(f"target {v.get('target')!r} / accepted {v.get('accepted')!r}: the wrapper did not accept it")
    if v.get('pass') is not True: out.append('pass is not true')
    if v.get('status') != 'verified' or v.get('admissionSafe') is not True: out.append(f"status {v.get('status')!r} / admissionSafe {v.get('admissionSafe')!r}")
    if not MEASUREMENT_RE.fullmatch(str(want)) or v.get('expectedMeasurement') != want or v.get('observedMeasurement') != want or v.get('measurementMatches') is not True:
        out.append('the verdict is not for the approved measurement')
    req = v.get('required') or {}
    for k in VERDICT_REQUIRED:
        if req.get(k) != 'PASS': out.append(f'required check {k!r} is {req.get(k)!r}')
    if v.get('freshness') != 'verifier nonce' or not re.fullmatch(r'[0-9a-f]{64}', str(v.get('nonce', ''))): out.append('not bound to the verifier nonce')
    if v.get('vmpl') != 0: out.append(f"vmpl {v.get('vmpl')!r}")
    if v.get('failedChecks') != []: out.append(f"failed checks {v.get('failedChecks')!r} (must be exactly [])")
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
