"""Exercise the actual activation engine and mirror overrides against temporary files."""
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent / 'directory-https-activation/activation/remote.py'
sha = lambda data: hashlib.sha256(data).hexdigest()


class Activation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cf = self.root / 'Caddyfile'
        self.before, self.after = b'baseline\n', b'with policy mirror\n'
        self.cf.write_bytes(self.before)
        params = {'caddyfile': str(self.cf), 'ip': '127.0.0.1', 'base_sha256': sha(self.before),
                  'result_sha256': sha(self.after), 'result_b64': base64.b64encode(self.after).decode(),
                  'run_id': 'fixture', 'policy_root': str(self.root / 'public'), 'verify_attempts': 1}
        self.ns = {'PARAMS': json.dumps(params), 'NO_MAIN': True, 'TEST_OVERRIDES': True}
        exec(compile(ENGINE.read_text(), str(ENGINE), 'exec'), self.ns)
        src = HERE / 'remote_overrides.py'
        exec(compile(src.read_text(), str(src), 'exec'), self.ns)
        self.running = False
        self.reloads = []
        self.fail_reload = False
        self.fail_readback = False
        self.ns['validate'] = lambda _path: None  # Actual Caddy validation is covered by test_routes.py.
        self.ns['running_has_route'] = lambda: self.running
        self.ns['legacy_probe'] = lambda: {p: {'status': 200, 'directoryShaped': False} for p in self.ns['LEGACY']}
        def reload_if(expected):
            self.assertEqual(sha(self.cf.read_bytes()), expected)
            self.reloads.append(expected)
            if self.fail_reload:
                self.fail_reload = False
                return 1, 'injected reload failure'
            self.running = expected == sha(self.after)
            return 0, ''
        self.ns['reload_if'] = reload_if
        def https(method, path, headers=None, body=None):
            if path == '/platform-policy/ready.json' and method == 'GET':
                return (503, {}, b'') if self.fail_readback else (200, {'access-control-allow-origin': '*'}, self.ns['READY'])
            if path == '/v1/network/records':
                return 200, {}, b'{"version":1,"providers":[]}'
            return 404, {}, b''
        self.ns['https'] = https
        self.ns['direct'] = lambda _path: (200, b'{"version":1,"providers":[]}')

    def test_install_idempotence_and_explicit_rollback(self):
        result = self.ns['apply']()
        self.assertEqual(result['state'], 'active')
        self.assertEqual(self.cf.read_bytes(), self.after)
        self.assertEqual(self.ns['BACKUP'].read_bytes(), self.before)
        self.assertEqual((self.root / 'public/ready.json').read_bytes(), self.ns['READY'])
        self.assertFalse(result['evidence']['policyActivated'])
        self.assertEqual(self.ns['apply']()['state'], 'active')
        self.assertEqual(len(self.reloads), 1)
        self.assertEqual(self.ns['do_rollback']()['state'], 'rolled-back')
        self.assertEqual(self.cf.read_bytes(), self.before)

    def test_reload_failure_restores_exact_baseline(self):
        self.fail_reload = True
        result = self.ns['apply']()
        self.assertEqual(result['state'], 'rolled-back')
        self.assertEqual(self.cf.read_bytes(), self.before)
        self.assertFalse(self.running)

    def test_public_files_remain_readable_with_restrictive_umask(self):
        old = os.umask(0o077)
        try:
            self.assertEqual(self.ns['apply']()['state'], 'active')
        finally:
            os.umask(old)
        public = self.root / 'public'
        self.assertEqual(public.stat().st_mode & 0o777, 0o755)
        self.assertEqual((public / 'ready.json').stat().st_mode & 0o777, 0o644)

    def test_readback_failure_restores_exact_baseline(self):
        self.fail_readback = True
        self.assertEqual(self.ns['apply']()['state'], 'rolled-back')
        self.assertEqual(self.cf.read_bytes(), self.before)

    def test_unrelated_drift_is_never_overwritten(self):
        self.cf.write_bytes(b'another writer\n')
        self.assertEqual(self.ns['apply']()['state'], 'refused')
        self.assertEqual(self.cf.read_bytes(), b'another writer\n')
        self.assertFalse((self.root / 'public').exists())
        self.assertEqual(self.reloads, [])

    def test_existing_different_or_symlink_readiness_is_refused(self):
        public = self.root / 'public'
        public.mkdir()
        ready = public / 'ready.json'
        ready.write_bytes(b'other public content')
        with self.assertRaisesRegex(RuntimeError, 'different existing readiness'):
            self.ns['apply']()
        self.assertEqual(ready.read_bytes(), b'other public content')
        ready.unlink()
        ready.symlink_to(self.cf)
        with self.assertRaises(OSError):
            self.ns['apply']()
        self.assertEqual(self.cf.read_bytes(), self.before)
        self.assertEqual(self.reloads, [])

    def test_writable_public_directory_is_refused(self):
        public = self.root / 'public'
        public.mkdir()
        public.chmod(0o777)
        with self.assertRaisesRegex(RuntimeError, 'protected directory'):
            self.ns['apply']()
        self.assertEqual(self.reloads, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
