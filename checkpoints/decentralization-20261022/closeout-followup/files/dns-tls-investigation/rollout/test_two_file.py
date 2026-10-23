#!/usr/bin/env python3
"""Offline tests of remote_two_file.py (the program root sends) and deploy-two-file.py's pins. A fake root holds the two
relay files; a fake systemctl (its own state file) restarts by bumping the MainPID; a stub relay on loopback answers the
two readiness probes - and, in the 'broken' scenarios, answers differently while the NEW certs.js is on disk. node --check is
the REAL node on the REAL old (ad074e2) and new (a2b8fabd) bytes. Nothing here uses the network beyond 127.0.0.1."""
import base64, hashlib, http.server, importlib.util, json, os, pathlib, shutil, stat, subprocess, sys, tempfile, threading, unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent / 'candidate'
sha = lambda b: hashlib.sha256(b).hexdigest()
spec = importlib.util.spec_from_file_location('remote', HERE / 'remote_two_file.py'); R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
dspec = importlib.util.spec_from_file_location('deploy', HERE / 'deploy-two-file.py'); D = importlib.util.module_from_spec(dspec); dspec.loader.exec_module(D)
git = lambda rev, path: subprocess.run(['git', '-C', str(REPO), 'show', f'{rev}:{path}'], capture_output=True, check=True).stdout
OLD = {n: git('ad074e2', p) for n, p, _o, _n in D.FILES}
NEW = {n: git(D.COMMIT, p) for n, p, _o, _n in D.FILES}
PROBE_ID = D.CFG['probeId']

FAKE_SYSTEMCTL = r'''#!/usr/bin/env python3
import json, sys, pathlib
s = pathlib.Path(__file__).with_name('state.json'); st = json.loads(s.read_text())
import time
a = sys.argv[1:]; st['calls'].append(a)
if a[0] == 'show':
    st['shows'] = st.get('shows', 0) + 1
    if st.get('pidChangeAtShow') == st['shows']: st['pid'] = 4242   # another process took the unit's place
    print(st['pid'])
elif a[0] == 'is-active': print('active' if st['active'] else 'failed')
elif a[0] == 'restart':
    if st['failRestarts'] > 0:
        st['failRestarts'] -= 1; st['active'] = False; s.write_text(json.dumps(st)); sys.exit(1)
    st['pid'] += 1; st['active'] = True
    if st.get('slowRestarts', 0) > 0:   # the restart's side effect happens, THEN the command outlasts its timeout
        st['slowRestarts'] -= 1; s.write_text(json.dumps(st)); time.sleep(6)
s.write_text(json.dumps(st))
'''


class World:
    def __init__(self, broken=False, all500=False):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix='two-file-', dir=HERE / 'tmp'))
        self.dir = self.tmp / 'opt-nan-relay'; self.dir.mkdir()
        (self.dir / 'package.json').write_text('{"type":"module"}\n')
        for n, b in OLD.items():
            (self.dir / n).write_bytes(b); os.chmod(self.dir / n, 0o644)
        self.bin = self.tmp / 'bin'; self.bin.mkdir()
        (self.bin / 'systemctl').write_text(FAKE_SYSTEMCTL); os.chmod(self.bin / 'systemctl', 0o755)
        self.state = self.bin / 'state.json'; self.set(pid=222659, active=True, failRestarts=0, calls=[])
        self.broken = broken; self.all500 = all500
        world = self
        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_GET(self):
                new_loaded = sha((world.dir / 'certs.js').read_bytes()) == D.FILES[0][3] and world.get()['pid'] > 222659
                if world.all500:
                    code, body = 500, {'error': 'internal', 'message': 'x'}
                elif self.path == '/v1/certs/issue':
                    code, body = (503, {'error': 'certs_disabled', 'message': 'x'}) if (world.broken and new_loaded) else (405, {'error': 'method_not_allowed', 'message': 'POST only.'})
                elif self.path == '/v1/secrets/release-status?id=' + PROBE_ID:
                    code, body = 200, {'id': PROBE_ID, 'listed': True}
                else:
                    code, body = 404, {'error': 'not_found'}
                b = json.dumps(body).encode(); self.send_response(code); self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
        self.srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.cfg = {'dir': str(self.dir), 'backup': str(self.tmp / 'backup'), 'service': 'enclave-api-relay', 'systemctl': str(self.bin / 'systemctl'),
                    'node': shutil.which('node'), 'probeBase': f'http://127.0.0.1:{self.srv.server_port}', 'probeId': PROBE_ID,
                    'readySec': 3, 'restartSec': 2, 'expectedPid': '222659'}
    def set(self, **kw):
        st = json.loads(self.state.read_text()) if self.state.exists() else {}
        st.update(kw); self.state.write_text(json.dumps(st))
    def get(self): return json.loads(self.state.read_text())
    def restarts(self): return sum(1 for c in self.get()['calls'] if c[0] == 'restart')
    def shas(self): return {n: sha((self.dir / n).read_bytes()) for n in OLD}
    def payload(self, mode='apply', new=None):
        files = []
        for n, _p, o, nw in D.FILES:
            e = {'name': n, 'old': o, 'new': nw}
            if mode == 'apply':
                b = (new or {}).get(n, NEW[n]); e['new'] = sha(b); e['source'] = base64.b64encode(b).decode()
            files.append(e)
        return {'files': files}
    def run(self, mode, **kw): return R.main(self.payload(mode, **kw), self.cfg, mode)
    def close(self): self.srv.shutdown(); self.srv.server_close(); shutil.rmtree(self.tmp, ignore_errors=True)

