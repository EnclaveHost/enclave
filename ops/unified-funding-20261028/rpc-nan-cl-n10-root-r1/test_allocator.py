"""Source-only fixtures. Root must run within separately admitted local limits."""
import ast
import copy
import json
from pathlib import Path
import tempfile
import types
import unittest

P = Path(__file__).resolve().parent

def definitions(name):
    tree = ast.parse((P/'source'/name).read_text())
    return ast.Module(body=[n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.Assign))], type_ignores=[])

def allocator():
    g = {'json': json}
    exec(compile(definitions('allocator-confirmation.py'), 'allocator-fixture', 'exec'), g)
    return g

class Confirmation(unittest.TestCase):
    def setUp(self):
        self.g = allocator()
        self.identity = {'bound': True, 'invocationID': 'a'*32, 'pid': 123, 'startTicks': 77}
        self.boot = 'b'*32
        self.unit = 'enclave-rpc-nan-cl-trial-n10.service'
        # Concrete binary --version fixture, explicitly adapted to native config:
        # omit ONLY the two capability-only stats options and trailing statistics.
        capability = json.loads((P/'fixtures/low-retention.json').read_text())['stderr']
        lines = capability.split('___ Begin jemalloc statistics ___')[0].splitlines()
        lines = [s.replace(',stats_print:true,stats_print_opts:mdablx', '') for s in lines
                 if not s.startswith('<jemalloc>: -- Set conf value: stats_print')]
        self.rows = [{'_SYSTEMD_INVOCATION_ID': 'a'*32, '_BOOT_ID': self.boot,
                      '_SYSTEMD_UNIT': self.unit, '_PID': '123',
                      '__MONOTONIC_TIMESTAMP': str(100+i), 'MESSAGE': line}
                     for i, line in enumerate(lines)]

    def parse(self, rows=None):
        rows = self.rows if rows is None else rows
        return self.g['parse_allocator_confirmation']('\n'.join(json.dumps(r) for r in rows),
                                                      self.identity, self.boot, self.unit)

    def test_concrete_initializer_all_five_sources(self):
        proof = self.parse()
        self.assertTrue(proof['verified'])
        self.assertTrue(proof['allFiveSourcesMatched'])
        self.assertEqual(proof['acceptedOptions']['narenas'], '1')
        self.assertFalse(proof['rawMessagesRetained'])
        self.assertFalse(proof['memoryFitProven'])

    def test_pending_last_source_cannot_prove_effective_options(self):
        proof = self.parse(self.rows[:-1])
        self.assertFalse(proof['verified'])
        self.assertEqual(proof['acceptedOptions'], {})

    def test_each_missing_middle_line_rejected(self):
        for i in range(len(self.rows)-1):
            with self.subTest(i=i), self.assertRaises(AssertionError):
                self.parse(self.rows[:i]+self.rows[i+1:])

    def test_each_identity_dimension_is_required(self):
        for key in ('_PID', '_SYSTEMD_INVOCATION_ID', '_BOOT_ID', '_SYSTEMD_UNIT'):
            rows = copy.deepcopy(self.rows); rows[4][key] = 'different'
            with self.subTest(key=key), self.assertRaises(AssertionError): self.parse(rows)

    def test_nonempty_later_override_rejected(self):
        rows = copy.deepcopy(self.rows)
        rows[-1]['MESSAGE'] = rows[-1]['MESSAGE'][:-2]+'"narenas:16"'
        with self.assertRaises(AssertionError): self.parse(rows)

    def test_unexpected_initializer_sources_or_values_rejected(self):
        for value in ('narenas:2', 'Invalid conf pair: narenas:x', 'stats_print:true'):
            rows = copy.deepcopy(self.rows); rows[9]['MESSAGE'] = '<jemalloc>: -- Set conf value: '+value
            with self.subTest(value=value), self.assertRaises(AssertionError): self.parse(rows)

    def test_extra_allocator_output_after_final_source_rejected(self):
        extra = dict(self.rows[-1], MESSAGE='<jemalloc>: -- Set conf value: narenas:16')
        with self.assertRaises(AssertionError): self.parse(self.rows+[extra])

    def test_reordered_and_duplicate_initializer_rejected(self):
        rows = copy.deepcopy(self.rows); rows[8], rows[9] = rows[9], rows[8]
        with self.assertRaises(AssertionError): self.parse(rows)
        with self.assertRaises(AssertionError): self.parse(self.rows[:2]+self.rows[1:])

    def test_empty_is_pending_and_bounded_head_exhaustion_fails(self):
        self.assertFalse(self.parse([])['verified'])
        rows = [{'MESSAGE': 'unrelated public startup line'} for _ in range(64)]
        with self.assertRaisesRegex(AssertionError, 'bounded-head'): self.parse(rows)
        with self.assertRaisesRegex(AssertionError, 'row-limit'): self.parse(rows+[rows[0]])

    def test_byte_limit_and_malformed_records_fail(self):
        with self.assertRaisesRegex(AssertionError, 'byte-limit'):
            self.g['parse_allocator_confirmation']('x'*32769, self.identity, self.boot, self.unit)
        with self.assertRaises(json.JSONDecodeError):
            self.g['parse_allocator_confirmation']('{', self.identity, self.boot, self.unit)

    def test_live_process_must_match_native_executable_and_incarnation(self):
        info = {'diagnosticIdentity': self.identity}
        g = self.g
        g.update({'UNITS': {'cl': self.unit}, 'M': {'identities': {'cl': {'name': 'fixture'}}},
                  'PAYLOAD': Path('/fixture'),
                  'owned_info': lambda *args: {'MainPID': '123', 'ActiveState': 'active'},
                  'sample_client_diagnostics': lambda *args: {'cl': {'sameIncarnation': True, 'executable': 'lighthouse'}}})
        self.assertEqual(g['allocator_current_identity'](info), self.identity)
        for diag in ({'sameIncarnation': False, 'executable': 'lighthouse'},
                     {'sameIncarnation': True, 'executable': 'python-wrapper'}):
            g['sample_client_diagnostics'] = lambda *args, diag=diag: {'cl': diag}
            with self.assertRaises(AssertionError): g['allocator_current_identity'](info)

    def test_readiness_rejects_different_confirmation_invocation(self):
        g = self.g
        g.update({'allocator_current_identity': lambda info: self.identity,
                  'M': {'payloadFiles': {'lighthouse': {'sha256': 'fixed'}}},
                  'out': {'allocatorConfirmation': dict(self.parse(), binarySha256='fixed')}})
        g['require_allocator_at_startup_rpc']({})
        g['out']['allocatorConfirmation']['invocationID'] = 'c'*32
        with self.assertRaises(AssertionError): g['require_allocator_at_startup_rpc']({})

