# PHASE 4 (ROOT EXECUTES after phases B, 0-3c and review):
#   python3 work/custody-boot-activation-20261023/activate.py --guestd-vms <root's private GET /vms answer, <= 300 s old>
# SECOND image-only cutover: config.json "dist" deabf8f90 -> the ROOT-APPROVED build of 9f6d37bd (dist-leasegas-9f6d37bd8; plan.json
# re-checked against APPROVED-BUILD.txt). Phases, each must pass, else SAFE ROLLBACK (common.safe_rollback, unchanged: stop the
# new control, wait out every sponsored deadline it logged on a block two public RPCs agree on, CAS-restore config.json, start
# the previous control):
#  0. preconditions, read-only: staged image hashes = the approved build; admission verified (public allowlist = the 36 + the
#     candidate; attached at ed918e4b); a fresh lease/funding preflight (< 360 s) for both apps with margin; protected fields =
#     the baseline (config sha 58aa9653, dist, leaseGas digest 3570d2, WorkingDirectory metal-deabf8f90, KillMode control-group,
#     the two drop-ins' hashes); the pre-cutover baseline from root's AUTHENTICATED guestd listing (prebaseline.collect: exactly
#     the original 21:31Z guests gd9d4a391d / gdd0646f2c, running, record digests; /availability held recorded as it is - absent
#     now, the old control adopted nothing); actual app health NOW; and LAST, immediately before the write, the MANDATORY
#     boot-funding preflight (boot-funding.mjs + boot_funding_problems: the reviewed boot decision is exactly setProofKey, nothing
#     in flight, delegation/registry unchanged, worst case at viem default fees <= balance with 25% headroom).
#  1-5. UNCHANGED from the first attempt: the one write (ONLY dist; fresh private-backup/ in THIS folder), restart, attach of the
#     candidate within 120 s, both apps adopted with the SAME guests within 300 s (the new boot first sends its one setProofKey and
#     adopts the registry row after the receipt + an exact re-read), the reviewed gate v4 byte copy at its defaults, renewals
#     recorded, PROVISIONAL. A rollback does NOT restore the host's registry registration (see rollback.py).
import argparse, json, re, subprocess, sys, time
from common import *
import apphealth, guestrows, prebaseline
ap = argparse.ArgumentParser(); ap.add_argument('--availability', default='https://api.enclave.host/t/metal0/availability')
ap.add_argument('--guestd-vms', required=True); ap.add_argument('--funding-rpc', action='append')
args = ap.parse_args()
NEW = load_new(); rpcs = args.funding_rpc or RPCS[:2]; assert len(rpcs) == 2, 'exactly two --funding-rpc'
os.umask(0o077)
ids = list(APPS)
plan = json.loads((A/'plan.json').read_text()); ad = json.loads((A/'admission.json').read_text())
assert plan['measurement'] == NEW['measurement'] and plan['image'] == NEW['dist']
assert not staged_problems(NEW['dist'], NEW['files']), 'the staged image changed'
assert ad['stage'] == 'verified active; old control still connected', ad['stage']
assert ad['added'] == NEW['measurement'], 'admission.json admitted another measurement'
al = public_attestation(get)['operatorAllowlist']
assert al['admittedAtAttach'] == CURRENT['measurement'], 'production is not attached at ed918e4b'
assert set(ad['existing'] + [NEW['measurement']]) <= set(al['measurements']), 'the public allowlist lost a measurement or lacks the candidate'
pre = json.loads((EVIDENCE/'lease-preflight.json').read_text()); probs = preflight_problems(pre, ids, time.time())
assert not probs, 'lease preflight: ' + '; '.join(probs)
backup = A/'private-backup'
assert not backup.exists() and not (A/'result.json').exists(), 'an earlier attempt exists: inspect'
old = CONFIG.read_bytes(); unit = read_unit(); drops = read_dropins()
probs = protected_problems(old, unit, drops); assert not probs, 'protected fields: ' + '; '.join(probs)
new = rewrite_dist(old, CURRENT['dist'], NEW['dist'])
# the pre-cutover baseline, mandatory: root's authenticated guestd listing = the original 21:31Z guests; actual health now
pb = prebaseline.collect(args.guestd_vms, args.availability)
(EVIDENCE/'guestd-baseline-activate.json').write_text(json.dumps(pb, indent=2) + '\n')
assert not pb['problems'], 'pre-cutover baseline: ' + '; '.join(pb['problems'])
specs = pb['health']
(A/'apps-health.json').write_text(json.dumps(specs, indent=2) + '\n'); apphealth.load_specs(A/'apps-health.json', ids)
snap = {i: pb['apps'][i]['guest'] for i in ids}; history = {i: pb['apps'][i]['history'] for i in ids}
# LAST before any write: the mandatory boot-funding preflight (fresh, read-only)
fund, probs = boot_funding(rpcs, NEW['commit'], EVIDENCE/'boot-funding-activate.json')
assert not probs, 'boot funding: ' + '; '.join(probs)