OLDS = {n: o for n, _p, o, _n in D.FILES}; NEWS = {n: nw for n, _p, _o, nw in D.FILES}


class TwoFile(unittest.TestCase):
    def setUp(self): (HERE / 'tmp').mkdir(exist_ok=True); self.w = World()
    def tearDown(self): self.w.close()
    def fresh(self, **kw): w = World(**kw); self.addCleanup(w.close); return w
    def nothing_changed(self, w):
        self.assertEqual(w.shas(), OLDS); self.assertEqual(w.restarts(), 0)
        self.assertFalse(any('dns-tls-candidate' in p.name for p in w.dir.iterdir()), 'no temp left')

    def test_pins_match_the_commit_and_the_installed_bytes(self):
        self.assertEqual({n: sha(b) for n, b in OLD.items()}, OLDS, 'the pinned OLD hashes are ad074e2 (installed lineage)')
        self.assertEqual({n: sha(b) for n, b in NEW.items()}, NEWS, 'the pinned NEW hashes are the commit')
        prog = D.build('apply', '222659')
        self.assertIn('"service": "enclave-api-relay"', prog); self.assertIn('"dir": "/opt/nan-relay"', prog)
        self.assertNotIn('"source"', D.build('rollback', '222659'), 'a rollback carries no file content')
    def test_a_tampered_remote_program_or_bad_args_refuse_before_any_ssh(self):
        saved = D.REMOTE_SHA; D.REMOTE_SHA = '0' * 64
        try:
            with self.assertRaises(SystemExit): D.build('apply', '222659')
        finally: D.REMOTE_SHA = saved
        for argv in (['x'], ['x', 'restart'], ['x', 'apply', '--expected-pid', '12;rm'], ['x', 'apply', 'extra'], ['x', 'rollback', '--expected-pid', '5']):
            with self.assertRaises(SystemExit): D.run(argv)

    def test_preflight_is_read_only(self):
        before = sorted(p.name for p in self.w.dir.iterdir())
        r = self.w.run('preflight'); self.assertEqual(r['status'], 'PREFLIGHT_OK', r)
        self.assertEqual(r['baseline'], {'certs': [405, 'method_not_allowed'], 'release': [200, {'id': PROBE_ID, 'listed': True}]})
        self.assertEqual(sorted(p.name for p in self.w.dir.iterdir()), before); self.assertFalse(pathlib.Path(self.w.cfg['backup']).exists())
        self.nothing_changed(self.w)
    def test_preflight_and_apply_refuse_on_identity_hashes_leftovers_and_a_silent_relay(self):
        cases = [('pid', lambda w: w.set(pid=1234), 'MainPID is 1234'), ('inactive', lambda w: w.set(active=False), 'not active'),
                 ('old sha', lambda w: (w.dir / 'certs.js').write_bytes(b'export const x = 1;\n'), 'not the pinned old'),
                 ('backup', lambda w: pathlib.Path(w.cfg['backup']).mkdir(), 'earlier attempt ran'),
                 ('temp', lambda w: (w.dir / 'certs.dns-tls-candidate.js').write_bytes(b''), 'left from an earlier attempt'),
                 ('silent relay', lambda w: (w.srv.shutdown(), w.srv.server_close()), 'expected baseline')]
        for mode in ('preflight', 'apply'):
            for name, change, word in cases:
                w = self.fresh(); change(w); before = w.shas()
                r = w.run(mode); self.assertEqual(r['status'], 'REFUSED', (mode, name, r)); self.assertIn(word, r['reason'], (mode, name))
                self.assertEqual(w.shas(), before); self.assertEqual(w.restarts(), 0)
    def test_the_check_must_accept_the_installed_files_first(self):
        (self.w.dir / 'package.json').unlink()   # an environment where node --check cannot parse the running ESM .js
        (self.w.dir / 'package.json').write_text('{"type":"commonjs"}\n')
        r = self.w.run('apply'); self.assertEqual(r['status'], 'REFUSED', r); self.assertIn('check method is not valid', r['reason'])
        self.nothing_changed(self.w); self.assertFalse(pathlib.Path(self.w.cfg['backup']).exists())

    def test_apply_swaps_both_restarts_once_and_is_ready(self):
        r = self.w.run('apply'); self.assertEqual(r['status'], 'DEPLOYED_READY', r)
        self.assertEqual(self.w.shas(), NEWS); self.assertEqual(self.w.restarts(), 1); self.assertEqual(r['newPid'], '222660')
        self.assertEqual(r['probes'], r['baseline']); self.assertIn('functional proof', r['pending'])
        b = pathlib.Path(self.w.cfg['backup'])
        self.assertEqual({n: sha((b / n).read_bytes()) for n in OLD}, OLDS)
        self.assertEqual(stat.S_IMODE(b.stat().st_mode), 0o700); self.assertTrue(all(stat.S_IMODE((b / n).stat().st_mode) == 0o600 for n in OLD))
        self.assertTrue(all(stat.S_IMODE((self.w.dir / n).stat().st_mode) == 0o644 for n in OLD), 'mode kept')
        self.assertEqual(json.loads((b / 'manifest.json').read_text())['oldPid'], '222659')
        r2 = self.w.run('apply'); self.assertEqual(r2['status'], 'REFUSED', 'a second apply refuses'); self.assertEqual(self.w.restarts(), 1)
    def test_a_new_file_node_refuses_changes_nothing_and_leaves_no_backup(self):
        r = self.w.run('apply', new={'measurement-predict.mjs': b'export const = ;\n'})
        self.assertEqual(r['status'], 'REFUSED', r); self.assertIn('node --check refused the new measurement-predict.mjs', r['reason'])
        self.nothing_changed(self.w); self.assertFalse(pathlib.Path(self.w.cfg['backup']).exists())
    def test_a_failed_restart_restores_both_and_restarts_once_more(self):
        self.w.set(failRestarts=1)
        r = self.w.run('apply'); self.assertEqual(r['status'], 'ROLLED_BACK', r)
        self.assertEqual(self.w.shas(), OLDS); self.assertEqual(self.w.restarts(), 2); self.assertEqual(r['rollbackProbes'], {'certs': [405, 'method_not_allowed'], 'release': [200, {'id': PROBE_ID, 'listed': True}]}, 'ROLLED_BACK means the old code was verified answering')
    def test_a_relay_that_answers_differently_on_the_new_code_is_rolled_back(self):
        w = self.fresh(broken=True)
        r = w.run('apply'); self.assertEqual(r['status'], 'ROLLED_BACK', r); self.assertIn('readiness window', r['error'])
        self.assertEqual(w.shas(), OLDS); self.assertEqual(w.restarts(), 2)
        self.assertEqual(r['rollbackProbes'], r['baseline'], 'ROLLED_BACK means the old code was verified answering')
    def test_a_rollback_restart_failure_is_a_failure_not_a_rollback(self):
        self.w.set(failRestarts=2)
        r = self.w.run('apply'); self.assertEqual(r['status'], 'ROLLBACK_NOT_READY', r)
        self.assertEqual(self.w.shas(), OLDS, 'the files are back even so'); self.assertEqual(self.w.restarts(), 2, 'no third restart')

    # ---- root review 2026-10-23: ambiguous restarts, partial swaps, the expected baseline, the CAS just before the swap
    def test_a_restart_that_times_out_after_starting_the_service_is_rolled_back_and_verified(self):
        self.w.set(slowRestarts=1)
        r = self.w.run('apply'); self.assertEqual(r['status'], 'ROLLED_BACK', r)
        self.assertEqual(r['restarts'], [['apply', 'timeout'], ['rollback', 0]], 'the timed-out attempt counted; one rollback restart')
        self.assertEqual(self.w.shas(), OLDS); self.assertEqual(r['rollbackProbes'], {'certs': [405, 'method_not_allowed'], 'release': [200, {'id': PROBE_ID, 'listed': True}]})
        self.assertNotEqual(r['rollbackPid'], '222660', 'a process started after the restore, not the one the timed-out restart began')
    def test_when_the_rollback_restart_also_times_out_the_result_is_a_failure(self):
        self.w.set(slowRestarts=2)
        r = self.w.run('apply'); self.assertEqual(r['status'], 'ROLLBACK_NOT_READY', r); self.assertIn('timeout', r['why'])
        self.assertEqual(r['restarts'], [['apply', 'timeout'], ['rollback', 'timeout']]); self.assertEqual(self.w.shas(), OLDS)
    def test_a_failed_second_replace_restores_the_first_and_verifies_the_untouched_process(self):
        real = R.os.replace; n = {'calls': 0}
        def flaky(a, b):
            n['calls'] += 1
            if n['calls'] == 2: raise OSError('injected: the second replace failed')
            return real(a, b)
        R.os.replace = flaky
        try: r = self.w.run('apply')
        finally: R.os.replace = real
        self.assertEqual(r['status'], 'ROLLED_BACK', r); self.assertIn('second replace', r['error'])
        self.assertEqual(r['restarts'], [], 'nothing restarted'); self.assertEqual(r['rollbackPid'], '222659', 'the original process still answers')
        self.assertEqual(self.w.shas(), OLDS); self.assertFalse(any('dns-tls-candidate' in p.name for p in self.w.dir.iterdir()))
    def test_a_baseline_that_is_not_the_expected_answer_refuses_even_when_unchanged(self):
        w = self.fresh(all500=True)
        for mode in ('preflight', 'apply'):
            r = w.run(mode); self.assertEqual(r['status'], 'REFUSED', r); self.assertIn('expected baseline', r['reason'])
        self.nothing_changed(w)
    def test_the_identity_is_rechecked_immediately_before_the_first_swap(self):
        self.w.set(pidChangeAtShow=2)   # show #1 = the first identity check, show #2 = the re-check after the backups
        r = self.w.run('apply'); self.assertEqual(r['status'], 'REFUSED', r); self.assertIn('MainPID is 4242', r['reason'])
        self.nothing_changed(self.w); self.assertTrue(pathlib.Path(self.w.cfg['backup']).is_dir(), 'the verified backup stays for inspection')
    def test_both_old_hashes_are_rechecked_immediately_before_the_first_swap(self):
        import types
        real = R.json; w = self.w
        def dumps(o, *a, **k):
            if isinstance(o, dict) and 'oldPid' in o and 'files' in o and 'mode' not in o:   # the manifest, written after the backups
                (w.dir / 'measurement-predict.mjs').write_bytes(b'export const changedMeanwhile = 1;\n')
            return real.dumps(o, *a, **k)
        R.json = types.SimpleNamespace(dumps=dumps, loads=real.loads)
        try: r = w.run('apply')
        finally: R.json = real
        self.assertEqual(r['status'], 'REFUSED', r); self.assertIn('measurement-predict.mjs is', r['reason'])
        self.assertEqual(sha((w.dir / 'certs.js').read_bytes()), OLDS['certs.js'], 'nothing swapped'); self.assertEqual(w.restarts(), 0)
        self.assertFalse(any('dns-tls-candidate' in p.name for p in w.dir.iterdir()))
    def test_status_is_read_only_and_reports_the_last_result(self):
        self.assertEqual(self.w.run('apply')['status'], 'DEPLOYED_READY')
        r = self.w.run('status'); self.assertEqual(r['status'], 'STATUS'); self.assertEqual(r['shas'], NEWS); self.assertEqual(r['last']['status'], 'DEPLOYED_READY')
        self.assertEqual(self.w.restarts(), 1)

    def test_explicit_rollback_restores_both_with_one_restart(self):
        self.assertEqual(self.w.run('apply')['status'], 'DEPLOYED_READY')
        r = self.w.run('rollback'); self.assertEqual(r['status'], 'ROLLED_BACK_READY', r)
        self.assertEqual(self.w.shas(), OLDS); self.assertEqual(self.w.restarts(), 2); self.assertEqual(r['before'], {n: 'new' for n in OLD})
        self.assertEqual(self.w.run('rollback')['status'], 'NOTHING_TO_ROLL_BACK'); self.assertEqual(self.w.restarts(), 2)
    def test_rollback_refuses_without_a_verified_backup_or_on_unknown_bytes(self):
        r = self.w.run('rollback'); self.assertEqual(r['status'], 'REFUSED'); self.assertIn('no backup', r['reason'])
        self.assertEqual(self.w.run('apply')['status'], 'DEPLOYED_READY')
        (self.w.dir / 'certs.js').write_bytes(b'export const operator = 1;\n')
        r = self.w.run('rollback'); self.assertEqual(r['status'], 'REFUSED'); self.assertIn('neither the old nor the new', r['reason'])
        self.assertEqual(self.w.restarts(), 1)
        w = self.fresh(); self.assertEqual(w.run('apply')['status'], 'DEPLOYED_READY')
        (pathlib.Path(w.cfg['backup']) / 'certs.js').write_bytes(b'changed backup')
        r = w.run('rollback'); self.assertEqual(r['status'], 'REFUSED'); self.assertIn('backup of certs.js', r['reason'])


if __name__ == '__main__':
    unittest.main()
