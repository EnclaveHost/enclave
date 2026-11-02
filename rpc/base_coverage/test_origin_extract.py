"""Tests for origin_extract.py with a fake `base` binary that prints reth `db get` output (logs + ANSI)."""
import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import origin_extract as oe  # noqa: E402

L1HASH = '0x' + 'ab' * 32
BATCHER = '5050f69a9786f081509234f1a7f4684b5e5b76c9'


def ecotone_like(selector, extra, number=21000000, seq=3, batcher=BATCHER):
    body = (b'\0' * 8 + seq.to_bytes(8, 'big') + (1700000000).to_bytes(8, 'big') + number.to_bytes(8, 'big')
            + b'\0' * 64 + bytes.fromhex(L1HASH[2:]) + bytes(12) + bytes.fromhex(batcher))
    return '0x' + bytes.fromhex(selector).hex() + body.hex() + '00' * extra


def bedrock(number=17000000):
    w = lambda v: v.to_bytes(32, 'big')
    data = (w(number) + w(1680000000) + w(7) + bytes.fromhex(L1HASH[2:]) + w(2)
            + bytes(12) + bytes.fromhex(BATCHER) + w(0) + w(0))
    return '0x015d8eb9' + data.hex()


FAKE = r'''#!/usr/bin/env python3
import json, os, sys
db = json.load(open(os.environ.get('FAKE_DB') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'db.json')))
a = sys.argv[1:]
i = a.index('get')
key = ' '.join(a[i + 1:])
print('\x1b[2m2026-10-25T00:00:00Z\x1b[0m \x1b[32m INFO\x1b[0m Opening storage db_path="/x/db"')
if key not in db:
    print('\x1b[31mERROR\x1b[0m No content for the given table key.')
    sys.exit(0)
v = db[key]
if a[i + 1:i + 3] == ['static-file', 'headers']:
    print('Header\n' + json.dumps(v[0], indent=2) + '\n\nBlockHash\n' + json.dumps(v[1]))
else:
    print(json.dumps(v, indent=2))
'''


def block_entries(n, tx_num, calldata, tx_count=2):
    return {f'static-file headers {n}': [{'number': hex(n), 'parentHash': '0x' + '11' * 32, 'timestamp': hex(1761350400 + n)},
                                         '0x' + hashlib.sha256(str(n).encode()).hexdigest()],
            f'mdbx BlockBodyIndices {n}': {'first_tx_num': tx_num, 'tx_count': tx_count},
            f'static-file transactions {tx_num}': {'type': '0x7e', 'sourceHash': '0x' + '22' * 32, 'from': '0x' + 'de' * 20,
                                                  'to': '0x4200000000000000000000000000000000000015', 'input': calldata}}


