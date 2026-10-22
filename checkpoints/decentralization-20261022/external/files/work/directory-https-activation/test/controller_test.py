#!/usr/bin/env python3
"""activate.py controller outcomes with a fake ssh/readback (no network, no host, nothing applied).
   python3 test/controller_test.py   (run under test/guarded.sh 256)"""
import json, os, re, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

CAND = Path(__file__).resolve().parent.parent
ACT = CAND / 'activation' / 'activate.py'
FAKE = Path(__file__).resolve().parent / 'fake'
ACTIVE = {'state': 'active', 'reloaded': True}
ROLLED = {'state': 'rolled-back', 'verified': True, 'file': 'b', 'running': False}


class Controller(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp(prefix='dha-ctl-'))
        self.env = {**os.environ, 'DHA_SSH': json.dumps([sys.executable, str(FAKE / 'fake_ssh.py')]),
                    'DHA_READBACK': json.dumps([sys.executable, str(FAKE / 'fake_readback.py')]), 'DHA_JOURNAL': str(self.t / 'journal.jsonl'),
                    'DHA_REMOTE_TIMEOUT': '2', 'DHA_READBACK_TIMEOUT': '2', 'FAKE_QUEUE': str(self.t / 'q.json'), 'FAKE_CALLS': str(self.t / 'calls'),
                    'FAKE_RB_QUEUE': str(self.t / 'rb.json'), 'FAKE_RB_CALLS': str(self.t / 'rbcalls')}
        plan = subprocess.run([sys.executable, str(ACT), 'plan'], capture_output=True, text=True, env=self.env, check=True).stdout
        self.digest = re.search(r'manifest sha256 ([0-9a-f]{64})', plan).group(1)

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def run_act(self, mode, queue, rb=(), extra=(), approve=None):
        (self.t / 'q.json').write_text(json.dumps(list(queue))); (self.t / 'rb.json').write_text(json.dumps(list(rb)))
        r = subprocess.run([sys.executable, str(ACT), mode, '--hosts', 'us-west', '--approve', approve or self.digest, *extra],
                           capture_output=True, text=True, env=self.env, timeout=60)
        return r

    def journal(self):
        p = self.t / 'journal.jsonl'
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def calls(self, name='calls'):
        p = self.t / name
        return [json.loads(l)['mode' if name == 'calls' else 'expect'] for l in p.read_text().splitlines()] if p.exists() else []

    def test_happy_apply_is_verified_active(self):
        r = self.run_act('apply', [{'mode': 'apply', 'stdout': ACTIVE}], [{'ok': True}])
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(self.journal()[-1]['event'], 'verified-active'); self.assertEqual(self.calls('rbcalls'), ['active'])

    def test_wrong_approval_contacts_nothing(self):
        r = self.run_act('apply', [], approve='0' * 64)
        self.assertNotEqual(r.returncode, 0); self.assertEqual(self.calls(), [])

    def test_lost_response_is_unknown_then_blocks_until_reconcile(self):
        r = self.run_act('apply', [{'mode': 'apply', 'sleep': 5, 'stdout': ACTIVE}])
        self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1]['event'], 'unknown'); self.assertIn('timeout', self.journal()[-1]['detail'])
        r = self.run_act('apply', [])
        self.assertEqual(r.returncode, 1); self.assertIn('refused-local', r.stdout); self.assertEqual(self.calls(), ['apply'], 'nothing sent without --reconcile')
        r = self.run_act('apply', [{'mode': 'status', 'stdout': {'state': 'status', 'isResult': True}}, {'mode': 'apply', 'stdout': ACTIVE}], [{'ok': True}], ['--reconcile'])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertEqual(self.calls(), ['apply', 'status', 'apply']); self.assertEqual(self.journal()[-1]['event'], 'verified-active')

    def test_unparsable_answer_is_unknown(self):
        r = self.run_act('apply', [{'mode': 'apply', 'stdout': 'Traceback (most recent call last)\n', 'rc': 1}])
        self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1]['event'], 'unknown')

    def test_public_readback_timeout_rolls_back_this_host_and_verifies(self):
        r = self.run_act('apply', [{'mode': 'apply', 'stdout': ACTIVE}, {'mode': 'rollback', 'stdout': ROLLED}], [{'sleep': 5}, {'ok': True}])
        self.assertEqual(r.returncode, 1)
        ev = [e['event'] for e in self.journal()]
        self.assertIn('public-readback-unknown', ev); self.assertEqual(ev[-1], 'rolled-back-verified')
        self.assertEqual(self.calls(), ['apply', 'rollback']); self.assertEqual(self.calls('rbcalls'), ['active', 'inactive'])
        self.assertIn('"rollback": "rolled-back-verified"', r.stdout)

    def test_unverified_rollback_is_recorded_unknown_not_restored(self):
        r = self.run_act('apply', [{'mode': 'apply', 'stdout': ACTIVE}, {'mode': 'rollback', 'stdout': {'state': 'rollback-unverified', 'running': True}, 'rc': 1}], [{'ok': False}])
        self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1]['event'], 'unknown'); self.assertIn('"rollback": "unknown"', r.stdout)

    def test_rollback_whose_public_view_disagrees_is_unknown(self):
        r = self.run_act('apply', [{'mode': 'apply', 'stdout': ACTIVE}, {'mode': 'rollback', 'stdout': ROLLED}], [{'ok': False}, {'ok': False}])
        self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1]['event'], 'unknown')

    def test_rollback_refused_drift_is_recorded_and_blocks(self):
        r = self.run_act('apply', [{'mode': 'apply', 'stdout': {'state': 'rollback-refused-drift', 'file': 'x'}, 'rc': 1}])
        self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1]['event'], 'rollback-refused-drift')
        r = self.run_act('apply', []); self.assertEqual(r.returncode, 1); self.assertIn('refused-local', r.stdout); self.assertEqual(self.calls(), ['apply'])

    def test_refused_by_host_stops_rollout(self):
        r = self.run_act('apply', [{'mode': 'apply', 'stdout': {'state': 'refused', 'error': 'drifted'}, 'rc': 1}])
        self.assertEqual(r.returncode, 1); self.assertEqual(self.journal()[-1]['event'], 'refused'); self.assertEqual(self.calls('rbcalls'), [])

    def test_operator_rollback_verified(self):
        r = self.run_act('rollback', [{'mode': 'rollback', 'stdout': ROLLED}], [{'ok': True}])
        self.assertEqual(r.returncode, 0, r.stdout); self.assertEqual(self.journal()[-1]['event'], 'rolled-back-verified'); self.assertEqual(self.calls('rbcalls'), ['inactive'])

    if os.environ.get('INJECT_FAILURE'):
        def test_injected_failure(self):
            self.fail('injected (negative control)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