class NarrowChange(unittest.TestCase):
    def run_function(self, name):
        path = P/'source/trial-chain-service.py' if name == 'new' else P/'fixtures/prior-chain-service.py.txt'
        return next(n for n in ast.parse(path.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'run')

    def test_only_cl_allocator_assignment_changes_launch_function(self):
        new = self.run_function('new')
        class StripAllocator(ast.NodeTransformer):
            removed = 0
            def visit_Assign(self, node):
                if any(isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == 'env'
                       and isinstance(t.slice, ast.Constant) and t.slice.value == '_RJEM_MALLOC_CONF' for t in node.targets):
                    self.removed += 1
                    return None
                return node
        strip = StripAllocator(); normalized = strip.visit(copy.deepcopy(new))
        self.assertEqual(strip.removed, 1)
        self.assertEqual(ast.dump(normalized), ast.dump(self.run_function('old')))

    def test_cl_env_is_fresh_literal_without_stats_or_host_inheritance(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp)/'cl/beacon/chain_db').mkdir(parents=True)
            seen = []
            g = {'mount': lambda *args: tmp, 'pathlib': types.SimpleNamespace(Path=Path),
                 'ROOT': Path('/fixture'), 'binary': lambda name: '/fixture/'+name,
                 'low_memory_args': lambda *args: [], 'json': json, 'print': lambda *args, **kwargs: None,
                 'os': types.SimpleNamespace(execve=lambda exe, argv, env: seen.append((exe, argv, env)))}
            exec(compile(ast.Module(body=[self.run_function('new')], type_ignores=[]), 'launch-fixture', 'exec'), g)
            g['run']('cl')
            env = seen[0][2]
            self.assertEqual(set(env), {'PATH', 'LANG', 'HOME', 'TMPDIR', '_RJEM_MALLOC_CONF'})
            self.assertEqual(env['_RJEM_MALLOC_CONF'], allocator()['ALLOCATOR_CONFIGURATION'])
            self.assertNotIn('stats_print', env['_RJEM_MALLOC_CONF'])
            self.assertIn('--semi-supernode', seen[0][1])

    def test_fresh_namespace_and_no_copied_authority(self):
        m = json.loads((P/'source/MANIFEST.json').read_text())
        provenance = json.loads((P/'PROVENANCE.json').read_text())
        self.assertNotEqual(m['nonce'], provenance['oldNonce'])
        self.assertFalse(m['admission']['authorized'])
        self.assertEqual((m['admission']['at'], m['admission']['expiresAt']), (0, 0))
        self.assertEqual(m['admission']['osReserveMiB'], 2048)
        self.assertTrue(all('n10' in s for s in m['ownedSlices']))
        self.assertIn('n10', m['overlayDirectory'])
        self.assertIn(m['nonce'], m['exportName'])
        self.assertEqual(m['identityMode'], 'idmapped-whole-ext4')
        for name in ('ROOT-ADMISSION.json', 'FRESH-OBSERVATION.json', 'ATTEMPT.json'):
            self.assertFalse((P/name).exists()); self.assertFalse((P/'source'/name).exists())

    def test_assembly_includes_confirmation_and_proof_precedes_success(self):
        a = (P/'assemble.py').read_text()
        self.assertEqual(a.count("'allocator-confirmation.py'"), 2)
        main = (P/'source/client-main.py').read_text()
        self.assertLess(main.index('require_allocator_confirmation(info)'), main.index('require_sampling_headroom(time.time()'))
        self.assertLess(main.index("if rpc_observed:require_allocator_at_startup_rpc"), main.index("stop_request('bounded-trial-finished')"))

if __name__ == '__main__':
    unittest.main()
