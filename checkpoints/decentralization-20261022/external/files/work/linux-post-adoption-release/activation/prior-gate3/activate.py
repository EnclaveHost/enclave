# ROOT EXECUTES from /home/steven/Documents/Codex/2026-10-18/wo (prepared by Claude 2026-10-21; derived from
# linux-corrected-release/activation/activate.py, whose run ended in the 06:32Z incident; that directory, its
# private-backup and result are never read here except result.json's public fields).
#   python3 work/linux-post-adoption-release/activation/activate.py --availability <metal0 public /availability URL>
# Phases (each must pass, else SAFE ROLLBACK: stop the new control, wait out every sponsored deadline it logged on a
# block two public RPCs agree on, restore config + drop-in by compare-and-swap, start the previous control):
#  0. preconditions: the 51516b778 activation is recorded rolled back; production config/WorkingDirectory are the
#     previous control's; the new admission is installed; a fresh funding/lease preflight; the PRE-CUTOVER BASELINE
#     (mandatory): both apps actually healthy NOW by apphealth.py (EyesOff /ping ok+pong; image-generator's HTML page, its
#     <title> recorded as its identity -> apps-health.json) and /availability naming the guest each app runs now;
#  1. attach: the public attestation shows admittedAtAttach == this release's measurement within 120 s;
#  2. adoption: "[claim] <id> adopted:" for both apps within 300 s, each adopting the SAME guest the baseline named
#     ("[isolation] <id10>: adopted guest <vm>" must equal it);
#  3. the operational gate v3 (verify-operational.py): <= 300 s warm-up, then 420 s continuous ACTUAL app health, the
#     baseline guest ids held running and owned, >= 2 completed vouch cycles, journal readable (fails closed), finite
#     deadline; no death/reap/release/respawn/relaunch line;
#  4. app-paid renewal: a "[lease-gas] renew <id> landed in <tx>" line (a quorum-verified receipt paid by the app's
#     reserve) for BOTH apps within --renew-limit seconds, every poll actually healthy (apphealth.py, no tolerance).
# Then the state is PROVISIONAL: root audits both renewal transactions on chain and runs keep.py (or rollback.py).
# Only this host's config.json and the drop-in are written (fresh private-backup/ here); guestd is never touched.
import argparse, datetime, hashlib, json, re, secrets, subprocess, sys, time, urllib.request
from common import *
import apphealth
ap = argparse.ArgumentParser()
ap.add_argument('--availability', required=True)
ap.add_argument('--renew-limit', type=int, default=3600)
args = ap.parse_args()
os.umask(0o077)
plan = json.loads((A/'plan.json').read_text()); ad = json.loads((A/'admission.json').read_text())
apps = plan['apps']; ids = list(apps)
ATTACH_S, ADOPT_S = 120, 300
assert ad['stage'] in ('installed; public endpoint recheck pending', 'verified active; old control still connected')
prev = json.loads((W/'work/linux-corrected-release/activation/result.json').read_text())
assert prev.get('productionActivated') is False and 'rolled back' in prev.get('state', ''), 'the 51516b778 activation is not recorded rolled back'
pre = json.loads((W/'outputs/decentralization-audit/linux-conduit-funding-preflight.json').read_text()); age = time.time() - float(pre['block']['timestamp'])
assert age < 360, 'refresh funding/lease preflight before cutover'
rows = {r['id'].lower(): r for r in pre['rows']}
assert set(ids) <= set(rows), 'the preflight does not cover both apps'
assert all(int(rows[i]['leaseRemainingSeconds']) - age > 480 + ADOPT_S for i in ids), 'not enough lease margin for adoption and a controlled rollback'
assert all(rows[i]['reserve']['enabled'] and int(rows[i]['reserve']['balanceWei']) > 0 for i in ids)
backup = A/'private-backup'
assert not backup.exists() and not DROP.exists() and not (A/'result.json').exists()
old = CONFIG.read_bytes(); c = json.loads(old)
assert c['dist'] == PREV_DIST and c.get('mode') == 'snp' and not c.get('leaseGas') and not c.get('direct')
working = subprocess.check_output(['systemctl', '--user', 'show', UNIT, '-p', 'WorkingDirectory', '--value'], text=True).strip()
assert working == PREV_WORKDIR
for k in ('release', 'image'): assert Path(plan[k]).is_dir()

