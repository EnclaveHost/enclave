# Gate v4 / baseline selection self-test: guestd RETAINS failed guests beside the live one (root's real pre-cutover
# /availability, metal0 07:51Z, 5 held rows). 127.0.0.1 fixtures only; the REAL gate scripts run in subprocesses.
#  1. guestrows.baseline (what activate.py calls) on the ACTUAL snapshot selects gd491817b2 / gdd6762127 and records the
#     3 failed image-generator rows as history; it refuses 2 running, expected missing (only failed), a starting sibling,
#     null / unknown status, not owned, a malformed id;
#  2. the accepted v3 gate (prior-gate3/) REJECTS the actual snapshot (the modeling mismatch, reproduced);
#  3. the v4 gate PASSES the actual snapshot with its history, and FAILS: a second running row, a new starting sibling,
#     the expected guest replaced, expected missing from the start, a new failed row, the expected guest's status null,
#     and the actual snapshot when the history is not handed to it.
import http.server, json, subprocess, sys, tempfile, threading
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); import guestrows
IMG, EYE = '0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9', '0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c'
row = lambda app, vm, status, owned=True: {'id': app, 'vm': vm, 'status': status, 'owned': owned}
ACTUAL = [row(IMG, 'gd0b398386', 'failed'), row(IMG, 'gd0e0f9cae', 'failed'), row(IMG, 'gd491817b2', 'running'),
          row(IMG, 'gd5f621e30', 'failed'), row(EYE, 'gdd6762127', 'running')]
HISTORY = ['gd0b398386', 'gd0e0f9cae', 'gd5f621e30']
fails = 0
def expect(cond, what):
    global fails
    print(('ok   ' if cond else 'NOT AS EXPECTED: ') + what)
    if not cond: fails += 1
def refused(held):
    try: guestrows.baseline(held, [IMG, EYE]); return None
    except AssertionError as e: return str(e)

print('--- 1. baseline selection (guestrows.baseline, as activate.py calls it)')
b = guestrows.baseline(ACTUAL, [IMG, EYE])
expect(b == {IMG: {'guest': 'gd491817b2', 'history': HISTORY}, EYE: {'guest': 'gdd6762127', 'history': []}}, f'the actual snapshot: {b}')
for what, held, why in [
    ('two running', ACTUAL + [row(IMG, 'gd99999999', 'running')], 'more than one nonterminal'),
    ('expected missing (only failed rows)', [r for r in ACTUAL if r['vm'] != 'gd491817b2'], 'no live guest'),
    ('a starting sibling', ACTUAL + [row(IMG, 'gd88888888', 'starting')], 'more than one nonterminal'),
    ('the live row status null', [dict(r, status=None) if r['vm'] == 'gdd6762127' else r for r in ACTUAL], "is None, not running"),
    ('an unknown status beside the live one', ACTUAL + [row(EYE, 'gd77777777', 'stopping')], 'more than one nonterminal'),
    ('not owned', [dict(r, owned=False) if r['vm'] == 'gd491817b2' else r for r in ACTUAL], 'not owned'),
    ('malformed id', [dict(r, vm='gd/../x') if r['vm'] == 'gdd6762127' else r for r in ACTUAL], 'malformed'),
    ('an app absent', [r for r in ACTUAL if r['id'] != EYE], 'no live guest')]:
    w = refused(held); expect(w is not None and why in w, f'refuses {what}: {w}')

state = {}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, ctype, body):
        self.send_response(code); self.send_header('content-type', ctype); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == '/eyes/ping': return self.send(200, 'application/json', b'{"ok":true,"pong":true,"t":1}')
        if self.path == '/img/': return self.send(200, 'text/html', ('<html><title>Image Generator</title>' + 'x' * 2048 + '</html>').encode())
        state['n'] = n = state.get('n', 0) + 1
        held = state['held'](n)
        self.send(200, 'application/json', json.dumps({'tenantVouch': {'ok': True, 'at': f'2026-10-21T00:00:{n:02d}Z'},
                                                       'instanceSweep': {'held': held}}).encode())
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{srv.server_address[1]}'
d = Path(tempfile.mkdtemp())
(d/'apps.json').write_text(json.dumps({IMG: {'url': base + '/img/', 'kind': 'html', 'minBytes': 1024, 'title': 'Image Generator'},
                                        EYE: {'url': base + '/eyes/ping', 'kind': 'json-ping'}}))
