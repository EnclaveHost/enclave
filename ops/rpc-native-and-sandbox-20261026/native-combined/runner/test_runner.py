#!/usr/bin/env python3
"""Offline unit tests of runner.py's OWN logic only (pins, gates on files, trusted-input assembly, mutation targeting). They do not
touch any node, binary or witness from the chain and prove nothing about derivation or execution."""
import hashlib, json, pathlib, sys, tempfile, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import runner as R
H = lambda b: '0x' + b * 32

class T(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
    def pin(self, name, doc):
        p = self.d / name; p.write_text(json.dumps(doc)); return {'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
    def cfg(self, **over):
        c = {'anchor': self.pin('a.json', {'format': 'enclave-base-finalized-anchor/v1', 'finality': 'l1-finalized-asr-anchor',
                                           'base': {'number': 100, 'outputRoot': H('aa'), 'hash': H('01'), 'stateRoot': H('02'), 'messagePasserStorageRoot': H('03')}}),
             'l1Head': self.pin('l.json', {'number': 5, 'hash': H('bb'), 'timestamp': 7, 'source': 'in-domain-light-client'}),
             'schedule': self.pin('s.json', {'rollupConfig': {}, 'expectedRollupConfigHash': H('cc'), 'expectedScheduleId': H('dd')}),
             'endpoints': {k: 'http://127.0.0.1:18545' for k in ('l1Rpc', 'l1Beacon', 'l2Rpc', 'l2Node')}, 'sizes': [1], 'outDir': str(self.d / 'out')}
        c.update(over); return c
    def test_gate_accepts_pinned_inputs_without_probe(self):
        g = R.gate(self.cfg(), probe=False)
        self.assertEqual((g['anchor']['number'], g['l1Head']['hash']), (100, H('bb')))
    def test_unpinned_or_altered_inputs_refuse(self):
        c = self.cfg(); pathlib.Path(c['anchor']['path']).write_text('{}')
        with self.assertRaisesRegex(R.Refused, 'not the pinned'): R.gate(c, probe=False)
        with self.assertRaisesRegex(R.Refused, 'source-authenticated input not supplied'): R.gate(self.cfg(anchor=None), probe=False)
    def test_rpc_finalized_label_is_not_an_l1_head(self):
        c = self.cfg(l1Head=self.pin('l2.json', {'number': 5, 'hash': H('bb'), 'timestamp': 7, 'source': 'rpc-finalized-tag'}))
        with self.assertRaisesRegex(R.Refused, 'in-domain-light-client'): R.gate(c, probe=False)
    def test_unauthenticated_anchor_refuses(self):
        c = self.cfg(anchor=self.pin('a2.json', {'base': {'number': 1, 'outputRoot': H('aa')}}))
        with self.assertRaisesRegex(R.Refused, 'authenticated ASR anchor'): R.gate(c, probe=False)
    def test_public_endpoint_refuses(self):
        c = self.cfg(); c['endpoints']['l2Rpc'] = 'https://mainnet.base.org'
        with self.assertRaisesRegex(R.Refused, 'own nodes'): R.gate(c, probe=False)
    def test_trusted_input_uses_only_caller_values(self):
        g = R.gate(self.cfg(), probe=False); t = R.trusted(g, 101, H('ee'), 1)
        self.assertEqual(set(t), {'chainId', 'intermediateBlockInterval', 'l1Head', 'l1HeadNumber', 'agreedL2OutputRoot', 'claimedL2OutputRoot', 'claimedL2BlockNumber', 'rollupConfig',
                                  'expectedRollupConfigHash', 'expectedScheduleId'})
        self.assertEqual((t['agreedL2OutputRoot'], t['l1Head'], t['claimedL2BlockNumber']), (H('aa'), H('bb'), 101))
    def test_interval_is_required_and_must_divide_the_range(self):
        g = R.gate(self.cfg(), probe=False)
        self.assertEqual(R.trusted(g, 130, H('ee'), 30)['intermediateBlockInterval'], 30)
        for bad in (0, 7, None):
            with self.assertRaisesRegex(R.Refused, 'intermediateBlockInterval'): R.trusted(g, 130, H('ee'), bad)
    def test_mutations_target_the_agreed_preimage_and_blobs_or_report_not_tested(self):
        g = R.gate(self.cfg(), probe=False); a = g['anchor']
        pre = list(bytes(32) + bytes.fromhex('02' * 32) + bytes.fromhex('03' * 32) + bytes.fromhex('01' * 32))
        w = {'preimageStore': {'preimage_map': [[{'k': 1}, [1, 2]], [{'k': 2}, pre]]}, 'blobData': {'blobs': [], 'commitments': [], 'proofs': []}}
        m, why = R.mutate(w, 'missing-preimage', a); self.assertIsNone(why); self.assertEqual(len(m['preimageStore']['preimage_map']), 1)
        m, why = R.mutate(w, 'hashbad-preimage', a); self.assertNotEqual(m['preimageStore']['preimage_map'][1][1], pre)
        m, why = R.mutate(w, 'kzgbad-blob', a); self.assertIsNone(m); self.assertIn('NOT TESTED', why)
        w['blobData']['blobs'] = [[0] * 131072]; m, why = R.mutate(w, 'kzgbad-blob', a); self.assertEqual(m['blobData']['blobs'][0][1000], 1)
        m, why = R.mutate({'preimageStore': {'preimage_map': []}, 'blobData': {}}, 'missing-preimage', a); self.assertIsNone(m)

if __name__ == '__main__':
    unittest.main()
