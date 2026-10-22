# Self-test of verify-operational.py (gate v2) against a scripted local /availability + app endpoints and a fixture
# journal (no network beyond 127.0.0.1, no production). Each case runs the REAL gate script in a subprocess.
import http.server, json, os, subprocess, sys, tempfile, threading, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
A1, A2 = '0x' + 'da09d0f2' + '11' * 28, '0x' + '9eb4e600' + '22' * 28
state = {}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        s = state
        s['n'] = s.get('n', 0) + (1 if self.path == '/availability' else 0)
        n = s['n']
        if self.path.startswith('/app'):
            ok = n > s.get('appFrom', 0) and not (s.get('appDownAt') and n >= s['appDownAt'])
            self.send_response(200 if ok else 503); self.end_headers(); self.wfile.write(b'ok'); return
        held = None if n <= s.get('heldFrom', 0) else [
            {'id': A1, 'vm': s.get('vm1', 'gdA') if not (s.get('relaunchAt') and n >= s['relaunchAt']) else 'gdNEW', 'status': 'running', 'owned': True},
            {'id': A2, 'vm': 'gdB', 'status': 'running', 'owned': True}]
        vouch = {'ok': None, 'reason': 'withheld'} if n <= s.get('vouchFrom', 0) else {'ok': True, 'at': f'2026-10-21T00:00:{n:02d}Z',
               **({'unvouched': [{'id': A1, 'expiresIn': 100}]} if s.get('unvouched') else {})}
        b = json.dumps({'tenantVouch': vouch, 'instanceSweep': {'held': held} if held is not None else {'reason': 'no reaping yet'}}).encode()
        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(b)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{srv.server_address[1]}'
def run(case, journal_lines=(), **s):
    state.clear(); state.update(s)
    d = tempfile.mkdtemp(); jf = Path(d, 'journal.txt'); jf.write_text('\n'.join(journal_lines) + '\n'); out = Path(d, 'gate.json')
    cmd = [sys.executable, str(HERE / 'verify-operational.py'), '--availability', base + '/availability', '--since', 'x', '--out', str(out),
           '--app', f'{A1}={base}/app1', '--app', f'{A2}={base}/app2', '--expect-guest', f'{A1}=gdA', '--expect-guest', f'{A2}=gdB',
           '--window', '3', '--warmup', '6', '--poll', '1', '--min-vouches', '3', '--journal-cmd', f'cat {jf}']
    rc = subprocess.run(cmd, capture_output=True, text=True, timeout=60).returncode
    r = json.loads(out.read_text()); print(f'{case}: rc={rc} state={r["state"]} why={str(r.get("why"))[:160]}')
    return rc, r
fails = 0
def expect(cond, what):
    global fails
    if not cond: fails += 1; print('  NOT AS EXPECTED:', what)
rc, r = run('warm-up then pass', appFrom=2, heldFrom=3, vouchFrom=2,
            journal_lines=[f'[claim] {A1} adopted: app=x', f'[isolation] {A1[:10]}: adopted guest gdA (running), launched from this record'])
expect(rc == 0 and r['state'] == 'PASS' and r['vouchCycles'] >= 3, 'a warm-up within bounds, then a continuous window, passes')
rc, r = run('respawn line', journal_lines=[f'[bill] {A2} instance respawned after outage'])
expect(rc == 1 and 'respawned' in str(r['why']), 'a respawn line fails at once')
rc, r = run('new launch line', journal_lines=[f'[isolation] {A1[:10]}: guest gd5f621e30 app 439b967e06dba86d'])
expect(rc == 1 and 'gd5f621e30' in str(r['why']), 'a new launch for an app fails at once')
rc, r = run('reaped orphan', journal_lines=[f'[instance] reaped orphan {A1} (vm=gdA) - no record owns it'])
expect(rc == 1, 'a reap fails at once')
rc, r = run('relaunched guest id', relaunchAt=2)
expect(rc == 1 and 'gdNEW' in str(r['why']), 'another guest id fails at once')
rc, r = run('unvouched app', unvouched=True)
expect(rc == 1 and 'UNVOUCHED' in str(r['why']), 'an unvouched app fails at once')
rc, r = run('warm-up exceeded', appFrom=999)
expect(rc == 1 and 'warm-up exceeded' in str(r['why']), 'never healthy fails after the warm-up')
rc, r = run('failure inside the window', appDownAt=4)
expect(rc == 1 and 'after the window started' in str(r['why']), 'a failure after the window started fails')
rc, r = run('other app lines do not count', journal_lines=[f'[bill] 0x{"77"*32} instance respawned after outage'])
expect(rc == 0, 'lines of other deployments are not this gate\'s')
srv.shutdown()
print('TEST-GATE', 'PASS' if fails == 0 else f'FAIL ({fails})'); sys.exit(1 if fails else 0)
