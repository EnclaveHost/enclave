# OPERATIONAL GATE v2 (prepared by Claude, 2026-10-21; derived from linux-post-adoption-repair/activation-gate/
# verify-operational.py, which is kept unchanged). activate.py runs it after attach + adoption; root may run it alone.
# READ-ONLY: public HTTPS, the control's public /availability, and this host's enclave-metal journal lines starting
# "[claim] ", "[release] ", "[bill] ", "[instance] " or "[isolation] " (journalctl -o cat; nothing else read or stored).
#
# v2 adds a bounded WARM-UP: right after a restart the platform host gate refuses app traffic until its first
# authenticated admit, and the first reconcile pass after the adoption has not published `held` yet; those "not yet"
# states are tolerated for at most --warmup seconds. The --window clock starts only when EVERY check passes, and from then
# on every poll must pass (continuous). HARD failures end the gate at any time, warm-up included:
#   - a journal line for an app: "[bill] ... respawn", "[claim] ... died | lease lost | lease looks lost",
#     "[instance] reaped orphan", "[release] <id>", or a NEW launch "[isolation] <id10>: guest <vm> app ...";
#   - an app id in tenantVouch.unvouched;
#   - an app's held guest id other than the expected one (--expect-guest, from the adoption lines/pre-cutover snapshot).
# PASS (exit 0): window seconds continuous with both public endpoints answering over TLS (< 500), both guests held
# running AND owned with the expected ids, >= --min-vouches distinct successful tenantVouch cycles, no hard failure.
# The app-paid renewal of each app comes AFTER this gate (activate.py's renewal phase, then root's chain audit).
import argparse, datetime, json, re, ssl, subprocess, sys, time, urllib.request, urllib.error

ap = argparse.ArgumentParser()
ap.add_argument('--availability', required=True)
ap.add_argument('--app', action='append', required=True, metavar='DEPLOYMENT_ID=URL')
ap.add_argument('--expect-guest', action='append', default=[], metavar='DEPLOYMENT_ID=VM_ID')
ap.add_argument('--since', required=True)
ap.add_argument('--window', type=int, default=420)
ap.add_argument('--warmup', type=int, default=300)
ap.add_argument('--min-vouches', type=int, default=3)   # the vouch in effect at the window's start + 2 completed cycles
ap.add_argument('--poll', type=int, default=15)
ap.add_argument('--journal-cmd', default='journalctl --user -u enclave-metal.service --since {since} -o cat --no-pager',
                help=argparse.SUPPRESS)   # the gate's own test substitutes a fixture
ap.add_argument('--out', required=True)
a = ap.parse_args()
apps, expect = {}, {}
for s in a.app:
    i, u = s.split('=', 1); i = i.lower()
    assert re.fullmatch(r'0x[0-9a-f]{64}', i) and u.startswith(('https://', 'http://127.0.0.1')), s
    apps[i] = u
for s in a.expect_guest:
    i, v = s.split('=', 1); i = i.lower(); assert i in apps and re.fullmatch(r'[A-Za-z0-9-]{1,64}', v), s; expect[i] = v
ctx = ssl.create_default_context()
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()

def get(url, timeout=12):
    req = urllib.request.Request(url, headers={'user-agent': 'enclave-activation-gate/2'})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r: return r.status, r.read(1 << 20)
    except urllib.error.HTTPError as e: return e.code, b''
    except Exception as e: return None, type(e).__name__.encode()

def journal():
    cmd = [x.replace('{since}', a.since) for x in a.journal_cmd.split(' ')]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout
    return [l for l in out.splitlines() if l.startswith(('[claim] ', '[release] ', '[bill] ', '[instance] ', '[isolation] '))]
BAD = [re.compile(p) for p in (r'^\[bill\] (\S+) (instance respawned|respawn failed)', r'^\[claim\] (\S+) (app instance died|app died|lease lost|lease looks lost)',
                               r'^\[instance\] reaped orphan (\S+)', r'^\[release\] (\S+) ', r'^\[isolation\] (0x[0-9a-f]{8}): guest \S+ app ')]
def app_of(token):
    t = token.lower()
    return next((i for i in apps if i == t or (len(t) == 10 and i.startswith(t))), None)

result = {'startedAt': now(), 'gate': 2, 'apps': apps, 'expectGuests': expect, 'window': a.window, 'warmup': a.warmup, 'polls': [], 'state': 'observing'}
def save(): open(a.out, 'w').write(json.dumps(result, indent=2) + '\n')
def finish(state, code, **kw):
    result.update(state=state, at=now(), **kw); save(); print(state, json.dumps(kw)[:2000]); sys.exit(code)
t0 = time.monotonic(); good_since = None; vouch_ats = set(); cur_vouch = None   # vouch cycles counted INSIDE the window
while True:
    hard, soft = [], []
    p = {'at': now()}; cur_vouch = None
    for i, u in apps.items():
        st, _ = get(u); p[i[:10]] = st
        if st is None or st >= 500: soft.append(f'{i[:10]}: public endpoint -> {st}')
    st, body = get(a.availability)
    try: av = json.loads(body) if st == 200 else None
    except Exception: av = None
    if not isinstance(av, dict): soft.append(f'/availability -> {st}')
    else:
        v, held = av.get('tenantVouch') or {}, (av.get('instanceSweep') or {}).get('held')
        if v.get('ok') is True and v.get('at'): cur_vouch = v['at']; vouch_ats.add(v['at'])
        else: soft.append(f"tenantVouch not ok yet: {str(v.get('reason'))[:120]}")
        for u in v.get('unvouched') or []:
            if app_of(str(u.get('id', ''))): hard.append(f"{str(u.get('id'))[:10]} UNVOUCHED ({u.get('expiresIn')}s)")
        if held is None: soft.append('instanceSweep.held not published yet')
        else:
            for i in apps:
                h = [x for x in held if str(x.get('id', '')).lower() == i]
                if len(h) != 1 or h[0].get('status') != 'running' or h[0].get('owned') is not True:
                    soft.append(f'{i[:10]}: guest not (yet) held running and owned ({h})'); continue
                vm = h[0].get('vm')
                expect.setdefault(i, vm)
                if vm != expect[i]: hard.append(f'{i[:10]}: held guest {vm} is not the expected {expect[i]} (relaunched)')
    for l in journal():
        for r in BAD:
            m = r.match(l)
            if m and app_of(m.group(1)): hard.append('journal: ' + l[:200])
    p['hard'], p['soft'] = hard, soft
    result['polls'].append(p); result['vouchCycles'] = len(vouch_ats); result['guests'] = expect
    elapsed = time.monotonic() - t0
    if hard: finish('FAIL', 1, why=hard)
    if soft:
        if good_since is not None: finish('FAIL', 1, why=['after the window started: '] + soft)
        if elapsed > a.warmup: finish('FAIL', 1, why=['warm-up exceeded: '] + soft)
    else:
        if good_since is None: good_since = time.monotonic(); vouch_ats = {cur_vouch}   # the window starts now
        if time.monotonic() - good_since >= a.window and len(vouch_ats) >= a.min_vouches:
            finish('PASS', 0, stableFor=a.window, guests=expect, vouchCycles=len(vouch_ats))
    save(); time.sleep(a.poll)
