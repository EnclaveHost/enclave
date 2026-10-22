"""Public readback and failure routing; host filesystem/Caddy tests are separate."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import activate


class Controller(unittest.TestCase):
    def test_review_manifest_binds_sources_and_exact_four_configs(self):
        doc, digest, raw = activate.manifest()
        self.assertEqual(activate.sha(raw.encode()), digest)
        self.assertEqual(set(doc['hosts']), set(activate.engine.IPS))
        self.assertFalse(doc['policyActivated'])
        self.assertIn('/etc/enclave-bootstrap-tls/directory-https.lock', doc['hostParams']['peer_locks'])

    def test_composed_remote_disables_old_entrypoint(self):
        remote = activate.engine.REMOTE
        self.assertTrue(remote.startswith('NO_MAIN = True\n'))
        self.assertIn("LOCK = CF.with_name('platform-policy.lock')", remote)
        self.assertEqual(remote.count('def prepare_public_readiness():'), 1)
        self.assertTrue(remote.rstrip().endswith('main()'))

    def test_verified_public_readback_and_refusals(self):
        def fixture(ip, method, path, headers=None):
            if path == '/v1/network/records':
                return 200, {}, b'{"version":1,"providers":[]}'
            if path == '/platform-policy/ready.json':
                if method == 'GET':
                    return 200, {'access-control-allow-origin': '*'}, activate.READY
                if method == 'HEAD':
                    return 200, {}, b''
            return 404, {}, b''
        with patch.object(activate, 'request', fixture):
            self.assertTrue(activate.public_readback('us-west', 'active')['ok'])
            self.assertFalse(activate.public_readback('us-west', 'inactive')['ok'])
        for answer in [(200, {}, activate.READY), (200, {'access-control-allow-origin': '*', 'set-cookie': 'bad'}, activate.READY),
                       (200, {'access-control-allow-origin': '*'}, b'{"policyActivated":true}')]:
            with self.subTest(answer=answer), patch.object(activate, 'request', return_value=answer):
                self.assertFalse(activate.public_readback('us-west', 'active')['ok'])
        with patch.object(activate, 'request', side_effect=TimeoutError('fixture')):
            result = activate.public_readback('us-west', 'active')
            self.assertFalse(result['ok'])
            self.assertEqual(result['state'], 'unknown')

    def test_public_failure_rolls_back_once_and_unknown_blocks_retry(self):
        engine = activate.engine
        with tempfile.TemporaryDirectory() as tmp, patch.object(engine, 'JOURNAL', Path(tmp) / 'journal'):
            remote = [( {'state': 'active'}, 'rc 0'), ({'state': 'rolled-back'}, 'rc 0')]
            public = [{'ok': False, 'state': 'answered'}, {'ok': True}]
            with patch.object(engine, 'remote', side_effect=remote) as calls, patch.object(engine, 'public_readback', side_effect=public):
                ok, answer = engine.run_host('us-west', 'apply', {}, 'digest', 'fixture', False)
                self.assertFalse(ok)
                self.assertEqual(answer['rollback'], 'rolled-back-verified')
                self.assertEqual([call.args[1] for call in calls.call_args_list], ['apply', 'rollback'])
            with patch.object(engine, 'remote', return_value=(None, 'SSH reply lost')) as calls:
                self.assertFalse(engine.run_host('us-west', 'apply', {}, 'digest', 'lost', False)[0])
                self.assertEqual(calls.call_count, 1)
                ok, answer = engine.run_host('us-west', 'apply', {}, 'digest', 'retry', False)
                self.assertFalse(ok)
                self.assertEqual(answer['outcome'], 'refused-local')
                self.assertEqual(calls.call_count, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
