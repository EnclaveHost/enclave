#!/usr/bin/env python3
"""Offline tests for srr3_fetch.py (root runs them; Claude never did). REAL curl against a LOOPBACK HTTP fault server, REAL SIGKILL/SIGTERM
of the tool, production ownership mode (--owner-uid = the running uid), on the filesystem named by SRR3_TEST_ROOT (root points it at a
0700 directory on the TARGET ntfs3 filesystem so pwrite/fsync/rename/flock/mode semantics are those of production). HOME is not changed.
The only test-specific switch is --allow-http-loopback (http://127.0.0.1 + kill hooks); the production URL is pinned https."""
import fcntl, hashlib, http.server, json, os, shutil, signal, socketserver, stat, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE.parent / 'srr3_fetch.py'
CURL = os.environ.get('SRR3_CURL') or shutil.which('curl') or '/usr/bin/curl'
ROOT = os.environ.get('SRR3_TEST_ROOT', '')
CHUNK = 1 << 20
PAYLOAD = hashlib.sha256(b'srr3').digest() * (5 * 32768) + b'tail-7b'     # 5 MiB + 7 bytes = 6 chunks, the last 7 bytes
RESERVE = 500_000_000_000
ETAG, LM = '"v1"', 'Mon, 26 Oct 2026 10:00:00 GMT'


class Srv:
    @classmethod
    def reset(cls):
        cls.mode, cls.after, cls.times, cls.sleep, cls.requests, cls.body = 'ok', 0, 0, 0.0, [], PAYLOAD


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def do_GET(self):
        Srv.requests.append({k: self.headers.get(k) for k in ('Range', 'If-Range', 'Accept-Encoding')})
        body, n = Srv.body, len(Srv.body)
        mode = Srv.mode if len(Srv.requests) > Srv.after else 'ok'
        if mode in ('503', 'cut', 'stall'):
            if Srv.times <= 0: mode = 'ok'
            else: Srv.times -= 1
        if mode == '503':
            return self._raw(503, b'busy', {})
        if mode == 'redirect':
            return self._raw(302, b'', {'Location': 'https://127.0.0.1:9/x'})
        etag = '"v2"' if mode in ('etag-ifrange', 'etag-206') else ('W/"v1"' if mode == 'weak' else ETAG)
        lm = 'Tue, 27 Oct 2026 10:00:00 GMT' if mode == 'lm' else LM
        hdr = [('ETag', etag), ('Last-Modified', lm)]
        if mode == 'gzip':
            hdr.append(('Content-Encoding', 'gzip'))
        rng, ifr = self.headers.get('Range'), self.headers.get('If-Range')
        if mode == 'ignore-range' or not rng or (mode not in ('etag-206', 'weak') and ifr is not None and ifr != etag):
            return self._body(200, body, hdr, str(len(body)))
        s, e = (int(x) for x in rng.split('=')[1].split('-'))
        e = min(e, n - 1); part = body[s:e + 1]
        hdr.append(('Content-Range', f'bytes {s + 1 if mode == "wrong-start" else s}-{e}/{n + 1 if mode == "wrong-total" else n}'))
        if mode == 'dup':
            hdr.append(('Content-Range', f'bytes {s}-{e}/{n}'))
        if mode == 'oversize':
            part = body[s:e + 2]
        clen = f'{len(part)}x' if mode == 'badlen' else str(len(part))
        return self._body(206, part, hdr, clen, cut=mode == 'cut', stall=mode == 'stall')
    def _raw(self, code, data, hdr):
        self.send_response(code)
        for k, v in hdr.items(): self.send_header(k, v)
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def _body(self, code, data, hdr, clen, cut=False, stall=False):
        self.send_response(code)
        for k, v in hdr: self.send_header(k, v)
        self.send_header('Content-Length', clen); self.end_headers()
        try:
            if stall:
                self.wfile.write(data[:100]); self.wfile.flush(); time.sleep(6); return
            limit = len(data) // 3 if cut else len(data)
            for i in range(0, limit, 65536):
                self.wfile.write(data[i:min(i + 65536, limit)])
                if Srv.sleep: time.sleep(Srv.sleep)
            if cut: self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            pass


