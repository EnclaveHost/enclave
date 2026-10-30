import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import observe


class DescriptorObserverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='descriptor-fixture-')
        self.path = Path(self.temp.name) / 'owned-file'
        self.path.write_bytes(b'never read the contents')
        self.ro = os.open(self.path, os.O_RDONLY)
        self.rw = os.open(self.path, os.O_RDWR)
        s = self.path.stat()
        self.target = (s.st_dev, s.st_ino)

    def tearDown(self):
        os.close(self.ro)
        os.close(self.rw)
        self.temp.cleanup()

    def own_scope(self):
        original = os.listdir
        def listing(fd):
            if isinstance(fd, int) and os.readlink('/proc/self/fd/' + str(fd)) == '/proc':
                return [str(os.getpid())]
            return original(fd)
        return mock.patch.object(os, 'listdir', side_effect=listing)

    def test_actual_owned_descriptor_modes_with_explicit_single_pid_scope(self):
        with self.own_scope():
            result = observe.scan({self.target}, 'a' * 32, require_root=False)
        own = {m['fd']: m for m in result['matches'] if m['pid'] == os.getpid()}
        self.assertEqual(own[self.ro]['accessMode'], os.O_RDONLY)
        self.assertEqual(own[self.rw]['accessMode'], os.O_RDWR)
        self.assertGreater(own[self.ro]['startTicks'], 0)
        self.assertNotIn('never read the contents', json.dumps(result))
        self.assertEqual(result['complete'], not result['errors'])

    def test_cli_requires_host_root_no_fake_success(self):
        self.assertNotEqual(os.geteuid(), 0, 'fixture is deliberately unprivileged')
        r = subprocess.run([sys.executable, '-I', str(Path(observe.__file__).resolve()),
                            '--target', ':'.join(map(str,self.target)), '--nonce', 'b'*32],
                           capture_output=True, timeout=5)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(json.loads(r.stdout)['refusal'], 'host_root_required')

    def test_missing_matching_descriptor_flags_is_incomplete(self):
        original = observe.read_at
        def altered(parent, name, limit):
            if name == 'fdinfo/' + str(self.ro):
                return b''
            return original(parent, name, limit)
        with self.own_scope(), mock.patch.object(observe, 'read_at', side_effect=altered):
            result = observe.scan({self.target}, 'c'*32, require_root=False)
        self.assertFalse(result['complete'])
        self.assertTrue(any(x.get('pid') == os.getpid() and x.get('phase') == 'descriptor' for x in result['errors']))

    def test_full_host_unprivileged_visibility_diagnostic(self):
        result = observe.scan({self.target}, 'f'*32, require_root=False)
        summary = {k:result.get(k) for k in ('complete','enumerated','processes','descriptors','exited','elapsedSeconds')}
        summary['errors'] = len(result['errors'])
        summary['errorKinds'] = sorted(set(x['kind'] for x in result['errors']))
        summary['scanIncomplete'] = any(x.get('phase') == 'scan' for x in result['errors'])
        Path('visibility-diagnostic.json').write_text(json.dumps(summary,indent=2)+'\n')
        self.assertEqual(result['complete'], not result['errors'])
        self.assertFalse(result['complete'], 'unprivileged host-wide visibility is intentionally NOT qualified')

    def test_deadline_never_reports_complete(self):
        with mock.patch.object(observe, 'MAX_SECONDS', -1):
            result = observe.scan({self.target}, 'd'*32, require_root=False)
        self.assertFalse(result['complete'])
        self.assertTrue(result['errors'])

    def test_cli_rejects_paths_duplicates_and_too_many_targets(self):
        target = ':'.join(map(str,self.target))
        variants = [['--target', '/etc/passwd'], ['--target', target, '--target', target],
                    sum((['--target', f'1:{i+1}'] for i in range(4)), [])]
        for options in variants:
            r = subprocess.run([sys.executable, '-I', str(Path(observe.__file__).resolve()),
                                '--nonce', 'e'*32, *options], capture_output=True, timeout=5)
            self.assertEqual(r.returncode, 2)
            self.assertEqual(r.stdout, b'')


if __name__ == '__main__':
    unittest.main(verbosity=2)