backup.mkdir(mode=0o700); (backup/'config.json').write_bytes(old); (backup/'config.json').chmod(0o600)
mode = CONFIG.stat().st_mode & 0o777
result = {'startedAt': utc(), 'measurement': NEW['measurement'], 'commit': NEW['commit'], 'image': NEW['dist'], 'previousImage': CURRENT['dist'],
          'configBeforeSha256': sha(old), 'configAfterSha256': sha(new), 'protected': {'unit': unit, 'dropins': drops}, 'state': 'starting',
          'preCutoverGuests': snap, 'preCutoverHistory': history, 'appsHealth': specs, 'preCutoverRecords': {i: pb['apps'][i]['recordSha256'] for i in ids},
          'baselineSource': 'guestd (root authenticated listing ' + pb['source']['guestdListingSha256'][:16] + ')', 'oldControlAdopted': pb['oldControlAdopted'],
          'availabilityAtBaseline': pb['availability'], 'buildSha256': NEW['buildSha256'],
          'bootFunding': {'block': fund['block']['number'], 'action': fund['action']['action'], 'balanceWei': fund['operator']['balanceWei'],
                          'setProofKeyWorstCaseWei': fund['setProofKey']['worstCaseWei'], 'nonce': fund['operator']['nonceAtBlock']}, 'adoption': {}, 'guests': {}, 'renewalsObserved': {},
          'productionActivated': False}
def save(): (A/'result.json').write_text(json.dumps(result, indent=2) + '\n')
BAD = [re.compile(p) for p in (r'^\[bill\] (\S+) (instance respawned|respawn failed)', r'^\[claim\] (\S+) (app instance died|app died|lease lost|lease looks lost)',
                               r'^\[instance\] reaped orphan (\S+)', r'^\[release\] (\S+) ', r'^\[isolation\] (0x[0-9a-f]{8}): guest \S+ app ')]
def bad(lines):
    return [l[:200] for l in lines for r in BAD for m in [r.match(l)]
            if m and any(i == m.group(1).lower() or (i.startswith(m.group(1).lower()) and len(m.group(1)) == 10) for i in ids)]
save(); mutated = False
since = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'); result['journalSince'] = since
try:
    assert CONFIG.read_bytes() == old and read_dropins() == CURRENT['dropins']
    atomic_config(new, mode); mutated = True
    systemctl('restart', UNIT, timeout=60)
    print('Control restarted on the candidate image; awaiting fresh hardware-attested attachment.', flush=True)
    end = time.monotonic() + ATTACH_S
    while time.monotonic() < end:
        try:
            if public_attestation(get)['operatorAllowlist'].get('admittedAtAttach') == NEW['measurement']:
                subprocess.run(['systemctl', '--user', 'is-active', '--quiet', UNIT], check=True)
                result.update(state='attached; adoption pending', attachedAt=utc()); save(); print(result['state'], flush=True); break
        except (AssertionError, ValueError, KeyError) as e: result['lastObservationError'] = str(e)[:120]; save()
        time.sleep(5)
    else: raise RuntimeError(f'the candidate measurement did not attach within {ATTACH_S} s')
    end = time.monotonic() + ADOPT_S
    while time.monotonic() < end:
        lines = journal(since)
        if bad(lines): raise RuntimeError('during adoption: ' + ' | '.join(bad(lines)))
        for i in ids:
            if i not in result['adoption']:
                a = next((l for l in lines if l.startswith('[claim] ' + i + ' adopted:')), None)
                g = next((m.group(1) for l in lines for m in [re.match(r'^\[isolation\] ' + i[:10] + r': adopted guest (\S+) ', l)] if m), None)
                if a and g: result['adoption'][i] = a[:300]; result['guests'][i] = g; save(); print(a[:200], '<-', g, flush=True)
        if len(result['adoption']) == len(ids): break
        time.sleep(5)
    else: raise RuntimeError(f'both apps were not adopted (with their guest) within {ADOPT_S} s')
    for i in ids:
        if result['guests'][i] != snap[i]: raise RuntimeError(f'{i[:10]} adopted {result["guests"][i]}, not the baseline guest {snap[i]}')
    result.update(state='adopted the same guests; operational gate running'); save(); print(result['state'], flush=True)
    gate = [sys.executable, str(A/'verify-operational.py'), '--availability', args.availability, '--apps-json', str(A/'apps-health.json'),
            '--since', since, '--out', str(A/'gate.json')]
    for i in ids: gate += ['--expect-guest', f'{i}={snap[i]}'] + [x for vm in history[i] for x in ('--known-failed', f'{i}={vm}')]
    if subprocess.run(gate).returncode != 0: raise RuntimeError('the operational gate FAILED: ' + json.dumps(json.loads((A/'gate.json').read_text()).get('why'))[:400])
    lines = journal(since)
    if bad(lines): raise RuntimeError('after the gate: ' + ' | '.join(bad(lines)))
    for i in ids:
        m = next((m for l in lines for m in [re.match(r'^\[lease-gas\] renew ' + i + r' landed in (0x[0-9a-f]{64})', l)] if m), None)
        if m: result['renewalsObserved'][i] = m.group(1)
    result['renewalWarnings'] = [l[:200] for l in lines if l.startswith('[lease-gas] ') and ' not sent' in l][-6:]
    result.update(state=f'PROVISIONAL: attached {NEW["measurement"][:8]}, the same guests adopted, operational gate v4 PASSED; root fresh '
                        'attestation/capability check and keep.py pending (renewal-watch.py records app-paid renewals as they land)',
                  productionActivated='provisional', provisionalAt=utc()); save(); print(result['state'], flush=True)
except BaseException as e:
    result.update(state='activation failed; safe rollback pending', error=type(e).__name__, detail=str(e)[:600]); save()
    print('FAILED:', result['detail'], flush=True)
    if mutated:
        safe_rollback(result, save, since=since, old_config=old, new_config=new); print(result['state'], flush=True)
    raise