(d/'journal.txt').write_text(f'[claim] {IMG} adopted: app=image-generator\n[claim] {EYE} adopted: app=eyesoff-ai\n')
def gate(case, script, held, known=True, v3=False):
    state.clear(); state['held'] = held
    out = d/f'{case.replace(" ", "-")}.json'
    cmd = [sys.executable, str(script), '--availability', base + '/availability', '--apps-json', str(d/'apps.json'), '--since', 'x',
           '--out', str(out), '--journal-cmd', f'cat {d/"journal.txt"}', '--window', '3', '--warmup', '5', '--poll', '1',
           '--min-vouches', '3', '--deadline', '14', '--vouch-stale', '3', '--expect-guest', f'{IMG}=gd491817b2', '--expect-guest', f'{EYE}=gdd6762127']
    if known and not v3: cmd += [x for vm in HISTORY for x in ('--known-failed', f'{IMG}={vm}')]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    r = json.loads(out.read_text()) if out.exists() else {'state': 'no output', 'why': p.stderr[-300:]}
    print(f'   {case}: rc={p.returncode} state={r["state"]} why={str(r.get("why"))[:220]}')
    return p.returncode, str(r.get('why'))
static = lambda rows: (lambda n: rows)
at = lambda k, before, after: (lambda n: before if n < k else after)
print('--- 2. the accepted v3 gate on the actual snapshot (the mismatch)')
rc, why = gate('v3 actual snapshot', HERE/'prior-gate3/verify-operational.py', static(ACTUAL), v3=True)
expect(rc == 1 and 'not held running and owned' in why, 'v3 rejects the real snapshot with failed siblings')
print('--- 3. gate v4')
V4 = HERE/'verify-operational.py'
rc, why = gate('actual snapshot', V4, static(ACTUAL)); expect(rc == 0, 'v4 passes the actual snapshot with its recorded history')
rc, why = gate('second running', V4, at(3, ACTUAL, ACTUAL + [row(IMG, 'gd99999999', 'running')])); expect(rc == 1 and 'more than one nonterminal' in why, 'a second running guest fails')
rc, why = gate('new starting sibling', V4, at(3, ACTUAL, ACTUAL + [row(EYE, 'gd88888888', 'starting')])); expect(rc == 1 and 'more than one nonterminal' in why, 'a new starting guest fails')
replaced = [dict(r, status='failed') if r['vm'] == 'gd491817b2' else r for r in ACTUAL] + [row(IMG, 'gd66666666', 'running')]
rc, why = gate('expected replaced', V4, at(3, ACTUAL, replaced)); expect(rc == 1 and ('relaunched/replaced' in why or 'failed since the baseline' in why), 'a replacement fails')
rc, why = gate('expected missing', V4, static([r for r in ACTUAL if r['vm'] != 'gd491817b2'])); expect(rc == 1 and 'no live guest' in why, 'expected missing fails')
rc, why = gate('new failed row', V4, at(3, ACTUAL, ACTUAL + [row(IMG, 'gd55555555', 'failed')])); expect(rc == 1 and 'failed since the baseline' in why, 'a guest failing during the gate fails')
rc, why = gate('expected status null', V4, at(3, ACTUAL, [dict(r, status=None) if r['vm'] == 'gdd6762127' else r for r in ACTUAL])); expect(rc == 1 and 'not running' in why, 'an unknown status fails closed')
rc, why = gate('history not handed over', V4, static(ACTUAL), known=False); expect(rc == 1 and 'failed since the baseline' in why, 'unrecorded failed rows are not accepted silently')
srv.shutdown()
print('TEST-GATE-V4', 'PASS' if fails == 0 else f'FAIL ({fails})'); sys.exit(1 if fails else 0)
