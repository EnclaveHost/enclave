import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import interruption_watchdog as w


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.op = 'recovery-20261028-r1'
        self.wd = self.root / 'watch'; self.wd.mkdir()
        self.opdir = self.root / self.op; self.opdir.mkdir()
        self.baseline = {'pid': 123, 'startTicks': '456', 'sources': w.PINS}
        self.owned = w.g.gate_route(self.op)
        self.state = {'op': self.op, 'owned': self.owned, 'phase': 'gate-verified'}

    def tearDown(self):
        self.temp.cleanup()

    def test_activation_marker_preserves_gate_without_network(self):
        (self.wd / 'activation-started.json').write_text('{}')
        with patch.object(w, 'relay_identity') as identity, patch.object(w.g, 'api') as api:
            result = w.recover(self.op, self.baseline, self.wd)
        self.assertEqual(result['outcome'], 'manual-review')
        identity.assert_not_called(); api.assert_not_called()

    def test_changed_relay_preserves_gate(self):
        with patch.object(w, 'relay_identity', return_value={**self.baseline, 'pid': 124}), \
                patch.object(w.g, 'api') as api:
            result = w.recover(self.op, self.baseline, self.wd)
        self.assertEqual(result['outcome'], 'manual-review'); api.assert_not_called()

    def test_missing_gate_operation_is_noop(self):
        with patch.object(w, 'relay_identity', return_value=self.baseline), \
                patch.object(w.g, 'BACKUPS', self.root / 'missing'), patch.object(w.g, 'api') as api:
            result = w.recover(self.op, self.baseline, self.wd)
        self.assertEqual(result['outcome'], 'no-operation'); api.assert_not_called()

    def run_recovery(self, routes, mutate):
        with patch.object(w, 'relay_identity', return_value=self.baseline), \
                patch.object(w.g, 'BACKUPS', self.root), patch.object(w.g, 'secure_dir'), \
                patch.object(w.g, 'load', return_value=self.state), \
                patch.object(w.g, 'read_routes', return_value=(routes, 'fresh-etag')), \
                patch.object(w.g, 'mutate', side_effect=mutate) as mutation:
            result = w.recover(self.op, self.baseline, self.wd)
        return result, mutation

    def test_absent_owned_route_never_resends(self):
        result, mutation = self.run_recovery([{'@id': 'other'}], lambda *a: None)
        self.assertEqual(result['outcome'], 'gate-absent'); mutation.assert_not_called()

    def test_exact_owned_restore_preserves_concurrent_route(self):
        other = {'@id': 'new-independent-route'}
        def applied(method, routes, etag, state, path, phase):
            self.assertEqual((method, routes, etag, phase), ('PATCH', [other], 'fresh-etag', 'restore'))
            state['afterHash'] = w.g.digest(routes)
        result, mutation = self.run_recovery([other, self.owned], applied)
        self.assertEqual(result['outcome'], 'owned-gate-restored'); self.assertEqual(mutation.call_count, 1)

    def test_unknown_restore_has_no_retry(self):
        calls = []
        def failed(*args):
            calls.append(args); raise TimeoutError('unknown')
        with self.assertRaises(TimeoutError):
            self.run_recovery([self.owned], failed)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
