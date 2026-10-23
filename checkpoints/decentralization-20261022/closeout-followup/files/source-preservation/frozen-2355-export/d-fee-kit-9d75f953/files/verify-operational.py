# OPERATIONAL GATE v3 (prepared by Claude, 2026-10-21; v2 kept in prior-gate2/, the first version in
# linux-post-adoption-repair/activation-gate/). activate.py runs it after attach + adoption; root may run it alone.
# READ-ONLY: the apps' public endpoints, the control's public /availability, and this host's enclave-metal journal lines
# (journalctl -o cat; only the prefixes below are kept, nothing else read or stored).
#
# v3 closes root's review holes (ROOT-GATE-REVIEW.txt):
#  - ACTUAL app health (apphealth.py, the same definition activate.py uses): EyesOff /ping JSON ok+pong, image-generator
#    200 text/html with the pre-cutover <title>; a 404 or error page is never healthy;
#  - the journal FAILS CLOSED: a non-zero journalctl exit, or a journal that does not show both apps' adoption lines
#    (the run's own anchor), is no evidence of "no error lines" - that poll is not clean;
#  - FINITE: a hard overall deadline (default warmup + window + 4 polls + 120 s); missing it fails, naming what was
#    missing (e.g. vouch cycles); a vouch timestamp that stops advancing for --vouch-stale s inside the window fails;
#  - guest ids are MANDATORY inputs (--expect-guest for every app, from the pre-cutover baseline); never inferred.
# v4 (root, metal0 07:51Z: guestd RETAINS failed guests beside the live one) reads held rows through guestrows.py: per app
# exactly ONE nonterminal row (guestd's enum: starting/running; null or unknown fails closed) and it must be the expected
# guest, running and owned; "failed" rows are terminal history, allowed only if the baseline recorded them
# (--known-failed); a guest failing during the gate, a second nonterminal guest, or a replacement fails at once.
# Warm-up (<= --warmup s) tolerates only "not yet" states before the window starts: the platform gate's first admit, the
# first reconcile pass's `held`. Once every check passes the window starts and EVERY poll must pass. HARD failures end the
# gate at any time: a death/reap/release/respawn/new-launch journal line for an app, an app unvouched, another guest id.
import argparse, datetime, json, re, subprocess, sys, time, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import apphealth, guestrows

ap = argparse.ArgumentParser()
ap.add_argument('--availability', required=True)
ap.add_argument('--apps-json', required=True, help='apps-health.json: {deployment id: {url, kind, title?, minBytes?}}')
ap.add_argument('--expect-guest', action='append', required=True, metavar='DEPLOYMENT_ID=VM_ID')
ap.add_argument('--known-failed', action='append', default=[], metavar='DEPLOYMENT_ID=VM_ID', help='baseline failed (history) rows')
ap.add_argument('--since', required=True)
ap.add_argument('--window', type=int, default=420)
ap.add_argument('--warmup', type=int, default=300)
ap.add_argument('--min-vouches', type=int, default=3)   # the vouch in effect at the window's start + 2 completed cycles
ap.add_argument('--vouch-stale', type=int, default=180)  # three missed 60 s passes
ap.add_argument('--poll', type=int, default=15)
ap.add_argument('--deadline', type=int, default=None)
ap.add_argument('--journal-cmd', default='journalctl --user -u enclave-metal.service --since {since} -o cat --no-pager',
                help=argparse.SUPPRESS)   # the gate's own test substitutes a fixture
ap.add_argument('--out', required=True)
a = ap.parse_args()
apps = apphealth.load_specs(a.apps_json)
expect = {}
for s in a.expect_guest:
    i, v = s.split('=', 1); i = i.lower(); assert i in apps and re.fullmatch(r'[A-Za-z0-9-]{1,64}', v), s; expect[i] = v
assert set(expect) == set(apps), 'an expected (pre-cutover) guest id is required for every app'
known_failed = {i: set() for i in apps}
for s in a.known_failed:
    i, v = s.split('=', 1); i = i.lower(); assert i in apps and guestrows.VM.fullmatch(v) and v != expect[i], s; known_failed[i].add(v)
deadline = a.deadline if a.deadline is not None else a.warmup + a.window + 4 * a.poll + 120
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()

def get(url, timeout=12):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'user-agent': 'enclave-activation-gate/3'}), timeout=timeout,
                                    context=apphealth.CTX) as r: return r.status, r.read(1 << 20)
    except Exception as e: return None, type(e).__name__.encode()

