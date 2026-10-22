#!/usr/bin/env python3
"""activate-runtime.py outcomes with a fake ssh/readback (no network, no host).   python3 test/controller_test.py"""
import json, os, re, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

CAND = Path(__file__).resolve().parent.parent
ACT, FAKE = CAND / 'activation' / 'activate-runtime.py', Path(__file__).resolve().parent / 'fake'
ACTIVE = {'state': 'active', 'restarted': True}


class Controller(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp(prefix='dhr-ctl-'))
        self.env = {**os.environ, 'DHR_SSH': json.dumps([sys.executable, str(FAKE / 'fake_ssh.py')]), 'DHR_READBACK': json.dumps([sys.executable, str(FAKE / 'fake_readback.py')]),
                    'DHR_JOURNAL': str(self.t / 'j.jsonl'), 'DHR_REMOTE_TIMEOUT': '2', 'DHR_READBACK_TIMEOUT': '2', 'FAKE_QUEUE': str(self.t / 'q'), 'FAKE_CALLS': str(self.t / 'c'),
                    'FAKE_RB_QUEUE': str(self.t / 'rq'), 'FAKE_RB_CALLS': str(self.t / 'rc')}
        plan = subprocess.run([sys.executable, str(ACT), 'plan'], capture_output=True, text=True, env=self.env, check=True).stdout
        self.digest = re.search(r'manifest sha256 ([0-9a-f]{64})', plan).group(1)

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def act(self, mode, queue, rb=(), extra=(), hosts='us-west', approve=None):
        (self.t / 'q').write_text(json.dumps(list(queue))); (self.t / 'rq').write_text(json.dumps(list(rb)))
        return subprocess.run([sys.executable, str(ACT), mode, '--hosts', hosts, '--approve', approve or self.digest, *extra], capture_output=True, text=True, env=self.env, timeout=60)

    def journal(self):
        p = self.t / 'j.jsonl'; return [json.loads(l)['event'] for l in p.read_text().splitlines()] if p.exists() else []

    def calls(self, n='c'):
        p = self.t / n; return [json.loads(l)['mode' if n == 'c' else 'expect'] for l in p.read_text().splitlines()] if p.exists() else []

    def test_happy(self):
        r = self.act('apply', [{'mode': 'apply', 'stdout': ACTIVE}], [{'ok': True}])
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(self.journal()[-1], 'verified-active'); self.assertEqual(self.calls('rc'), ['new'])

    def test_one_host_only_and_approval(self):
        r = self.act('apply', [], hosts='us-west,eu-central'); self.assertNotEqual(r.returncode, 0); self.assertIn('exactly one host', r.stderr)
        r = self.act('apply', [], approve='0' * 64); self.assertNotEqual(r.returncode, 0); self.assertEqual(self.calls(), [])

    def test_lost_response_unknown_then_reconcile(self):
        r = self.act('apply', [{'mode': 'apply', 'sleep': 5, 'stdout': ACTIVE}])
        self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1], 'unknown')
        r = self.act('apply', []); self.assertEqual(r.returncode, 1); self.assertIn('refused-local', r.stdout); self.assertEqual(self.calls(), ['apply'])
        r = self.act('apply', [{'mode': 'status', 'stdout': {'state': 'status', 'isNew': True}}, {'mode': 'apply', 'stdout': {**ACTIVE, 'restarted': False}}], [{'ok': True}], ['--reconcile'])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertEqual(self.calls(), ['apply', 'status', 'apply'])

    def test_unparsable_unknown(self):
        r = self.act('apply', [{'mode': 'apply', 'stdout': 'Traceback\n', 'rc': 1}]); self.assertEqual(self.journal()[-1], 'unknown'); self.assertEqual(r.returncode, 1)

    def test_public_disagrees_unknown(self):
        r = self.act('apply', [{'mode': 'apply', 'stdout': ACTIVE}], [{'ok': False}]); self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1], 'unknown')

    def test_public_timeout_unknown(self):
        r = self.act('apply', [{'mode': 'apply', 'stdout': ACTIVE}], [{'sleep': 5}]); self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1], 'unknown')

    def test_rollback_unverified_is_unknown_not_restored(self):
        r = self.act('apply', [{'mode': 'apply', 'stdout': {'state': 'rollback-unverified', 'error': 'x'}, 'rc': 1}])
        self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1], 'unknown'); self.assertNotIn('rolled-back-verified', r.stdout)

    def test_automatic_rollback_verified_reports_failure(self):
        r = self.act('apply', [{'mode': 'apply', 'stdout': {'state': 'rolled-back', 'verified': True, 'error': 'routes'}, 'rc': 1}], [{'ok': True}])
        self.assertEqual(r.returncode, 1, 'apply did not succeed'); self.assertEqual(self.journal()[-1], 'rolled-back-verified'); self.assertEqual(self.calls('rc'), ['old'])

    def test_drift_blocks(self):
        self.act('apply', [{'mode': 'apply', 'stdout': {'state': 'rollback-refused-drift'}, 'rc': 1}])
        self.assertEqual(self.journal()[-1], 'rollback-refused-drift')
        r = self.act('rollback', []); self.assertIn('refused-local', r.stdout); self.assertEqual(self.calls(), ['apply'])

    def test_operator_rollback(self):
        r = self.act('rollback', [{'mode': 'rollback', 'stdout': {'state': 'rolled-back', 'verified': True}}], [{'ok': True}])
        self.assertEqual(r.returncode, 0); self.assertEqual(self.journal()[-1], 'rolled-back-verified')

    if os.environ.get('INJECT_FAILURE'):
        def test_injected(self):
            self.fail('injected (negative control)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
