"""anchored_origin.py: exact-N extraction through the pinned origin_extract Reader + binding to the anchor via the pinned anchor-bootstrap."""
import hashlib, json, os, shutil, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anchor_fixture as F  # noqa: E402
from anchor_fixture import AO, N, h32  # noqa: E402

ORIGIN, ORIGIN_HASH = 26235784, h32('l1-origin')


class AnchoredOriginTest(unittest.TestCase):
    def setUp(self):
        self.a = F.AnchorDB(ORIGIN, ORIGIN_HASH)

    def tearDown(self):
        self.a.close()

    def test_exact_n_is_read_and_bound_not_the_safe_head(self):
        doc = self.a.extract()
        self.assertEqual((doc['format'], doc['rule'], doc['anchor']['N']), (AO.FORMAT, 'anchor-origin-minus-seq-window', N))
        self.assertEqual(doc['l1Origin']['number'], ORIGIN)
        self.assertEqual(doc['l1Origin']['hash'], ORIGIN_HASH)
        self.assertEqual(doc['needFrom'], ORIGIN - 3600)
        self.assertEqual((doc['header']['hash'], doc['binding']['ok'], doc['anchor']['outputRoot']), (self.a.hash, True, self.a.root))
        self.assertEqual((doc['header']['mixHash'], doc['header']['parentBeaconBlockRoot']),
                         (self.a.header['mixHash'], self.a.header['parentBeaconBlockRoot']))
        self.assertEqual((doc['layout'], doc['sequenceNumber'], doc['batcher']), ('jovian', 2, '0x' + F.BATCHER))
        self.assertIn('UNAUTHENTICATED', doc['l1Origin']['evidence'])
        argv = [' '.join(c['argv'][c['argv'].index('get') + 1:]) for c in doc['source']['calls']]
        self.assertFalse(any('ChainState' in x for x in argv), argv)          # LastSafeBlock/LastFinalizedBlock never read
        self.assertIn(f'static-file headers {N}', argv)
        self.assertTrue(all(c['argv'][:3] == ['reth', 'db', '--chain'] for c in doc['source']['calls']))

    def test_header_that_does_not_reproduce_the_receipt_root_is_refused(self):
        self.a.write_receipt(h32('other-root'))
        with self.assertRaisesRegex(AO.Refused, 'does not bind.*output_root'):
            self.a.extract()

    def test_real_pinned_receipt_is_used_and_a_synthetic_header_cannot_bind_to_it(self):
        real = AO.PINS['receipt'][0]
        rec = json.load(open(real))
        self.assertEqual((rec['verdict'], rec['N']), ('A1-authenticated', '52866960'))
        with self.assertRaisesRegex(AO.Refused, 'output_root'):
            self.a.extract(receipt=real, pins=AO.PINS)

    def test_receipt_bytes_must_be_the_pinned_ones(self):
        with open(self.a.receipt, 'a') as f:
            f.write(' ')
        with self.assertRaisesRegex(AO.Refused, 'receipt.*not the pinned'):
            self.a.extract()

    def test_db_header_or_hash_tamper_is_refused(self):
        key = f'static-file headers {N}'
        self.a.db[key] = [dict(self.a.header, stateRoot=h32('evil')), self.a.hash]   # header content differs, same claimed hash
        with self.assertRaisesRegex(AO.Refused, 'does not bind'):
            self.a.extract()
        self.a.db[key] = [self.a.header, h32('wrong-hash')]                            # header binds, DB BlockHash does not match it
        with self.assertRaisesRegex(AO.Refused, 'differs from the DB BlockHash'):
            self.a.extract()
        hdr = dict(self.a.header); del hdr['requestsHash']                              # not an Isthmus header
        self.a.db[key] = [hdr, self.a.hash]
        with self.assertRaisesRegex(AO.Refused, 'not_isthmus'):
            self.a.extract()

    def test_db_must_hold_n_and_be_the_pinned_tooling(self):
        self.a.db['mdbx StageCheckpoints "Finish"']['block_number'] = N - 1
        with self.assertRaisesRegex(AO.Refused, 'below the anchor'):
            self.a.extract()
        self.a.db['mdbx StageCheckpoints "Finish"']['block_number'] = N
        with self.assertRaisesRegex(AO.Refused, 'pinned sha256'):
            self.a.extract(sha='0' * 64)
        self.a.db[f'mdbx BlockBodyIndices {N}']['tx_count'] = 0
        with self.assertRaisesRegex(AO.Refused, 'body pruned or empty'):
            self.a.extract()

    def test_writable_datadir_refused_with_the_real_mount_probe(self):
        self.a.flush()
        scratch = tempfile.mkdtemp(dir=self.a.tmp.name)
        with self.assertRaisesRegex(AO.Refused, 'read-only mount'):
            AO.extract_anchored(self.a.bin, self.a.sha, self.a.dd, self.a.receipt, scratch, F.NODE, 30, self.a.pins)

    def test_pinned_modules_are_enforced(self):
        bad = os.path.join(self.a.tmp.name, 'anchor-bootstrap.mjs')
        shutil.copy(AO.PINS['anchor_bootstrap'][0], bad)
        with open(bad, 'a') as f:
            f.write('\n// changed\n')
        pins = dict(self.a.pins, anchor_bootstrap=(bad, AO.PINS['anchor_bootstrap'][1]))
        with self.assertRaisesRegex(AO.Refused, 'anchor_bootstrap.*not the pinned'):
            self.a.extract(pins=pins)
        pins = dict(self.a.pins, origin_extract=(bad, AO.PINS['origin_extract'][1]))
        with self.assertRaisesRegex(AO.Refused, 'origin_extract.*not the pinned'):
            self.a.extract(pins=pins)

    def test_cli_writes_once_and_refuses_overwrite(self):
        out = os.path.join(self.a.tmp.name, 'anchored.json')
        open(out, 'w').close()
        with self.assertRaises(SystemExit):
            AO.main(['--base-bin', self.a.bin, '--base-sha256', self.a.sha, '--datadir', self.a.dd, '--scratch', self.a.tmp.name,
                     '--receipt', self.a.receipt, '--node', F.NODE, '--out', out])
        os.unlink(out)
        # the CLI uses the source pins: with this synthetic receipt it must refuse (exit 2) and write nothing
        rc = AO.main(['--base-bin', self.a.bin, '--base-sha256', self.a.sha, '--datadir', self.a.dd,
                      '--scratch', tempfile.mkdtemp(dir=self.a.tmp.name), '--receipt', self.a.receipt, '--node', F.NODE, '--out', out])
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(out))


if __name__ == '__main__':
    unittest.main()