def journal():
    """-> (lines, problem). Fails closed: an unreadable journal, or one without the run's adoption anchor, is a problem."""
    cmd = [x.replace('{since}', a.since) for x in a.journal_cmd.split(' ')]
    try: r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except Exception as e: return [], f'journal unreadable: {type(e).__name__}'
    if r.returncode != 0: return [], f'journal unreadable: exit {r.returncode} {r.stderr.strip()[:120]}'
    lines = [l for l in r.stdout.splitlines() if l.startswith(('[claim] ', '[release] ', '[bill] ', '[instance] ', '[isolation] '))]
    missing = [i[:10] for i in apps if not any(l.startswith(f'[claim] {i} adopted:') for l in lines)]
    return lines, (f'journal shows no adoption line for {missing}: not this run\'s journal' if missing else None)
BAD = [re.compile(p) for p in (r'^\[bill\] (\S+) (instance respawned|respawn failed)', r'^\[claim\] (\S+) (app instance died|app died|lease lost|lease looks lost)',
                               r'^\[instance\] reaped orphan (\S+)', r'^\[release\] (\S+) ', r'^\[isolation\] (0x[0-9a-f]{8}): guest \S+ app ')]
def app_of(token):
    t = token.lower()
    return next((i for i in apps if i == t or (len(t) == 10 and i.startswith(t))), None)

result = {'startedAt': now(), 'gate': 4, 'apps': apps, 'expectGuests': expect, 'knownFailed': {i: sorted(v) for i, v in known_failed.items()}, 'window': a.window, 'warmup': a.warmup,
          'deadline': deadline, 'minVouches': a.min_vouches, 'polls': [], 'state': 'observing'}
def save(): open(a.out, 'w').write(json.dumps(result, indent=2) + '\n')
def finish(state, code, **kw):
    result.update(state=state, at=now(), **kw); save(); print(state, json.dumps(kw)[:2000]); sys.exit(code)
t0 = time.monotonic(); good_since = None; vouch_ats = set(); last_vouch = None; last_vouch_change = None
while True:
    hard, soft = [], []
    p = {'at': now()}; cur_vouch = None
    for i, spec in apps.items():
        ok, detail = apphealth.check(spec); p[i[:10]] = detail
        if not ok: soft.append(f'{i[:10]}: app not healthy ({detail})')
    st, body = get(a.availability)
    try: av = json.loads(body) if st == 200 else None
    except Exception: av = None
    if not isinstance(av, dict): soft.append(f'/availability -> {st}')
    else:
        v, held = av.get('tenantVouch') or {}, (av.get('instanceSweep') or {}).get('held')
        if v.get('ok') is True and v.get('at'):
            cur_vouch = v['at']; vouch_ats.add(cur_vouch)
            if cur_vouch != last_vouch: last_vouch, last_vouch_change = cur_vouch, time.monotonic()
        else: soft.append(f"tenantVouch not ok: {str(v.get('reason'))[:120]}")
        for u in v.get('unvouched') or []:
            if app_of(str(u.get('id', ''))): hard.append(f"{str(u.get('id'))[:10]} UNVOUCHED ({u.get('expiresIn')}s)")
        if held is None: soft.append('instanceSweep.held not published')
        else:
            for i in apps:
                live, history = guestrows.classify(held, i); p.setdefault('history', {})[i[:10]] = history
                new_failed = sorted(set(history) - known_failed[i])
                if new_failed: hard.append(f'{i[:10]}: guest(s) {new_failed} failed since the baseline')
                if len(live) > 1:
                    hard.append(f'{i[:10]}: more than one nonterminal guest: ' + ', '.join(f"{r.get('vm')}={r.get('status')}" for r in live))
                elif live and live[0].get('vm') != expect[i]:
                    hard.append(f'{i[:10]}: its nonterminal guest {live[0].get("vm")}={live[0].get("status")} is not the pre-cutover {expect[i]} (relaunched/replaced)')
                elif live and live[0].get('status') != 'running':
                    hard.append(f'{i[:10]}: the expected guest {expect[i]} is {live[0].get("status")!r}, not running')
                elif not live: soft.append(f'{i[:10]}: no live guest held')
                elif live[0].get('owned') is not True: soft.append(f'{i[:10]}: the expected guest {expect[i]} is not owned (yet)')
    lines, jproblem = journal()
    if jproblem: soft.append(jproblem)
    for l in lines:
        for r in BAD:
            m = r.match(l)
            if m and app_of(m.group(1)): hard.append('journal: ' + l[:200])
    if good_since is not None and last_vouch_change is not None and time.monotonic() - last_vouch_change > a.vouch_stale:
        hard.append(f'vouch stale: tenantVouch.at {last_vouch} has not advanced for {int(time.monotonic() - last_vouch_change)} s')
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
    if elapsed > deadline:
        finish('FAIL', 1, why=[f'overall deadline {deadline} s passed: window {"not started" if good_since is None else f"{int(time.monotonic() - good_since)} s of {a.window}"},'
                               f' vouch cycles {len(vouch_ats)} of {a.min_vouches}'])
    save(); time.sleep(a.poll)
