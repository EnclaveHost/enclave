# Gate v3 self-test (root's ROOT-GATE-REVIEW.txt holes), against a scripted 127.0.0.1 /availability, an EyesOff-like
# /ping, an image-generator-like HTML page and fixture journals; the REAL gate scripts run in subprocesses.
#  A. the holes REPRODUCED on the preserved v2 gate (prior-gate2/verify-operational.py): a 404 passes as healthy, an
#     unreadable journal passes as "no error lines", a vouch that never advances waits forever;
#  B. the same fixtures FAIL on v3, for the stated reason, within its finite deadline;
#  C. v3's other strictness: pong false, wrong identity (<title>), a journal without the run's adoption anchor, a missing
#     baseline guest id;
#  D. the earlier 9 gate cases, on v3.
import http.server, json, subprocess, sys, tempfile, threading
from pathlib import Path
HERE = Path(__file__).resolve().parent
A1, A2 = '0x' + 'da09d0f2' + '11' * 28, '0x' + '9eb4e600' + '22' * 28    # A1 image-generator (html), A2 EyesOff (/ping)
TITLE = 'Image Generator'
state = {}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, ctype, body):
        self.send_response(code); self.send_header('content-type', ctype); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        s = state
        if self.path == '/availability': s['n'] = s.get('n', 0) + 1
        n = s.get('n', 0)
        if self.path in ('/img/', '/eyes/ping'):
            healthy = n >= s.get('appFrom', 0) and not (s.get('appDownAt') and n >= s['appDownAt'])
            if s.get('appCode'): return self.send(s['appCode'], 'text/html', b'<html><title>Not Found</title></html>')
            if not healthy: return self.send(503, 'text/plain', b'starting')
            if self.path == '/eyes/ping':
                return self.send(200, 'application/json', json.dumps({'ok': True, 'pong': not s.get('pongFalse'), 't': 1}).encode())
            return self.send(200, 'text/html; charset=utf-8', f'<html><head><title>{s.get("title", TITLE)}</title></head><body>{"x" * 2048}</body></html>'.encode())
        held = None if n <= s.get('heldFrom', 0) else [
            {'id': A1, 'vm': 'gdNEW' if (s.get('relaunchAt') and n >= s['relaunchAt']) else 'gdA', 'status': 'running', 'owned': True},
            {'id': A2, 'vm': 'gdB', 'status': 'running', 'owned': True}]
        at = '2026-10-21T00:00:00Z' if s.get('staleVouch') else f'2026-10-21T00:00:{n:02d}Z'
        vouch = {'ok': None, 'reason': 'withheld'} if n <= s.get('vouchFrom', 0) else {'ok': True, 'at': at,
               **({'unvouched': [{'id': A1, 'expiresIn': 100}]} if s.get('unvouched') else {})}
        self.send(200, 'application/json', json.dumps({'tenantVouch': vouch, 'instanceSweep': {'held': held} if held is not None else {'reason': 'no reaping yet'}}).encode())
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{srv.server_address[1]}'
ANCHOR = [f'[claim] {A1} adopted: app=image-generator', f'[claim] {A2} adopted: app=eyesoff-ai',
          f'[isolation] {A1[:10]}: adopted guest gdA (running), launched from this record']
TIMING = ['--window', '3', '--warmup', '6', '--poll', '1', '--min-vouches', '3']
def run(case, gate, journal=None, extra=(), timeout=60, expect_guests=True, **s):
    state.clear(); state.update(s)
    d = Path(tempfile.mkdtemp()); jf = d/'journal.txt'; jf.write_text('\n'.join(ANCHOR if journal is None else journal) + '\n'); out = d/'gate.json'
    jcmd = s.pop('jcmd', None) or f'cat {jf}'
    cmd = [sys.executable, str(gate), '--availability', base + '/availability', '--since', 'x', '--out', str(out), '--journal-cmd', jcmd, *TIMING, *extra]
    if gate.parent.name == 'prior-gate2':
        cmd += ['--app', f'{A1}={base}/img/', '--app', f'{A2}={base}/eyes/ping', '--expect-guest', f'{A1}=gdA', '--expect-guest', f'{A2}=gdB']
    else:
        (d/'apps.json').write_text(json.dumps({A1: {'url': base + '/img/', 'kind': 'html', 'minBytes': 1024, 'title': TITLE},
                                                A2: {'url': base + '/eyes/ping', 'kind': 'json-ping'}}))
        cmd += ['--apps-json', str(d/'apps.json'), '--deadline', '14', '--vouch-stale', '2']
        if expect_guests: cmd += ['--expect-guest', f'{A1}=gdA', '--expect-guest', f'{A2}=gdB']
    try: p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f'{case}: still running after {timeout}s (no finite end)'); return None, {}
    r = json.loads(out.read_text()) if out.exists() else {'state': 'no output', 'why': p.stderr.strip()[-200:]}
    print(f'{case}: rc={p.returncode} state={r["state"]} why={str(r.get("why"))[:200]}')
    return p.returncode, r
