import copy
import unittest
from unittest.mock import patch
import session_gate as g


class GateTests(unittest.TestCase):
    def setUp(self):
        self.route = g.gate_route('recovery-20261028-r1')
        self.base = [{'match': [{'host': ['api.enclave.host']}],
                      'handle': [{'handler': 'reverse_proxy', 'upstreams': [{'dial': '127.0.0.1:8100'}]}]}]

    def test_only_known_aliases_and_sessions_prefix(self):
        m = self.route['match'][0]
        self.assertEqual(m['host'], g.HOSTS)
        self.assertNotIn('*.app.enclave.host', m['host'])
        self.assertEqual(m['path'], ['/v1/sessions', '/v1/sessions/*'])
        self.assertEqual(m['not'], [{'method': ['GET', 'HEAD', 'OPTIONS']}])

    def test_precondition_both_required(self):
        g.check_precondition(self.base, 'etag1', g.digest(self.base), 'etag1')
        for digest, etag in [('wrong', 'etag1'), (g.digest(self.base), 'wrong'), (None, None)]:
            with self.assertRaises(RuntimeError):
                g.check_precondition(self.base, 'etag1', digest, etag)

    def test_owned_rollback_preserves_other_changes(self):
        other = {'@id': 'unrelated-new-route', 'handle': []}
        live = [other, self.route] + self.base
        before = copy.deepcopy(live)
        self.assertEqual(g.remove_owned(live, self.route), [other] + self.base)
        self.assertEqual(live, before)

    def test_rollback_refuses_missing_duplicate_or_altered_gate(self):
        altered = {**self.route, 'terminal': False}
        for live in [self.base, [self.route, self.route] + self.base, [altered] + self.base]:
            with self.assertRaises(RuntimeError):
                g.remove_owned(live, self.route)

    def test_path_traversal_and_invalid_operation_refused(self):
        for op in ['../escape', '', 'A-long-operation', 'a'*81, 'short']:
            with self.assertRaises(ValueError):
                g.gate_route(op)

    def test_unknown_is_durable_before_network_and_not_retried(self):
        events = []
        state = {'phase': 'prepared'}
        def saved(path, value): events.append(('save', value['phase']))
        def network(*args):
            events.append(('network', args[0]))
            raise TimeoutError('unknown outcome')
        with patch.object(g, 'save', saved), patch.object(g, 'api', network):
            with self.assertRaises(TimeoutError):
                g.mutate('PATCH', self.base, 'etag', state, '/unused', 'gate')
        self.assertEqual(events, [('save', 'gate-unknown'), ('network', 'PATCH')])
        self.assertEqual(state['phase'], 'gate-unknown')

    def test_failed_postcheck_preserves_unknown(self):
        state = {'phase': 'prepared'}
        with patch.object(g, 'save'), patch.object(g, 'api', return_value=(None, None)), \
                patch.object(g, 'read_routes', return_value=([], 'new-etag')):
            with self.assertRaises(RuntimeError):
                g.mutate('PATCH', self.base, 'etag', state, '/unused', 'gate')
        self.assertEqual(state['phase'], 'gate-unknown')

    def test_verified_mutation_records_result(self):
        state = {'phase': 'prepared'}
        phases = []
        with patch.object(g, 'save', side_effect=lambda p, s: phases.append(s['phase'])), \
                patch.object(g, 'api', return_value=(None, None)) as api, \
                patch.object(g, 'read_routes', return_value=(self.base, 'new-etag')):
            g.mutate('PATCH', self.base, 'etag', state, '/unused', 'restore')
        api.assert_called_once_with('PATCH', g.ROUTES, self.base, 'etag')
        self.assertEqual(phases, ['restore-unknown', 'restore-verified'])


if __name__ == '__main__':
    unittest.main()