class TS(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True; allow_reuse_address = True


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not ROOT or not os.path.isdir(ROOT):
            raise RuntimeError('SRR3_TEST_ROOT (a 0700 directory on the target filesystem) is required')
        cls.srv = TS(('127.0.0.1', 0), H); cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Srv.reset()
        self.d = Path(tempfile.mkdtemp(prefix='srr3-', dir=ROOT)); self.addCleanup(shutil.rmtree, self.d, True)
        self.work = self.d / 'work'
        self.url = f'http://127.0.0.1:{self.port}/1792886410/state.tar.zst'
        m = {'block': 1, 'base_url': f'http://127.0.0.1:{self.port}',
             'components': {'state': {'file': '1792886410/state.tar.zst', 'size': len(PAYLOAD), 'output_files': []}}}
        self.man = self.d / 'manifest.json'; self.man.write_text(json.dumps(m))
        self.msha = hashlib.sha256(self.man.read_bytes()).hexdigest()

    def argv(self, cmd, *extra, reserve=RESERVE, pins=True):
        a = [sys.executable, '-I', str(TOOL), cmd, '--manifest', str(self.man), '--manifest-sha256', self.msha, '--expect-url', self.url,
             '--expect-total', str(len(PAYLOAD)), '--work-dir', str(self.work), '--curl', CURL, '--owner-uid', str(os.getuid()),
             '--reserve-bytes', str(reserve), '--allow-http-loopback', '--chunk-seconds', '20', '--stall-seconds', '2']
        if cmd == 'fetch':
            a += ['--chunk-bytes', str(CHUNK), '--max-failures', '5', '--backoff-cap', '1']
            if pins:
                a += ['--expect-etag', ETAG, '--expect-last-modified', LM]
        return a + list(extra)

    def run_tool(self, cmd, *extra, env=None, **kw):
        return subprocess.run(self.argv(cmd, *extra, **kw), capture_output=True, text=True, env=dict(os.environ, **(env or {})), timeout=180)

    def committed(self):
        return json.loads((self.work / 'committed.json').read_text())

    def arch(self):
        p = self.work / 'state.tar.zst'
        return p.read_bytes() if p.exists() else b''

    def prefix(self):
        off = self.committed()['offset']; b = self.arch()
        self.assertLessEqual(off, len(b)); self.assertEqual(b[:off], PAYLOAD[:off]); return off


class Fetch(Base):
    def test_lone_temporary_progress_record_is_preserved(self):
        r = self.run_tool('fetch'); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        archive_before = self.arch()
        temporary = self.work / 'committed.json.tmp'
        (self.work / 'committed.json').rename(temporary)
        record_before = temporary.read_bytes()
        Srv.reset()
        r = self.run_tool('fetch')
        self.assertEqual(r.returncode, 5, r.stdout + r.stderr)
        self.assertEqual(temporary.read_bytes(), record_before)
        self.assertEqual(self.arch(), archive_before)
        self.assertFalse((self.work / 'committed.json').exists())
        self.assertEqual(Srv.requests, [])

    def test_loopback_switch_refuses_https_before_network(self):
        manifest = json.loads(self.man.read_text())
        manifest['base_url'] = 'https://example.invalid/'
        self.man.write_text(json.dumps(manifest))
        self.msha = hashlib.sha256(self.man.read_bytes()).hexdigest()
        self.url = 'https://example.invalid/' + manifest['components']['state']['file']
        r = self.run_tool('fetch')
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn('requires an actual http://127.0.0.1 URL', r.stdout)
        self.assertEqual(Srv.requests, [])

    def test_filesystem_semantics_of_the_target(self):
        p = self.d / 'fs'; os.mkdir(p, 0o700); os.chmod(p, 0o700)
        self.assertEqual(stat.S_IMODE(os.lstat(p).st_mode), 0o700, 'mode 0700 must persist on this filesystem')
        fd = os.open(p / 'f', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.pwrite(fd, b'abc', 4096); os.fsync(fd); os.close(fd)
        st = os.lstat(p / 'f'); self.assertEqual((st.st_size, st.st_uid, st.st_nlink), (4099, os.getuid(), 1)); self.assertFalse(st.st_mode & 0o022)
        (p / 'g').write_text('new'); os.replace(p / 'g', p / 'f'); self.assertEqual((p / 'f').read_text(), 'new')
        dfd = os.open(p, os.O_RDONLY | os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
        os.symlink(p / 'f', p / 'link')
        with self.assertRaises(OSError): os.open(p / 'link', os.O_RDONLY | os.O_NOFOLLOW)
        lk = os.open(p / 'f', os.O_RDWR); fcntl.flock(lk, fcntl.LOCK_EX)
        r = subprocess.run([sys.executable, '-c', 'import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_RDWR)\n'
                            'try:\n fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); sys.exit(0)\nexcept BlockingIOError: sys.exit(7)', str(p / 'f')])
        self.assertEqual(r.returncode, 7, 'flock must exclude another process on this filesystem'); os.close(lk)

    def test_multi_chunk_fetch_is_byte_identical_under_reviewed_pins(self):
        r = self.run_tool('fetch'); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.arch(), PAYLOAD); self.assertEqual(self.committed()['offset'], len(PAYLOAD))
        self.assertEqual(len(Srv.requests), 6)
        self.assertTrue(all(q['If-Range'] == ETAG and q['Accept-Encoding'] == 'identity' for q in Srv.requests))
        self.assertEqual(Srv.requests[-1]['Range'], f'bytes={5 * CHUNK}-{len(PAYLOAD) - 1}')
        self.assertEqual(stat.S_IMODE(self.work.stat().st_mode), 0o700)
        for f in self.work.iterdir(): self.assertFalse(f.stat().st_mode & 0o022, f)
        self.assertTrue((self.work / 'fetch-complete.json').exists())

    def test_probe_records_identity_for_review_and_commits_nothing(self):
        r = self.run_tool('probe'); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        p = json.loads((self.work / 'probe.json').read_text())
        self.assertEqual((p['status'], p['contentRange'], p['etag'], p['lastModified']), (206, f'bytes 0-0/{len(PAYLOAD)}', ETAG, LM))
        self.assertEqual(Srv.requests, [{'Range': 'bytes=0-0', 'If-Range': None, 'Accept-Encoding': 'identity'}])
        self.assertFalse((self.work / 'state.tar.zst').exists()); self.assertFalse((self.work / 'committed.json').exists())
        Srv.reset(); Srv.mode = 'weak'
        self.assertEqual(self.run_tool('probe').returncode, 6)

    def test_pins_are_mandatory_and_must_match_the_server(self):
        self.assertEqual(self.run_tool('fetch', pins=False).returncode, 2); self.assertEqual(Srv.requests, [])
        r = self.run_tool('fetch', '--expect-etag', '"other"', '--expect-last-modified', LM, pins=False)
        self.assertEqual(r.returncode, 6, r.stdout); self.assertEqual(self.committed()['offset'], 0); self.assertEqual(self.arch(), b'')
        self.assertEqual(self.run_tool('fetch', '--expect-etag', 'W/"v1"', '--expect-last-modified', LM, pins=False).returncode, 2)

    def test_changed_pins_between_runs_never_splice(self):
        r = self.run_tool('fetch', env={'SRR3_TEST_KILL': 'after-pwrite', 'SRR3_TEST_KILL_AFTER': '1'}); self.assertEqual(r.returncode, -9)
        r = self.run_tool('fetch', '--expect-etag', '"v2"', '--expect-last-modified', LM, pins=False)
        self.assertEqual(r.returncode, 6, r.stdout); self.assertEqual(self.prefix(), CHUNK)

    def _kill_resume(self, point, after):
        r = self.run_tool('fetch', env={'SRR3_TEST_KILL': point, 'SRR3_TEST_KILL_AFTER': str(after)})
        self.assertEqual(r.returncode, -signal.SIGKILL, r.stdout + r.stderr)
        off = self.prefix()
        r2 = self.run_tool('fetch'); self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr); self.assertEqual(self.arch(), PAYLOAD)
        return off, r2

    def test_sigkill_mid_chunk(self):
        self.assertEqual(self._kill_resume('mid-chunk', 2)[0], 2 * CHUNK)

    def test_sigkill_after_pwrite_before_commit_truncates_own_tail(self):
        r = self.run_tool('fetch', env={'SRR3_TEST_KILL': 'after-pwrite', 'SRR3_TEST_KILL_AFTER': '3'}); self.assertEqual(r.returncode, -9)
        self.assertEqual(self.committed()['offset'], 3 * CHUNK); self.assertEqual(len(self.arch()), 4 * CHUNK)
        r2 = self.run_tool('fetch'); self.assertEqual(r2.returncode, 0, r2.stdout); self.assertIn('truncated-uncommitted-tail', r2.stdout)
        self.assertEqual(self.arch(), PAYLOAD)

    def test_sigkill_before_first_pwrite(self):
        self.assertEqual(self._kill_resume('before-pwrite', 0)[0], 0)

    def test_external_process_group_sigkill(self):
        Srv.sleep = 0.05
        p = subprocess.Popen(self.argv('fetch'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(600):
            if (self.work / 'committed.json').exists() and self.committed()['offset'] >= CHUNK: break
            time.sleep(0.05)
        os.killpg(p.pid, signal.SIGKILL); p.wait(timeout=30); self.prefix()
        Srv.sleep = 0.0
        r = self.run_tool('fetch'); self.assertEqual(r.returncode, 0, r.stdout); self.assertEqual(self.arch(), PAYLOAD)

    def test_sigterm_keeps_committed_progress(self):
        Srv.sleep = 0.05
        p = subprocess.Popen(self.argv('fetch'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(600):
            if (self.work / 'committed.json').exists() and self.committed()['offset'] >= CHUNK: break
            time.sleep(0.05)
        p.send_signal(signal.SIGTERM); out, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 143, out + err); self.assertGreaterEqual(self.prefix(), CHUNK)
        self.assertFalse((self.work / 'chunk.tmp').exists())
        Srv.sleep = 0.0
        self.assertEqual(self.run_tool('fetch').returncode, 0); self.assertEqual(self.arch(), PAYLOAD)

    def _refused(self, mode, after, text=None):
        Srv.mode, Srv.after = mode, after
        r = self.run_tool('fetch'); self.assertEqual(r.returncode, 6, mode + r.stdout + r.stderr)
        if text: self.assertIn(text, r.stdout)
        off = self.prefix(); self.assertEqual(off, after * CHUNK); self.assertEqual(len(self.arch()), off)
        self.assertFalse((self.work / 'chunk.tmp').exists())

    def test_200_first(self): self._refused('ignore-range', 0, '200 full')
    def test_200_on_resume(self): self._refused('ignore-range', 3, '200 full')
    def test_wrong_range_start(self): self._refused('wrong-start', 2, 'Content-Range')
    def test_wrong_total(self): self._refused('wrong-total', 2, 'total')
    def test_etag_change_if_range_200(self): self._refused('etag-ifrange', 2, '200 full')
    def test_etag_change_on_206(self): self._refused('etag-206', 2, 'reviewed pins')
    def test_last_modified_change(self): self._refused('lm', 2, 'reviewed pins')
    def test_weak_etag(self): self._refused('weak', 0, 'weak')
    def test_content_encoding(self): self._refused('gzip', 1, 'Content-Encoding')
    def test_redirect(self): self._refused('redirect', 0, 'redirect')
    def test_body_larger_than_range(self): self._refused('oversize', 2)
    def test_malformed_content_length(self): self._refused('badlen', 1)
    def test_duplicated_content_range(self): self._refused('dup', 1)

    def test_retries_truncated_stalled_503(self):
        for mode, times in (('cut', 2), ('stall', 1), ('503', 2)):
            shutil.rmtree(self.work, True); Srv.reset(); Srv.mode, Srv.times = mode, times
            r = self.run_tool('fetch'); self.assertEqual(r.returncode, 0, mode + r.stdout + r.stderr); self.assertEqual(self.arch(), PAYLOAD)

    def test_capacity_refused_before_any_request(self):
        r = self.run_tool('fetch', reserve=2 ** 62); self.assertEqual(r.returncode, 4, r.stdout); self.assertEqual(Srv.requests, [])

    def test_ownership_refusals(self):
        real = self.d / 'real'; real.mkdir(mode=0o700); self.work.symlink_to(real)
        self.assertEqual(self.run_tool('fetch').returncode, 3); self.work.unlink()
        self.work.mkdir(); self.work.chmod(0o750)
        self.assertEqual(self.run_tool('fetch').returncode, 3)
        self.work.chmod(0o700); (self.work / 'old.partial').write_bytes(b'someone else')
        self.assertEqual(self.run_tool('fetch').returncode, 3); self.assertEqual((self.work / 'old.partial').read_bytes(), b'someone else')
        (self.work / 'old.partial').unlink(); (self.work / 'state.tar.zst').symlink_to(self.d / 'elsewhere')
        self.assertEqual(self.run_tool('fetch').returncode, 3); self.assertFalse((self.d / 'elsewhere').exists())
        a = self.argv('fetch'); a[a.index('--owner-uid') + 1] = str(os.getuid() + 1)
        self.assertEqual(subprocess.run(a, capture_output=True).returncode, 2)
        self.assertEqual(Srv.requests, [])

    def test_lock_busy_archive_and_cwd(self):
        self.assertEqual(self.run_tool('fetch', env={'SRR3_TEST_KILL': 'after-pwrite', 'SRR3_TEST_KILL_AFTER': '1'}).returncode, -9)
        for code in ('import fcntl,sys,time; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); time.sleep(30)',
                     'import sys,time; f=open(sys.argv[1],"rb"); time.sleep(30)'):
            target = self.work / ('.lock' if 'flock' in code else 'state.tar.zst')
            p = subprocess.Popen([sys.executable, '-c', code, str(target)]); time.sleep(0.5)
            try: self.assertEqual(self.run_tool('fetch').returncode, 3)
            finally: p.kill(); p.wait()
        p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], cwd=str(self.work)); time.sleep(0.5)
        try: self.assertEqual(self.run_tool('fetch').returncode, 3)
        finally: p.kill(); p.wait()
        self.assertEqual(self.run_tool('fetch').returncode, 0); self.assertEqual(self.arch(), PAYLOAD)

    def test_inconsistent_local_state(self):
        self.work.mkdir(mode=0o700); self.work.chmod(0o700); (self.work / 'state.tar.zst').write_bytes(b'unknown')
        self.assertEqual(self.run_tool('fetch').returncode, 5); (self.work / 'state.tar.zst').unlink()
        self.assertEqual(self.run_tool('fetch', env={'SRR3_TEST_KILL': 'after-pwrite', 'SRR3_TEST_KILL_AFTER': '2'}).returncode, -9)
        with open(self.work / 'state.tar.zst', 'r+b') as f: f.truncate(CHUNK)
        self.assertEqual(self.run_tool('fetch').returncode, 5)
        (self.work / 'committed.json').write_text('{not json')
        self.assertEqual(self.run_tool('fetch').returncode, 5)

    def test_provenance_and_bounds(self):
        def rc(i_key, value):
            a = self.argv('fetch'); a[a.index(i_key) + 1] = value
            return subprocess.run(a, capture_output=True).returncode
        self.assertEqual(rc('--manifest-sha256', '0' * 64), 2)
        self.assertEqual(rc('--expect-url', self.url + 'x'), 2)
        self.assertEqual(rc('--expect-total', str(len(PAYLOAD) + 1)), 2)
        self.assertEqual(rc('--chunk-bytes', str(128 << 20)), 2)
        self.assertEqual(rc('--reserve-bytes', str(RESERVE - 1)), 2)
        a = self.argv('fetch'); a.remove('--allow-http-loopback')
        self.assertEqual(subprocess.run(a, capture_output=True).returncode, 2)
        self.assertEqual(Srv.requests, [])

    def test_curlrc_and_proxy_environment_ignored(self):
        (self.d / '.curlrc').write_text('proxy = "http://127.0.0.1:9"\nlocation\n')         # a hostile config and proxy env
        r = self.run_tool('fetch', env={'CURL_HOME': str(self.d), 'http_proxy': 'http://127.0.0.1:9', 'ALL_PROXY': 'http://127.0.0.1:9'})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertEqual(self.arch(), PAYLOAD)


if __name__ == '__main__':
    unittest.main(verbosity=2)
