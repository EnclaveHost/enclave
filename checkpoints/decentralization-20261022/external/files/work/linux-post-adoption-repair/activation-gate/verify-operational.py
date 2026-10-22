# ROOT RUNS (prepared by Claude, 2026-10-21) AFTER a control activation has attached and adopted, BEFORE the activation is
# called done. READ-ONLY: public HTTPS and the control's public /availability, plus this host's enclave-metal journal lines
# that start with "[claim] ", "[release] ", "[bill] " or "[instance] " (journalctl -o cat; nothing else is read or stored).
# No config, key, env, state, signature or funding is touched.
#
# Adoption is NOT health (metal0 2026-10-21: both apps "adopted", then died within a minute and public TLS ended in EOF).
# PASS requires, continuously for --window seconds (default 420 = guestd's 300 s lease TTL + two 60 s passes):
#   1. every app's public HTTPS endpoint answers (TLS completes, HTTP status < 500) on every poll;
#   2. /availability: instanceSweep.held lists each app's guest as running and OWNED, with the SAME guest id on every poll
#      (no respawn, no relaunch) and none of them is ever reaped;
#   3. at least one backend vouch cycle: tenantVouch.at advances at least once with ok=true, and no app id is ever in
#      tenantVouch.unvouched;
#   4. the journal since --since shows no "[bill] ... respawn", "[claim] ... died", "[claim] ... lease lost",
#      "[instance] reaped orphan <app id>" or "[release] <app id>" line.
# Then the activation is "operationally stable; app-paid renewal pending". It is COMPLETE only after the next renewal of
# each app is verified as paid by the app's reserve (root's read-only audit, e.g. work/lease-relay-activation/
# audit-paid-leases.mjs), never by this host's key.
# FAIL prints why and the pending sponsored-release deadlines seen in the journal: a rollback must not restore the
# previous control until a verified block's timestamp is past the latest of them (the signed requests can no longer land),
# and no release journal is cleared or moved.
import argparse, datetime, json, re, ssl, subprocess, sys, time, urllib.request, urllib.error

ap = argparse.ArgumentParser()
ap.add_argument('--availability', required=True, help="the control's public /availability URL")
ap.add_argument('--app', action='append', required=True, metavar='DEPLOYMENT_ID=URL', help='each app: its deployment id and public health URL')
ap.add_argument('--since', required=True, help='journal start, as given to journalctl --since (the activation restart)')
ap.add_argument('--window', type=int, default=420)
ap.add_argument('--poll', type=int, default=15)
ap.add_argument('--deadline', type=int, default=1200, help='give up (FAIL) if the window has not been met by then')
ap.add_argument('--out', required=True)
a = ap.parse_args()
apps = {}
for s in a.app:
    i, u = s.split('=', 1); i = i.lower()
    assert re.fullmatch(r'0x[0-9a-f]{64}', i) and u.startswith('https://'), s
    apps[i] = u
ctx = ssl.create_default_context()
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()

def get(url, timeout=12):
    req = urllib.request.Request(url, headers={'user-agent': 'enclave-activation-gate/1'})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r: return r.status, r.read(1 << 20)
    except urllib.error.HTTPError as e: return e.code, b''
    except Exception as e: return None, type(e).__name__.encode()

BAD = [re.compile(p) for p in (r'^\[bill\] (\S+) (instance respawned|respawn failed)', r'^\[claim\] (\S+) (app instance died|app died|lease lost|lease looks lost)',
                               r'^\[instance\] reaped orphan (\S+)', r'^\[release\] (\S+) ')]
def journal():
    out = subprocess.run(['journalctl', '--user', '-u', 'enclave-metal.service', '--since', a.since, '-o', 'cat', '--no-pager'],
                         capture_output=True, text=True, timeout=30).stdout
    return [l for l in out.splitlines() if l.startswith(('[claim] ', '[release] ', '[bill] ', '[instance] '))]

result = {'startedAt': now(), 'apps': apps, 'window': a.window, 'polls': [], 'state': 'observing'}
def save(): open(a.out, 'w').write(json.dumps(result, indent=2) + '\n')
good_since, vm_of, vouch_ats, t_end = None, {}, set(), time.monotonic() + a.deadline
while True:
    p = {'at': now(), 'problems': []}
    for i, u in apps.items():
        st, _ = get(u)
        p[i[:10]] = st
        if st is None or st >= 500: p['problems'].append(f'{i[:10]}: public endpoint {u} -> {st}')
    st, body = get(a.availability)
    try: av = json.loads(body) if st == 200 else None
    except Exception: av = None
    if not av: p['problems'].append(f'/availability -> {st}')
    else:
        sw = av.get('sweep') or av
        v, held = sw.get('tenantVouch') or {}, (sw.get('instanceSweep') or {}).get('held') or []
        if v.get('ok') is True and v.get('at'): vouch_ats.add(v['at'])
        else: p['problems'].append(f"tenantVouch not ok: {str(v.get('reason'))[:120]}")
        for u in v.get('unvouched') or []:
            if str(u.get('id', '')).lower() in apps: p['problems'].append(f"{u['id'][:10]} UNVOUCHED ({u.get('expiresIn')}s)")
        for i in apps:
            h = [x for x in held if str(x.get('id', '')).lower() == i]
            if len(h) != 1 or h[0].get('status') != 'running' or h[0].get('owned') is not True:
                p['problems'].append(f'{i[:10]}: guest not held running and owned ({h})'); continue
            vm = h[0].get('vm'); vm_of.setdefault(i, vm)
            if vm != vm_of[i]: p['problems'].append(f'{i[:10]}: guest changed {vm_of[i]} -> {vm} (respawn)'); vm_of[i] = vm
    lines = journal()
    for l in lines:
        for r in BAD:
            m = r.match(l)
            if m and m.group(1).lower() in apps: p['problems'].append('journal: ' + l[:200])
    deadlines = sorted({int(x) for l in lines for x in re.findall(r'deadline (\d{10})', l)})
    result['pendingSponsoredDeadlines'] = deadlines
    result['polls'].append(p); result['vouchCycles'] = len(vouch_ats); result['guests'] = vm_of
    if p['problems']:
        result.update(state='FAIL', why=p['problems'], at=now()); save()
        print('FAIL:', *p['problems'], sep='\n  ')
        if deadlines: print(f'pending sponsored requests: do NOT restore the previous control before a verified block timestamp > {deadlines[-1]}')
        sys.exit(1)
    good_since = good_since or time.monotonic()
    if time.monotonic() - good_since >= a.window and len(vouch_ats) >= 2:
        result.update(state='operationally stable; app-paid renewal pending', stableFor=a.window, at=now()); save()
        print(result['state'], json.dumps(vm_of)); sys.exit(0)
    if time.monotonic() > t_end:
        result.update(state='FAIL', why=['window not met before the deadline'], at=now()); save(); print('FAIL: window not met'); sys.exit(1)
    save(); time.sleep(a.poll)