V2, V3 = HERE/'prior-gate2/verify-operational.py', HERE/'verify-operational.py'
fails = 0
def expect(cond, what):
    global fails
    if not cond: fails += 1; print('  NOT AS EXPECTED:', what)
print('--- A. the holes, reproduced on the prior v2 gate')
rc, r = run('v2 bad 404', V2, appCode=404);                      expect(rc == 0 and r['state'] == 'PASS', 'v2 passes a 404 as healthy (the hole)')
rc, r = run('v2 journal failure', V2, jcmd='false');             expect(rc == 0 and r['state'] == 'PASS', 'v2 passes an unreadable journal (the hole)')
rc, r = run('v2 stale vouch', V2, staleVouch=True, timeout=20);  expect(rc is None, 'v2 never ends on a stale vouch (the hole)')
print('--- B. the same fixtures on v3')
rc, r = run('v3 bad 404', V3, appCode=404);                      expect(rc == 1 and 'HTTP 404' in str(r['why']), 'v3 fails a 404')
rc, r = run('v3 journal failure', V3, jcmd='false');             expect(rc == 1 and 'journal unreadable' in str(r['why']), 'v3 fails an unreadable journal')
rc, r = run('v3 stale vouch', V3, staleVouch=True, timeout=40);  expect(rc == 1 and 'vouch stale' in str(r['why']), 'v3 ends a stale vouch')
print('--- C. v3 strictness')
rc, r = run('pong false', V3, pongFalse=True);                   expect(rc == 1 and 'ping body' in str(r['why']), 'ok without pong is not health')
rc, r = run('wrong identity', V3, title='Sign in');              expect(rc == 1 and 'title' in str(r['why']), 'another page is not the app')
rc, r = run('no adoption anchor', V3, journal=[]);               expect(rc == 1 and 'no adoption line' in str(r['why']), 'a journal without this run is no evidence')
rc, r = run('no baseline guest ids', V3, expect_guests=False);   expect(rc == 2, 'the baseline guest ids are mandatory')
rc, r = run('window never completes', V3, appDownAt=0, appFrom=999, extra=['--warmup', '60']); expect(rc == 1 and 'deadline' in str(r['why']), 'the overall deadline ends it')
print('--- D. the earlier 9 cases on v3')
rc, r = run('warm-up then pass', V3, appFrom=2, heldFrom=3, vouchFrom=2); expect(rc == 0 and r['state'] == 'PASS' and r['vouchCycles'] >= 3, 'warm-up then window passes')
rc, r = run('respawn line', V3, journal=ANCHOR + [f'[bill] {A2} instance respawned after outage']); expect(rc == 1 and 'respawned' in str(r['why']), 'respawn fails')
rc, r = run('new launch line', V3, journal=ANCHOR + [f'[isolation] {A1[:10]}: guest gd5f621e30 app 439b967e06dba86d']); expect(rc == 1 and 'gd5f621e30' in str(r['why']), 'new launch fails')
rc, r = run('reaped orphan', V3, journal=ANCHOR + [f'[instance] reaped orphan {A1} (vm=gdA) - no record owns it']); expect(rc == 1 and 'reaped' in str(r['why']), 'reap fails')
rc, r = run('relaunched guest id', V3, relaunchAt=2);           expect(rc == 1 and 'gdNEW' in str(r['why']), 'another guest id fails')
rc, r = run('unvouched app', V3, unvouched=True);                expect(rc == 1 and 'UNVOUCHED' in str(r['why']), 'unvouched fails')
rc, r = run('warm-up exceeded', V3, appFrom=999);                expect(rc == 1 and 'warm-up exceeded' in str(r['why']), 'never healthy fails after the warm-up')
rc, r = run('failure inside the window', V3, appFrom=1, appDownAt=4);       expect(rc == 1 and 'after the window started' in str(r['why']), 'a failure inside the window fails')
rc, r = run('other app lines do not count', V3, journal=ANCHOR + [f'[bill] 0x{"77" * 32} instance respawned after outage']); expect(rc == 0, 'other deployments ignored')
srv.shutdown()
print('TEST-GATE-V3', 'PASS' if fails == 0 else f'FAIL ({fails})'); sys.exit(1 if fails else 0)
