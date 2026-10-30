#!/usr/bin/env python3
"""Offline fixture tests for the r3 diagnostic probes + status.py (PREPARED; NOT run by Claude: jobs/root-probe-fixture-tests.sh, exact
count 7). Drives the ACTUAL guest/el_probe.mjs and guest/helios_probe.mjs with node against an in-process mock JSON-RPC server on
127.0.0.1 (never a production endpoint). env: NODE (node binary), K (file URL of the pinned @noble/hashes sha3.js taken from the
canary r3 bundle by the job). Covers: noble keccak KAT, empty params, valid responses, RPC errors, partial progress surviving SIGKILL,
Helios never ready -> incomplete, and no positive verdict anywhere."""
import http.server, json, os, pathlib, signal, subprocess, sys, tempfile, threading, time, unittest
HERE = pathlib.Path(__file__).resolve().parent; ST = HERE.parent
NODE, K = os.environ['NODE'], os.environ['K']
PORTAL = '0x49048044d57e1c92a77f79988d21fa8faf74e97e'
FIN = {'number': '0x1000', 'hash': '0x' + 'ab' * 32, 'timestamp': hex(int(time.time()) - 780)}

class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers['content-length'])))
        m, srv = req['method'], self.server; srv.seen.append((m, req.get('params')))
        if m in srv.hang:
            time.sleep(30)
        if m in srv.errors:
            body = {'jsonrpc': '2.0', 'id': req['id'], 'error': {'code': -32000, 'message': f'mock {m} failure'}}
        else:
            body = {'jsonrpc': '2.0', 'id': req['id'], 'result': srv.answer(m, req.get('params'))}
        b = json.dumps(body).encode(); self.send_response(200); self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)

def answer(ready=True):
    def f(m, p):
        return {'eth_blockNumber': '0x1040', 'eth_getBlockByNumber': FIN if ready else None, 'eth_call': '0x' + '00' * 12 + '11' * 20,
                'eth_createAccessList': {'accessList': [{'address': PORTAL, 'storageKeys': ['0x' + '00' * 32]}], 'gasUsed': '0x5208'},
                'eth_getProof': {'address': p[0] if p else None, 'accountProof': [], 'storageProof': []}}.get(m)
    return f

