"""Gate v5 run for REAL (a subprocess, the unchanged v4 loop + the v5 rule) against in-process HTTP fixtures on 127.0.0.1, with a
scaled clock (window 4 s, poll 1 s, warm-up 3 s): the app servers answer per request from a script, so a transient (a dropped
connection: no HTTP response), an HTTP 500, a bad payload, an /availability fault or a frozen vouch lands on an exact poll."""
import ast, http.server, json, socket, ssl, subprocess, sys, tempfile, threading, time, unittest, urllib.error, urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent; ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
import apphealth
IG, EO = '0x' + 'da' * 32, '0x' + '9e' * 32
TITLE = 'Image generator'

class Server:
    """One fixture endpoint; script[k] decides the k-th request (the last entry repeats)."""
    def __init__(self, answer):
        self.n, self.answer = 0, answer
        outer = self
        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_GET(self):
                k = outer.n; outer.n += 1
                mode, body, ctype = outer.answer(k)
                if mode == 'drop': self.close_connection = True; return            # no HTTP response at all
                self.send_response(mode); self.send_header('content-type', ctype); self.send_header('content-length', str(len(body)))
                self.end_headers(); self.wfile.write(body)
        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}'
    def close(self): self.httpd.shutdown(); self.httpd.server_close()

def pick(script, k): return script[min(k, len(script) - 1)]
def eyes(script):
    def a(k):
        m = pick(script, k)
        if m == 'ok': return 200, b'{"ok": true, "pong": true}', 'application/json'
        if m == 'badpong': return 200, b'{"ok": true, "pong": false}', 'application/json'
        if m == '500': return 500, b'err', 'text/plain'
        return 'drop', b'', ''
    return a
def img(k): return 200, f'<html><head><title>{TITLE}</title></head><body>{"x" * 2000}</body></html>'.encode(), 'text/html; charset=utf-8'
def avail(script, every=1):
    def a(k):
        m = pick(script, k)
        if m == '503': return 503, b'', 'application/json'
        at = 'frozen' if m == 'frozen' else f'2026-10-23T23:{k // every:02d}:00Z'
        held = [{'id': IG, 'vm': 'gimg', 'status': 'running', 'owned': True}, {'id': EO, 'vm': 'geyes', 'status': 'running', 'owned': True}]
        v = {'ok': True, 'at': at, 'unvouched': [{'id': EO, 'expiresIn': 5}] if m == 'unvouched' else []}
        return 200, json.dumps({'tenantVouch': v, 'instanceSweep': {'held': held}}).encode(), 'application/json'
    return a

class GateV5(unittest.TestCase):
    def gate(self, eyes_script, avail_script=('ok',), deadline=None, extra=(), every=1):
        d = Path(tempfile.mkdtemp()); e, i, v = Server(eyes(list(eyes_script))), Server(img), Server(avail(list(avail_script), every))
        try:
            (d/'apps.json').write_text(json.dumps({IG: {'url': i.url + '/', 'kind': 'html', 'title': TITLE, 'minBytes': 1024},
                                                   EO: {'url': e.url + '/ping', 'kind': 'json-ping'}}))
            (d/'journal.txt').write_text(f'[claim] {IG} adopted: gimg\n[claim] {EO} adopted: geyes\n')
            cmd = [sys.executable, str(ROOT/'verify-operational-v5.py'), '--availability', v.url + '/availability', '--apps-json', str(d/'apps.json'),
                   '--expect-guest', f'{IG}=gimg', '--expect-guest', f'{EO}=geyes', '--since', 'x', '--window', '4', '--warmup', '3',
                   '--min-vouches', '2', '--poll', '1', '--vouch-stale', '2', '--out', str(d/'gate.json'), '--journal-cmd', f'cat {d/"journal.txt"}', *extra]
            if deadline is not None: cmd += ['--deadline', str(deadline)]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            return r.returncode, json.loads((d/'gate.json').read_text())
        finally:
            for s in (e, i, v): s.close()

    def window_polls(self, g):   # polls from the last (re)start of the window to the PASS
        polls = g['polls']; clean = [not (p['hard'] or p['soft'] or p['transient']) for p in polls]
        k = len(polls) - 1
        while k > 0 and clean[k - 1]: k -= 1
        return polls[k:]

    def test_happy_path_passes_without_a_reset(self):
        rc, g = self.gate(['ok']); self.assertEqual((rc, g['state'], g['resets'], g['resetCount']), (0, 'PASS', [], 0))

    def test_one_transient_resets_and_needs_a_full_new_window_and_vouches(self):
        rc, g = self.gate(['ok', 'ok', 'ok', 'drop', 'ok'])
        self.assertEqual((rc, g['state'], len(g['resets']), g['resetCount']), (0, 'PASS', 1, 1), g.get('why'))
        r = g['resets'][0]; self.assertGreater(r['windowSecondsDiscarded'], 0); self.assertGreaterEqual(r['vouchCyclesDiscarded'], 2)
        self.assertRegex(' '.join(r['why']), 'no HTTP response')
        w = self.window_polls(g)                                     # the PASS window started AFTER the reset poll, and spans >= 4 s
        reset_poll = next(k for k, p in enumerate(g['polls']) if p['transient'])
        self.assertGreater(g['polls'].index(w[0]), reset_poll); self.assertGreaterEqual(len(w), 4)

    def test_old_vouch_cycles_never_count_after_a_reset(self):
        # the vouch advances every 4 polls and 3 cycles are required. The drop lands at poll 4 (window running, 2 cycles seen). The
        # restarted window needs 3 NEW vouch values (polls 5, 8, 12: >= 7 polls); counting the 2 old ones would pass at ~poll 9.
        rc, g = self.gate(['ok'] * 4 + ['drop', 'ok'], every=4, extra=('--min-vouches', '3', '--vouch-stale', '30'), deadline=60)
        self.assertEqual((rc, g['state'], len(g['resets'])), (0, 'PASS', 1), g.get('why'))
        self.assertEqual(g['resets'][0]['vouchCyclesDiscarded'], 2)
        self.assertGreaterEqual(len(self.window_polls(g)), 7, 'the restarted window counted vouch cycles from before the reset')

    def test_a_second_transient_fails(self):
        rc, g = self.gate(['ok', 'ok', 'ok', 'drop', 'ok', 'ok', 'drop', 'ok'])
        self.assertEqual((rc, g['state'], len(g['resets'])), (1, 'FAIL', 1)); self.assertRegex(' '.join(g['why']), 'transient after 1 reset')

    def test_real_http_errors_and_bad_payloads_still_fail_at_once(self):
        for bad in ('500', 'badpong'):
            rc, g = self.gate(['ok', 'ok', 'ok', bad, 'ok'])
            self.assertEqual((rc, g['state'], g['resets']), (1, 'FAIL', []), bad); self.assertRegex(' '.join(g['why']), 'after the window started')

    def test_a_transient_with_any_other_problem_fails(self):
        rc, g = self.gate(['ok', 'ok', 'ok', 'drop', 'ok'], avail_script=['ok', 'ok', 'ok', '503', 'ok'])
        self.assertEqual((rc, g['state'], g['resets']), (1, 'FAIL', [])); self.assertRegex(' '.join(g['why']), 'availability')

    def test_the_deadline_never_extends(self):
        rc, g = self.gate(['ok', 'ok', 'ok', 'drop', 'ok'], deadline=6)
        self.assertEqual((rc, g['state'], len(g['resets'])), (1, 'FAIL', 1)); self.assertRegex(' '.join(g['why']), 'overall deadline 6 s')

    def test_hard_faults_after_a_reset_still_fail(self):
        rc, g = self.gate(['ok', 'ok', 'ok', 'drop', 'ok'], avail_script=['ok', 'ok', 'ok', 'ok', 'ok', 'unvouched'])
        self.assertEqual((rc, g['state'], len(g['resets'])), (1, 'FAIL', 1)); self.assertRegex(' '.join(g['why']), 'UNVOUCHED')
        rc, g = self.gate(['ok', 'ok', 'ok', 'drop', 'ok'], avail_script=['ok', 'ok', 'ok', 'ok', 'frozen'])
        self.assertEqual((rc, g['state'], len(g['resets'])), (1, 'FAIL', 1)); self.assertRegex(' '.join(g['why']), 'vouch stale')

    def test_a_transient_in_warm_up_is_v4_warm_up(self):
        rc, g = self.gate(['drop', 'ok']); self.assertEqual((rc, g['state'], g['resets'], g['resetCount']), (0, 'PASS', [], 0))

