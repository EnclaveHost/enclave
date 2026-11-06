"""rpc/snp/base_restart_patch.py against the shipped guest chain_service.py lineage.

python3 -m unittest test/rpc-snp/test_base_restart_patch.py
"""
import ast
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import base_restart_patch as P  # noqa: E402
import l1_identity_patch as L  # noqa: E402

# The seed's chain_service.py: with build_image.py's beacon sed and l1_identity_patch.py it is byte-identical
# to the one images r10 and the first r11 build shipped (sha256 7292c7c9...).
SEED = ROOT/'ops/rpc-backend-bootstrap/2026-10-25/chain_service.py'
ORIGIN = {'l1Block': 26262339, 'blobSlot': 15501577, 'toBlock': 26292338, 'snapshot': {'block': 48000000}}
SERVED = {'l1Block': 26262339, 'blobSlot': 15501577, 'toBlock': 26292338, 'snapshotBlock': 48000000}


def shipped(tmp):
    s = SEED.read_text().replace("'--l1-beacon', 'http://127.0.0.1:15052'", "'--l1-beacon', 'http://127.0.0.1:15053'")
    p = Path(tmp, 'chain_service.py')
    p.write_text(s)
    L.patch(str(p))
    return p


class Http:
    def __init__(self, receipts, blobs):
        self.receipts, self.blobs = receipts, blobs

    def urlopen(self, req, timeout):
        return io.BytesIO(json.dumps(self.receipts).encode())

    def beacon(self, path):
        if path.startswith('/eth/v2/beacon/blocks/'):
            return {'message': {'body': {'blob_kzg_commitments': ['0x01', '0x02']}}}
        if callable(self.blobs):
            raise self.blobs()   # a fresh error each time: its body is a stream read once
        return self.blobs


def http_error(code, body):
    return lambda: urllib.error.HTTPError('http://127.0.0.1:15052/x', code, 'x', {}, io.BytesIO(body))


PRESENT = {'jsonrpc': '2.0', 'id': 1, 'result': [{'status': '0x1'}]}
PRUNED = {'jsonrpc': '2.0', 'id': 1, 'error': {'code': 4444, 'message': 'pruned history unavailable'}}
BLOBS = ['0xaa', '0xbb']
LH_PRUNED = http_error(400, b'{"code":400,"message":"BAD_REQUEST: Insufficient data columns to reconstruct blobs"}')


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = shipped(self.tmp.name)
        P.patch(str(self.path))
        self.src = self.path.read_text()
        self.datadir = Path(self.tmp.name, 'data')
        self.datadir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, receipts, blobs):
        """Run the patched base_origin_data with the guest's helpers replaced by fakes."""
        http = Http(receipts, blobs)
        tree = ast.parse(self.src)
        keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name == 'base_origin_data')
                or (isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'ORIGIN_SERVED')]
        urllib_fake = type('U', (), {'request': type('R', (), {'urlopen': staticmethod(http.urlopen),
                                                                'Request': staticmethod(lambda *a: a)}),
                                     'error': urllib.error})
        env = {'json': json, 'os': __import__('os'), 'pathlib': __import__('pathlib'), 'urllib': urllib_fake,
               'beacon': http.beacon, 'print': lambda *a, **k: None}
        exec(compile(ast.Module(keep, []), 'patched', 'exec'), env)
        return env['base_origin_data'](ORIGIN, str(self.datadir))

    def record(self):
        return json.loads((self.datadir/'enclave-origin-served.json').read_text())

    def test_patch_applies_once_and_compiles(self):
        compile(self.src, 'chain_service.py', 'exec')
        self.assertIn('        base_origin_data(origin, datadir)\n', self.src)
        self.assertNotIn("'Base origin blobs absent'", self.src)
        with self.assertRaises(SystemExit):
            P.patch(str(self.path))

    def test_origin_served_records_this_activation(self):
        self.assertEqual(self.check(PRESENT, BLOBS), 'origin-served')
        self.assertEqual(self.record(), SERVED)

    def test_pruned_blobs_resume_only_with_this_activation_recorded(self):
        with self.assertRaisesRegex(AssertionError, 'receipts or blobs absent'):
            self.check(PRESENT, LH_PRUNED)
        self.check(PRESENT, BLOBS)
        self.assertEqual(self.check(PRESENT, LH_PRUNED), 'resumed')
        self.assertEqual(self.check(PRESENT, http_error(404, b'')), 'resumed')
        self.assertEqual(self.check(PRESENT, BLOBS[:1]), 'resumed')

    def test_pruned_receipts_resume_only_with_this_activation_recorded(self):
        with self.assertRaisesRegex(AssertionError, 'receipts or blobs absent'):
            self.check(PRUNED, BLOBS)
        self.check(PRESENT, BLOBS)
        self.assertEqual(self.check(PRUNED, LH_PRUNED), 'resumed')

    def test_a_record_of_another_activation_or_unreadable_does_not_resume(self):
        rec = self.datadir/'enclave-origin-served.json'
        rec.write_text(json.dumps({**SERVED, 'blobSlot': 1}))
        with self.assertRaisesRegex(AssertionError, 'receipts or blobs absent'):
            self.check(PRESENT, LH_PRUNED)
        rec.write_text('{')
        with self.assertRaisesRegex(AssertionError, 'receipts or blobs absent'):
            self.check(PRUNED, BLOBS)
        self.assertEqual(self.check(PRESENT, BLOBS), 'origin-served')
        self.assertEqual(self.record(), SERVED)

    def test_other_l1_errors_still_refuse(self):
        self.check(PRESENT, BLOBS)
        with self.assertRaises(urllib.error.HTTPError):
            self.check(PRESENT, http_error(500, b'internal'))
        with self.assertRaises(urllib.error.HTTPError):
            self.check(PRESENT, http_error(400, b'bad slot'))
        with self.assertRaisesRegex(AssertionError, 'local RPC failed'):
            self.check({'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32000, 'message': 'x'}}, BLOBS)
        with self.assertRaisesRegex(AssertionError, 'origin receipts absent'):
            self.check({'jsonrpc': '2.0', 'id': 1, 'result': None}, BLOBS)


if __name__ == '__main__':
    unittest.main()