class Probes(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='probe-fixture-')); os.chmod(self.d, 0o700)
    def serve(self, ready=True, errors=(), hang=()):
        s = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock); s.seen, s.errors, s.hang, s.answer = [], set(errors), set(hang), answer(ready)
        s.daemon_threads = True; threading.Thread(target=s.serve_forever, daemon=True).start(); self.addCleanup(s.shutdown)
        return s, f'http://127.0.0.1:{s.server_address[1]}/'
    def node(self, probe, url, out, extra=None, wait=True):
        env = {'PATH': '/usr/bin:/bin', 'K': K, **(extra or {})}
        p = subprocess.Popen([NODE, str(ST / 'guest' / probe), url, str(out)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if wait:
            o, e = p.communicate(timeout=120); self.assertEqual(p.returncode, 0, e)
        return p
    def status(self, phase_rc, variants='100', pids=True):
        (self.d / 'phase-rc.txt').write_text(''.join(f'{k} {v}\n' for k, v in phase_rc.items()))
        if pids: (self.d / 'pids-after.txt').write_text('x 1\n')
        else: (self.d / 'pids-after.txt').unlink(missing_ok=True)
        p = subprocess.run([sys.executable, '-I', str(ST / 'tools/status.py'), str(self.d), variants], capture_output=True, text=True, timeout=60)
        return p.returncode, json.loads((self.d / 'status.json').read_text())

    def test_noble_keccak_kat_from_the_bundle(self):
        p = subprocess.run([NODE, '--input-type=module', '-e', "const k=await import(process.env.K);"
                            "console.log(Buffer.from(k.keccak_256(new Uint8Array(0))).toString('hex'))"], env={'PATH': '/usr/bin:/bin', 'K': K},
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.stdout.strip(), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', p.stderr)

    def test_empty_params_first_request_is_recorded_not_fatal(self):
        s, url = self.serve(); self.node('el_probe.mjs', url, self.d / 'el-probe.json')
        r = json.loads((self.d / 'el-probe.json').read_text())
        self.assertEqual((r['steps'][0]['label'], r['steps'][0]['block']), ('head', None)); self.assertNotIn('error', r['steps'][0])
        self.assertEqual(s.seen[0], ('eth_blockNumber', []))

    def test_valid_responses_complete_phase_a(self):
        s, url = self.serve(); self.node('el_probe.mjs', url, self.d / 'el-probe.json')
        r = json.loads((self.d / 'el-probe.json').read_text())
        self.assertIs(r['complete'], True); self.assertEqual(r['finalized']['number'], 0x1000); self.assertEqual(r['distance'], 0x40)
        self.assertEqual(len(r['steps']), 13); self.assertTrue(all(isinstance(x['ms'], int) and 'error' not in x for x in r['steps']))
        self.assertEqual([p for m, p in s.seen if m == 'eth_getProof'][-1][2], hex(0x1000 - 300))
        rc, st = self.status({'A': '0'}, variants='100'); self.assertEqual(st['phases']['A'], 'complete')
        self.assertEqual(rc, 10, 'B100 requested but absent: the run as a whole is incomplete')

    def test_rpc_errors_are_observations_and_never_abort(self):
        _, url = self.serve(errors={'eth_getProof', 'eth_createAccessList'}); self.node('el_probe.mjs', url, self.d / 'el-probe.json')
        r = json.loads((self.d / 'el-probe.json').read_text())
        errs = [x['label'] for x in r['steps'] if 'error' in x]
        self.assertTrue(errs and all(l.startswith(('proof', 'accessList')) for l in errs), errs)
        self.assertIs(r['complete'], True); self.assertIn('mock eth_getProof failure', json.dumps(r))
        _, url2 = self.serve(errors={'eth_getBlockByNumber'}); d2 = self.d / 'nofin.json'; self.node('el_probe.mjs', url2, d2)
        r2 = json.loads(d2.read_text()); self.assertIs(r2['complete'], False); self.assertIn('no finalized block', r2['incompleteReason'])

    def test_partial_progress_survives_sigkill_and_is_incomplete(self):
        _, url = self.serve(hang={'eth_createAccessList'}); out = self.d / 'el-probe.json'
        p = self.node('el_probe.mjs', url, out, wait=False)
        for _ in range(200):
            if out.exists() and 'call@latest' in out.read_text(): break
            time.sleep(0.05)
        p.send_signal(signal.SIGKILL); p.wait(timeout=30)
        r = json.loads(out.read_text())
        self.assertEqual([x['label'] for x in r['steps']], ['head', 'finalized', 'call@finalizedHash', 'call@latest'])
        self.assertIs(r['complete'], False); self.assertNotIn('finishedAt', r)
        rc, st = self.status({'A': '-9'}, variants='100'); self.assertTrue(st['phases']['A'].startswith('incomplete'))
        rc, st = self.status({'A': '0'}, variants='100'); self.assertTrue(st['phases']['A'].startswith('incomplete'), st)

    def test_helios_never_ready_is_incomplete_never_complete(self):
        _, url = self.serve(ready=False); self.node('helios_probe.mjs', url, self.d / 'helios-probe-100.json', extra={'READY_MS': '1500'})
        h = json.loads((self.d / 'helios-probe-100.json').read_text())
        self.assertIs(h['complete'], False); self.assertIsNone(h['finalized']); self.assertEqual(h['steps'], [])
        (self.d / 'el-requests-100.jsonl').write_text('')
        rc, st = self.status({'A': '0', 'B100': '0'}, variants='100')
        self.assertTrue(st['phases']['B100'].startswith('incomplete') and 'no finalized block' in st['phases']['B100'], st); self.assertEqual(rc, 10)

    def test_full_success_is_still_only_a_diagnostic_with_no_positive_verdict(self):
        _, url = self.serve(); self.node('el_probe.mjs', url, self.d / 'el-probe.json')
        self.node('helios_probe.mjs', url, self.d / 'helios-probe-100.json', extra={'READY_MS': '5000'})
        (self.d / 'el-requests-100.jsonl').write_text('{}\n')
        rc, st = self.status({'A': '0', 'B100': '0'}, variants='100'); self.assertEqual((rc, st['complete']), (0, True))
        self.assertIn('NOT a capture, readiness or finality verdict', st['kind'])
        blob = json.dumps(st) + (self.d / 'el-probe.json').read_text() + (self.d / 'helios-probe-100.json').read_text()
        for word in ('"verdict"', '"ready"', '"qualified"', '"passed"', '"readiness":'):
            self.assertNotIn(word, blob)
        rc, st = self.status({'A': '0', 'B100': '0'}, variants='100', pids=False)
        self.assertEqual(rc, 30); self.assertIn('never re-checked', json.dumps(st))

if __name__ == '__main__':
    unittest.main()
