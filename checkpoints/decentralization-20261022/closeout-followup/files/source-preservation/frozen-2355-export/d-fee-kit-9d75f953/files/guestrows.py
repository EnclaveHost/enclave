# The ONE reading of /availability instanceSweep.held per app, used by activate.py (pre-cutover baseline) and by
# verify-operational.py (the gate). guestd's own vm status enum (isolation/m4/guestd/server.go) is exactly:
#   "starting" -> "running" -> (ended: removed from the map) | "failed" (kept until the supervisor deletes it).
# held rows carry {id (deployment), vm, status (v.status or null), owned}. guestd RETAINS failed guests as tombstones beside
# the live one (metal0 07:51Z: image-generator held gd491817b2 running plus 3 failed rows), so per app:
#   - "failed" rows are terminal HISTORY: recorded as evidence, never deleted here, never counted as the live guest;
#   - every other row is a NONTERMINAL candidate ("starting", "running", null or any status this code does not know -
#     unknown fails closed); there must be exactly ONE, it must be "running" and owned, with a well-formed guest id.
import re
TERMINAL = {'failed'}
VM = re.compile(r'[A-Za-z0-9-]{1,64}')

def rows_of(held, app):
    return [r for r in (held or []) if str(r.get('id', '')).lower() == app]

def classify(held, app):
    """-> (live_rows, history_vms): every non-failed row of the app, and the failed rows' guest ids."""
    rows = rows_of(held, app)
    return [r for r in rows if r.get('status') not in TERMINAL], sorted(str(r.get('vm')) for r in rows if r.get('status') in TERMINAL)

def the_live_guest(held, app):
    """-> (vm, None) for exactly one running, owned, well-formed live guest; else (None, why)."""
    live, _ = classify(held, app)
    if not live: return None, 'no live guest (only failed history, or none)'
    if len(live) > 1: return None, 'more than one nonterminal guest: ' + ', '.join(f"{r.get('vm')}={r.get('status')}" for r in live)
    r = live[0]
    if r.get('status') != 'running': return None, f"its only nonterminal guest {r.get('vm')} is {r.get('status')!r}, not running"
    if r.get('owned') is not True: return None, f"its running guest {r.get('vm')} is not owned"
    if not VM.fullmatch(str(r.get('vm'))): return None, f"malformed guest id {r.get('vm')!r}"
    return str(r['vm']), None

def baseline(held, apps):
    """Pre-cutover baseline: {app: {'guest': vm, 'history': [failed vms]}}; raises naming every app that does not have
    exactly one running owned guest."""
    out, bad = {}, []
    for app in apps:
        vm, why = the_live_guest(held, app)
        if why: bad.append(f'{app[:10]}: {why}')
        else: out[app] = {'guest': vm, 'history': classify(held, app)[1]}
    if bad: raise AssertionError('pre-cutover baseline refused: ' + '; '.join(bad))
    return out