def get(url, timeout=12):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'user-agent': 'enclave-activation/1'}), timeout=timeout) as r: return r.status, r.read(1 << 20)
    except urllib.error.HTTPError as e: return e.code, b''
    except Exception as e: return None, type(e).__name__.encode()
# the pre-cutover baseline, mandatory: actual health (one definition: apphealth.py) and the guest each app runs now
KIND = {'0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c': 'json-ping',      # EyesOff /ping
        '0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9': 'html'}           # image-generator /
assert set(KIND) == set(ids)
specs = {}
for i, u in apps.items():
    spec = {'url': u, 'kind': KIND[i]}
    if KIND[i] == 'html':
        st, ctype, body = apphealth.fetch(u); spec.update(minBytes=1024, title=apphealth.title_of(body) if st == 200 else None)
    ok, detail = apphealth.check(spec)
    assert ok, f'{i[:10]} is not actually healthy BEFORE the cutover ({detail}): no baseline to hold the new control to'
    specs[i] = spec
(A/'apps-health.json').write_text(json.dumps(specs, indent=2) + '\n'); apphealth.load_specs(A/'apps-health.json', ids)
st, body = get(args.availability); assert st == 200, f'/availability -> {st}'
held = (json.loads(body).get('instanceSweep') or {}).get('held') or []
snap = {}
for i in ids:
    h = [x for x in held if str(x.get('id', '')).lower() == i]
    assert len(h) == 1 and h[0].get('status') == 'running' and re.fullmatch(r'[A-Za-z0-9-]{1,64}', str(h[0].get('vm'))), \
        f'the previous control does not publish the guest {i[:10]} runs ({h}): the baseline guest id is mandatory'
    snap[i] = h[0]['vm']

backup.mkdir(mode=0o700); (backup/'config.json').write_bytes(old); (backup/'config.json').chmod(0o600)
mode = CONFIG.stat().st_mode & 0o777
c.update(dist=plan['image'], leaseGas=plan['leaseGas']); new = (json.dumps(c, indent=2) + '\n').encode()
body_drop = '[Service]\nWorkingDirectory=' + plan['release'] + '\n'
result = {'startedAt': utc(), 'measurement': plan['measurement'], 'commit': plan['commit'], 'configBeforeSha256': hashlib.sha256(old).hexdigest(),
          'configAfterSha256': hashlib.sha256(new).hexdigest(), 'release': plan['release'], 'image': plan['image'], 'state': 'starting',
          'preCutoverGuests': snap, 'appsHealth': specs, 'adoption': {}, 'guests': {}, 'renewals': {}, 'productionActivated': False}
def save(): (A/'result.json').write_text(json.dumps(result, indent=2) + '\n')
BAD = [re.compile(p) for p in (r'^\[bill\] (\S+) (instance respawned|respawn failed)', r'^\[claim\] (\S+) (app instance died|app died|lease lost|lease looks lost)',
                               r'^\[instance\] reaped orphan (\S+)', r'^\[release\] (\S+) ', r'^\[isolation\] (0x[0-9a-f]{8}): guest \S+ app ')]
def bad(lines):
    out = []
    for l in lines:
        for r in BAD:
            m = r.match(l)
            if m and any(i == m.group(1).lower() or i.startswith(m.group(1).lower()) and len(m.group(1)) == 10 for i in ids): out.append(l[:200])
    return out