def v5_namespace():
    """The v5 helper definitions, exec'd from the gate source (the script parses arguments at import)."""
    src = (ROOT/'verify-operational-v5.py').read_text(); t = ast.parse(src)
    want = {'MAX_RESETS', 'LAST_ERROR', '_fetch_recording', 'TRANSIENT', 'is_transient'}
    seg = [ast.get_source_segment(src, n) for n in t.body if (isinstance(n, ast.FunctionDef) and n.name in want)
           or (isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name) and n.targets[0].id in want)]
    ns = {'apphealth': apphealth, 'urllib': urllib, 'socket': socket, 'ssl': ssl}
    exec('\n'.join(seg), ns); return ns

class Classify(unittest.TestCase):
    def test_transient_is_only_no_http_response_for_a_transport_reason(self):
        f = v5_namespace()['is_transient']
        for e in [urllib.error.URLError(ConnectionRefusedError()), urllib.error.URLError(TimeoutError()), urllib.error.URLError(socket.timeout()),
                  urllib.error.URLError(socket.gaierror()), TimeoutError(), ConnectionResetError(), __import__('http.client').client.RemoteDisconnected()]:
            self.assertTrue(f(e), repr(e))
        for e in [None, urllib.error.URLError(ssl.SSLCertVerificationError()), urllib.error.URLError(ssl.SSLError()), ssl.SSLError(),
                  urllib.error.HTTPError('u', 500, 'x', {}, None), ValueError(), urllib.error.URLError('bad url'), __import__('http.client').client.IncompleteRead(b'')]:
            self.assertFalse(f(e), repr(e))
        class TLSReset(ssl.SSLError, ConnectionResetError): pass        # TLS is never transient, even when it is ALSO a reset
        self.assertFalse(f(TLSReset())); self.assertFalse(f(urllib.error.URLError(TLSReset())))

    def test_the_recording_fetch_answers_exactly_as_apphealth_fetch(self):
        ns = v5_namespace(); rec = ns['_fetch_recording']
        for script in (['ok'], ['500'], ['drop'], ['badpong']):
            s = Server(eyes(script))
            try:
                a = apphealth.fetch(s.url + '/ping', 3); b = rec(s.url + '/ping', 3)
                self.assertEqual(a, b, script)
                self.assertEqual(ns['LAST_ERROR'][s.url + '/ping'] is not None, script == ['drop'])
            finally: s.close()
        p = socket.socket(); p.bind(('127.0.0.1', 0)); port = p.getsockname()[1]; p.close()      # nothing listening: refused
        url = f'http://127.0.0.1:{port}/ping'
        self.assertEqual(apphealth.fetch(url, 3), rec(url, 3)); self.assertTrue(ns['is_transient'](ns['LAST_ERROR'][url]))

if __name__ == '__main__': unittest.main()
