#!/usr/bin/env python3
"""runtime-remote.py helpers with injected faults: short/failed/lying writes, compare-and-swap, state-continuity rules,
route-map readback rule. Temp dirs only.   python3 test/unit_test.py"""
import copy, errno, hashlib, json, os, shutil, tempfile, time, types, unittest
from pathlib import Path

SRC = (Path(__file__).resolve().parent.parent / 'activation' / 'runtime-remote.py').read_text()
sha = lambda b: hashlib.sha256(b).hexdigest()


class OsProxy(types.SimpleNamespace):
    def __getattr__(self, name):
        return getattr(os, name)


class Helpers(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp(prefix='dhr-unit-'))
        self.dropin = self.t / 'zz.conf'; self.old = b'[Service]\nExecStart=\nExecStart=/usr/local/bin/node /old.mjs /c.json\n' * 3; self.dropin.write_bytes(self.old)
        self.new = os.urandom(300000)
        p = {'mode': 'status', 'unit': 'u', 'dropin': str(self.dropin), 'backup': str(self.t / 'b.txt'), 'base_dropin_sha256': sha(self.old),
             'new_dropin_b64': '', 'new_dropin_sha256': '0', 'bundle_path': str(self.t / 'new.mjs'), 'bundle_sha256': '1',
             'old_bundle_path': '/old.mjs', 'old_bundle_sha256': '2', 'config_path': '/c.json', 'config_sha256': '3',
             'node': '/usr/local/bin/node', 'journal': str(self.t / 'j'), 'lock': str(self.t / 'l'), 'state_dir': str(self.t), 'port': 1, 'critical_labels': ['7ae476a3'],
             'run_id': 't', 'routes_timeout_s': 6, 'routes_needed': 2, 'minimum_routes': 2}
        self.ns = {'PARAMS': json.dumps(p), 'NO_MAIN': True, '__name__': 'runtime_remote_under_test'}
        exec(compile(SRC, 'runtime-remote.py', 'exec'), self.ns)
        self.proxy = OsProxy(); self.ns['os'] = self.proxy
        self.ns['time'] = types.SimpleNamespace(time=time.time, sleep=lambda s: None, strftime=time.strftime, gmtime=time.gmtime)

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def temps(self):
        return [p.name for p in self.t.iterdir() if p.name.startswith('.')]

    def test_short_writes_completed(self):
        self.proxy.write = lambda fd, data: os.write(fd, bytes(data[:999]))
        self.ns['_replace'](self.t / 'new.mjs', self.new, 'absent')
        self.assertEqual((self.t / 'new.mjs').read_bytes(), self.new); self.assertEqual(self.temps(), [])

    def test_enospc_midway_never_replaces(self):
        n = [0]
        def w(fd, data):
            n[0] += 1
            if n[0] > 2: raise OSError(errno.ENOSPC, 'full')
            return os.write(fd, bytes(data[:100]))
        self.proxy.write = w
        with self.assertRaises(OSError): self.ns['_replace'](self.dropin, self.new, sha(self.old))
        self.assertEqual(self.dropin.read_bytes(), self.old); self.assertEqual(self.temps(), [])

    def test_lying_write_caught(self):
        self.proxy.write = lambda fd, data: (os.write(fd, bytes(data[:len(data) // 3])), len(data))[1]
        with self.assertRaises(OSError): self.ns['_replace'](self.dropin, self.new, sha(self.old))
        self.assertEqual(self.dropin.read_bytes(), self.old); self.assertEqual(self.temps(), [])

    def test_cas_refuses_unexpected_target_and_existing_file(self):
        self.dropin.write_bytes(b'someone else')
        with self.assertRaises(self.ns['Drift']): self.ns['_replace'](self.dropin, self.new, sha(self.old))
        self.assertEqual(self.dropin.read_bytes(), b'someone else')
        with self.assertRaises(self.ns['Drift']): self.ns['_replace'](self.dropin, self.new, 'absent')

    def snap(self, **kw):
        base = {'providers': {'p1': 10}, 'providerExpiry': {'p1': int(time.time() * 1000) + 600000}, 'policies': {'d1': 2}, 'publications': {'d1': 5},
                'policyOwners': {'d1': 'owner1'}, 'policyHashes': {'d1': 'hash1'},
                'managementFloors': {'r1': {'version': 1, 'operators': {'operator1': {'sequence': 8, 'hash': 'm1'}}}},
                'floors': {'d1.json': {'epoch': 7, 'sequence': 5, 'publicKey': 'key1', 'hash': 'r1'}}, 'keys': []}
        base.update(kw); return base

    def test_continuity_forward_only(self):
        c, pre = self.ns['continuity'], self.snap()
        self.assertEqual(c(pre, self.snap(providers={'p1': 11, 'p2': 1}, policies={'d1': 3},
            floors={'d1.json': {'epoch': 7, 'sequence': 6, 'publicKey': 'key1', 'hash': 'r2'}})), [])
        self.assertTrue(c(pre, self.snap(policies={'d1': 1})), 'policy nonce went back')
        self.assertTrue(c(pre, self.snap(floors={'d1.json': {'epoch': 7, 'sequence': 4}})), 'route floor went back')
        self.assertTrue(c(pre, self.snap(floors={})), 'route floor vanished')
        self.assertTrue(c(pre, self.snap(providers={})), 'unexpired provider vanished')
        self.assertTrue(c(pre, self.snap(managementFloors={})), 'management floor vanished')
        expired = self.snap(providerExpiry={'p1': int(time.time() * 1000) - 1})
        self.assertEqual(c(expired, self.snap(providers={})), [], 'an expired provider may drop out')

    def test_replay_equivocation_and_operator_floor_loss_refused(self):
        pre = self.snap()
        for field, value in [('hash', 'different'), ('publicKey', 'different')]:
            after = copy.deepcopy(pre); after['floors']['d1.json'][field] = value
            self.assertTrue(self.ns['continuity'](pre, after), field)
        for operator_floor in ({}, {'operator1': {'sequence': 7, 'hash': 'm0'}},
                               {'operator1': {'sequence': 8, 'hash': 'different'}},
                               {'operator2': {'sequence': 99, 'hash': 'new'}}):
            after = copy.deepcopy(pre); after['managementFloors']['r1']['operators'] = operator_floor
            self.assertTrue(self.ns['continuity'](pre, after), repr(operator_floor))
        after = copy.deepcopy(pre)
        after['managementFloors']['r1']['operators']['operator1'] = {'sequence': 9, 'hash': 'm2'}
        self.assertEqual(self.ns['continuity'](pre, after), [])

    def test_policy_same_owner_equivocation_refused_owner_change_allowed(self):
        pre = self.snap()
        self.assertTrue(self.ns['continuity'](pre, self.snap(policyHashes={'d1': 'different'})))
        self.assertEqual(self.ns['continuity'](pre, self.snap(
            policyOwners={'d1': 'owner2'}, policies={'d1': 1}, policyHashes={'d1': 'different'})), [])

    def routes(self):
        return {'labels': {'7ae476a3': 'd1'}, 'deployments': {
            k: {'expiresAt': int(time.time() * 1000) + 600000} for k in ['d1', 'd2']}}

    def test_empty_unavailable_or_missing_critical_baseline_refused(self):
        self.ns['state_snapshot'] = self.snap
        for code, body in [(503, None), (200, {}), (200, {'labels': {}, 'deployments': {}}),
                           (200, {'labels': {}, 'deployments': {'d1': {}, 'd2': {}}})]:
            self.ns['get'] = lambda *a, **kw: (code, body)
            with self.assertRaises(RuntimeError): self.ns['pre_snapshot']()

    def test_durable_baseline_bound_to_journal_context_and_initial_state(self):
        initial = {'state': self.snap(), 'routes': self.routes()}
        self.ns['save_baseline'](initial)
        self.assertEqual(self.ns['load_baseline'](), initial)
        self.ns['state_snapshot'] = lambda: self.snap(floors={})
        self.assertTrue(self.ns['continuity'](self.ns['load_baseline']()['state'], self.ns['state_snapshot']()))
        self.ns['P']['config_sha256'] = 'changed'
        with self.assertRaisesRegex(RuntimeError, 'different activation'): self.ns['load_baseline']()
        self.ns['P']['config_sha256'] = '3'
        p = self.ns['BASELINE']; saved = p.read_bytes()
        p.write_bytes(saved + b' ')
        with self.assertRaisesRegex(RuntimeError, 'journal-bound'): self.ns['load_baseline']()
        p.unlink()
        with self.assertRaisesRegex(RuntimeError, 'missing'): self.ns['load_baseline']()

    def test_routes_rule(self):
        pre = self.routes()
        seq = []
        clock = [time.time()]
        self.ns['time'].time = lambda: clock[0]
        self.ns['time'].sleep = lambda s: clock.__setitem__(0, clock[0] + s)
        self.ns['get'] = lambda path, timeout=8: seq.pop(0) if len(seq) > 1 else seq[0]
        good = (200, pre)
        seq[:] = [good, good]; self.assertEqual(self.ns['routes_ok'](pre)['criticalLabels'], ['7ae476a3'])
        missing = (200, {'labels': {}, 'deployments': {str(i): 1 for i in range(11)}})
        seq[:] = [missing] * 50
        with self.assertRaises(RuntimeError): self.ns['routes_ok'](pre)
        few = (200, {'labels': {'7ae476a3': 1}, 'deployments': {'1': 1}})
        seq[:] = [few] * 50
        with self.assertRaises(RuntimeError): self.ns['routes_ok'](pre)
        substituted = copy.deepcopy(pre)
        substituted['deployments']['d3'] = substituted['deployments'].pop('d2')
        seq[:] = [(200, substituted)] * 50
        with self.assertRaises(RuntimeError): self.ns['routes_ok'](pre)

    if os.environ.get('INJECT_FAILURE'):
        def test_injected(self):
            self.fail('injected (negative control)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
