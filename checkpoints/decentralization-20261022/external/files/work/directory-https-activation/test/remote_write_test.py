#!/usr/bin/env python3
"""remote.py write path with injected short writes and failures (temp dirs only; no host, no Caddy).
   python3 test/remote_write_test.py   (run under test/guarded.sh 256)"""
import errno, hashlib, json, os, shutil, tempfile, types, unittest
from pathlib import Path

SRC = (Path(__file__).resolve().parent.parent / 'activation' / 'remote.py').read_text()
sha = lambda b: hashlib.sha256(b).hexdigest()


class OsProxy(types.SimpleNamespace):
    """The real os module, except write(), which tests replace."""
    def __getattr__(self, name):
        return getattr(os, name)


class WritePath(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp(prefix='dha-write-'))
        self.cf = self.t / 'Caddyfile'
        self.old = b'old config\n' * 1000
        self.new = os.urandom(200000)
        self.cf.write_bytes(self.old)
        params = {'mode': 'status', 'ip': '134.199.235.187', 'base_sha256': sha(self.old), 'result_sha256': sha(self.new), 'caddyfile': str(self.cf), 'run_id': 't'}
        self.ns = {'PARAMS': json.dumps(params), 'NO_MAIN': True, '__name__': 'remote_under_test'}
        exec(compile(SRC, 'remote.py', 'exec'), self.ns)
        self.proxy = OsProxy(); self.ns['os'] = self.proxy

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def leftovers(self):
        return [p.name for p in self.t.iterdir() if p.name.startswith('.')]

    def test_short_writes_are_completed_exactly(self):
        calls = []
        def short(fd, data):  # never more than 777 bytes per call
            calls.append(len(data)); return os.write(fd, bytes(data[:777]))
        self.proxy.write = short
        self.ns['swap'](sha(self.old), self.new)
        self.assertEqual(self.cf.read_bytes(), self.new); self.assertGreater(len(calls), 200); self.assertEqual(self.leftovers(), [])

    def test_write_failure_midway_never_replaces_the_target(self):
        n = [0]
        def failing(fd, data):
            n[0] += 1
            if n[0] > 3: raise OSError(errno.ENOSPC, 'No space left on device')
            return os.write(fd, bytes(data[:1000]))
        self.proxy.write = failing
        with self.assertRaises(OSError): self.ns['swap'](sha(self.old), self.new)
        self.assertEqual(self.cf.read_bytes(), self.old); self.assertEqual(self.leftovers(), [], 'temp file removed')

    def test_lying_write_is_caught_by_readback_digest(self):
        def lying(fd, data):  # claims everything, writes only half
            os.write(fd, bytes(data[:len(data) // 2])); return len(data)
        self.proxy.write = lying
        with self.assertRaises(OSError) as e: self.ns['swap'](sha(self.old), self.new)
        self.assertIn('exact bytes', str(e.exception)); self.assertEqual(self.cf.read_bytes(), self.old); self.assertEqual(self.leftovers(), [])

    def test_zero_progress_write_fails_cleanly(self):
        self.proxy.write = lambda fd, data: 0
        with self.assertRaises(OSError): self.ns['swap'](sha(self.old), self.new)
        self.assertEqual(self.cf.read_bytes(), self.old); self.assertEqual(self.leftovers(), [])

    def test_compare_and_swap_refuses_unexpected_target(self):
        other = b'someone else\n'; self.cf.write_bytes(other)
        with self.assertRaises(self.ns['Drift']): self.ns['swap'](sha(self.old), self.new)
        self.assertEqual(self.cf.read_bytes(), other); self.assertEqual(self.leftovers(), [])

    def test_write_new_refuses_an_existing_file(self):
        dst = self.t / 'backup'; dst.write_bytes(b'existing')
        with self.assertRaises(self.ns['Drift']): self.ns['write_new'](self.old, dst)
        self.assertEqual(dst.read_bytes(), b'existing')
        fresh = self.t / 'prepared'; self.ns['write_new'](self.new, fresh); self.assertEqual(fresh.read_bytes(), self.new)

    def test_peer_lock_is_created_held_and_never_unlinked(self):
        root = self.t / 'enclave-site'; root.mkdir(); lock = root / '.site-release.lock'
        f = self.ns['locked'](str(lock))
        self.assertTrue(lock.exists())
        import fcntl
        with open(lock) as g:
            with self.assertRaises(BlockingIOError): fcntl.flock(g, fcntl.LOCK_EX | fcntl.LOCK_NB)
        f.close(); self.assertTrue(lock.exists(), 'never unlinked')
        with self.assertRaises(FileNotFoundError): self.ns['locked'](str(self.t / 'missing-root' / '.site-release.lock'))
        os.symlink(self.t / 'elsewhere', root / 'link.lock')
        with self.assertRaises(OSError): self.ns['locked'](str(root / 'link.lock'))
        self.assertFalse((self.t / 'elsewhere').exists(), 'no symlink followed')

    if os.environ.get('INJECT_FAILURE'):
        def test_injected_failure(self):
            self.fail('injected (negative control)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