class DecodeTest(unittest.TestCase):
    def test_layouts(self):
        for sel, extra, layout in (('440a5e20', 0, 'ecotone'), ('098999be', 12, 'isthmus'), ('3db6be2b', 14, 'jovian')):
            d = oe.decode_l1_info(ecotone_like(sel, extra))
            self.assertEqual((d['layout'], d['l1Origin'], d['sequenceNumber'], d['batcher']),
                             (layout, {'number': 21000000, 'hash': L1HASH}, 3, '0x' + BATCHER))
        d = oe.decode_l1_info(bedrock())
        self.assertEqual((d['layout'], d['l1Origin']['number'], d['l1Origin']['hash'], d['batcher']),
                         ('bedrock', 17000000, L1HASH, '0x' + BATCHER))

    def test_rejects(self):
        for bad in (ecotone_like('3db6be2b', 13), ecotone_like('deadbeef', 14), '0xzz', ecotone_like('440a5e20', 0)[:-2],
                    ecotone_like('440a5e20', 0).replace('000000000000000000000000' + BATCHER, 'ff' * 12 + BATCHER)):
            with self.assertRaises(oe.Refusal):
                oe.decode_l1_info(bad)


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bin = os.path.join(self.tmp.name, 'base')
        with open(self.bin, 'w') as f:
            f.write(FAKE)
        os.chmod(self.bin, stat.S_IRWXU)
        with open(self.bin, 'rb') as f:
            self.sha = hashlib.file_digest(f, 'sha256').hexdigest()
        self.dd = os.path.join(self.tmp.name, 'dd')
        os.makedirs(os.path.join(self.dd, 'db'))
        self.db = {'mdbx StageCheckpoints "Finish"': {'block_number': 53048526, 'stage_checkpoint': None}}
        self.db.update(block_entries(53048526, 900, ecotone_like('3db6be2b', 14, number=21000500)))
        self._ro = oe.read_only_mount
        # Only the snapshot datadir is treated as read-only here; jobs/real-origin.sh uses a real ro bind mount.
        oe.read_only_mount = lambda p: os.path.realpath(p).startswith(os.path.realpath(self.dd))

    def tearDown(self):
        oe.read_only_mount = self._ro
        self.tmp.cleanup()

    def run_extract(self):
        os.environ['FAKE_DB'] = os.path.join(self.tmp.name, 'db.json')
        with open(os.environ['FAKE_DB'], 'w') as f:
            json.dump(self.db, f)
        scratch = tempfile.mkdtemp(dir=self.tmp.name, prefix='scratch')
        return oe.extract(self.bin, self.sha, self.dd, timeout=30, scratch=scratch)

    def test_persisted_safe_and_finalized(self):
        self.db['mdbx ChainState "LastSafeBlock"'] = 53047000
        self.db['mdbx ChainState "LastFinalizedBlock"'] = 53040000
        self.db.update(block_entries(53047000, 800, ecotone_like('3db6be2b', 14, number=21000300)))
        self.db.update(block_entries(53040000, 700, ecotone_like('3db6be2b', 14, number=21000000)))
        doc = self.run_extract()
        self.assertEqual(doc['status'], 'SAFE_HEAD_PERSISTED')
        self.assertEqual(doc['labels']['safe']['l1Origin']['number'], 21000300)
        self.assertEqual(doc['labels']['tip']['l1Origin']['number'], 21000500)
        self.assertEqual(doc['labels']['finalized']['number'], 53040000)
        self.assertTrue(all(c['argv'][:3] == ['reth', 'db', '--chain'] and 'get' in c['argv'] for c in doc['source']['calls']))
        self.assertTrue(all(c['argv'][c['argv'].index('--datadir.rocksdb') + 1].endswith('/view/rocksdb') for c in doc['source']['calls']))

    def test_scratch_inside_datadir_or_nonempty_refused(self):
        with self.assertRaisesRegex(oe.Refusal, 'outside the snapshot'):
            oe.extract(self.bin, self.sha, self.dd, scratch=os.path.join(self.dd, 'db'))
        with self.assertRaisesRegex(oe.Refusal, 'empty directory'):
            oe.extract(self.bin, self.sha, self.dd, scratch=self.tmp.name)
        with self.assertRaisesRegex(oe.Refusal, 'scratch is required'):
            oe.extract(self.bin, self.sha, self.dd)

    def test_no_persisted_safe_is_reported_not_fabricated(self):
        doc = self.run_extract()
        self.assertEqual((doc['status'], doc['labels']['safe'], doc['labels']['finalized']), ('NO_PERSISTED_SAFE_HEAD', None, None))

    def test_refusals(self):
        self.db['mdbx ChainState "LastSafeBlock"'] = 53047000
        self.db.update(block_entries(53047000, 800, ecotone_like('3db6be2b', 14), tx_count=0))
        with self.assertRaisesRegex(oe.Refusal, 'body pruned or empty'):
            self.run_extract()
        self.db.update(block_entries(53047000, 800, '0x' + 'ab' * 182))
        with self.assertRaisesRegex(oe.Refusal, 'not an L1-attributes deposit'):
            self.run_extract()
        self.db['mdbx ChainState "LastSafeBlock"'] = 53049999
        self.db.update(block_entries(53049999, 1000, ecotone_like('3db6be2b', 14)))
        with self.assertRaisesRegex(oe.Refusal, 'above tip'):
            self.run_extract()
        del self.db['mdbx StageCheckpoints "Finish"']
        with self.assertRaisesRegex(oe.Refusal, 'Finish'):
            self.run_extract()
        with self.assertRaisesRegex(oe.Refusal, 'pinned sha256'):
            oe.extract(self.bin, '0' * 64, self.dd, scratch=tempfile.mkdtemp(dir=self.tmp.name))

    def test_writable_datadir_refused(self):
        oe.read_only_mount = self._ro
        with self.assertRaisesRegex(oe.Refusal, 'read-only mount'):
            self.run_extract()


if __name__ == '__main__':
    unittest.main()