save(); mutated = False
since = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'); result['journalSince'] = since
try:
    assert CONFIG.read_bytes() == old
    atomic_config(new, mode); mutated = True; DROP.write_text(body_drop); DROP.chmod(0o644); restart()
    print('Control restarted; awaiting fresh hardware-attested attachment.', flush=True)
    end = time.monotonic() + ATTACH_S
    while time.monotonic() < end:
        st, b = get('https://api.enclave.host/v1/enclaves/metal0/attestation?nonce=' + secrets.token_hex(32))
        try:
            if st == 200 and json.loads(b).get('operatorAllowlist', {}).get('admittedAtAttach') == plan['measurement']:
                subprocess.run(['systemctl', '--user', 'is-active', '--quiet', UNIT], check=True)
                result.update(state='attached; adoption pending', attachedAt=utc()); save(); print(result['state'], flush=True); break
        except ValueError: pass
        result['lastObservationError'] = str(st); save(); time.sleep(5)
    else: raise RuntimeError(f'the new measurement did not attach within {ATTACH_S} s')
    end = time.monotonic() + ADOPT_S
    while time.monotonic() < end:
        lines = journal(since)
        if bad(lines): raise RuntimeError('during adoption: ' + ' | '.join(bad(lines)))
        for i in ids:
            if i not in result['adoption']:
                a = next((l for l in lines if l.startswith('[claim] ' + i + ' adopted:')), None)
                g = next((m.group(1) for l in lines for m in [re.match(r'^\[isolation\] ' + i[:10] + r': adopted guest (\S+) ', l)] if m), None)
                if a and g: result['adoption'][i] = a; result['guests'][i] = g; save(); print(a, '<-', g, flush=True)
        result['refusals'] = [l[:200] for l in lines if 'no free capacity' in l or 'holding new claims' in l][-6:]; save()
        if len(result['adoption']) == len(ids): break
        time.sleep(5)
    else: raise RuntimeError(f'both apps were not adopted (with their guest) within {ADOPT_S} s')
    for i in ids:
        if result['guests'][i] != snap[i]: raise RuntimeError(f'{i[:10]} adopted {result["guests"][i]}, not the guest {snap[i]} the previous control ran')
    result.update(state='adopted the same guests; operational gate running'); save(); print(result['state'], flush=True)
    gate = [sys.executable, str(A/'verify-operational.py'), '--availability', args.availability, '--apps-json', str(A/'apps-health.json'),
            '--since', since, '--out', str(A/'gate.json')]
    for i in ids: gate += ['--expect-guest', f'{i}={snap[i]}']   # the pre-cutover baseline, never an inferred id
    if subprocess.run(gate).returncode != 0: raise RuntimeError('the operational gate FAILED: ' + json.dumps(json.loads((A/'gate.json').read_text()).get('why'))[:400])
    result.update(state='operational gate PASSED; app-paid renewals pending', gatePassedAt=utc()); save(); print(result['state'], flush=True)
    end = time.monotonic() + args.renew_limit
    while time.monotonic() < end:
        lines = journal(since)
        if bad(lines): raise RuntimeError('during the renewal wait: ' + ' | '.join(bad(lines)))
        for i in ids:
            m = next((m for l in lines for m in [re.match(r'^\[lease-gas\] renew ' + i + r' landed in (0x[0-9a-f]{64})', l)] if m), None)
            if m and i not in result['renewals']: result['renewals'][i] = m.group(1); save(); print('app-paid renewal', i[:10], m.group(1), flush=True)
            ok, detail = apphealth.check(specs[i])
            if not ok: raise RuntimeError(f'{i[:10]} not actually healthy during the renewal wait ({detail})')
        result['renewalWarnings'] = [l[:200] for l in lines if l.startswith('[lease-gas] ') and ' not sent' in l][-6:]; save()
        if len(result['renewals']) == len(ids): break
        time.sleep(15)
    else: raise RuntimeError(f'no app-paid renewal of both apps within {args.renew_limit} s')
    result.update(state='PROVISIONAL: operational gate passed and both apps renewed app-paid (journal, quorum-verified receipts); '
                        'root chain audit of the renewal transactions and keep.py pending', productionActivated='provisional', provisionalAt=utc())
    save(); print(result['state'], json.dumps(result['renewals']), flush=True)
except BaseException as e:
    result.update(state='activation failed; safe rollback pending', error=type(e).__name__, detail=str(e)[:600]); save()
    print('FAILED:', result['detail'], flush=True)
    if mutated:
        safe_rollback(result, save, since=since, old_config=old, new_config=new, drop_body=body_drop, rpcs=plan['leaseGas']['rpcs'])
        print(result['state'], flush=True)
    raise
