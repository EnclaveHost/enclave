"""segments.py and anchored_acceptance.py over the pinned coverage gate's own fake L1 (test_coverage_gate.py 5d5d8604: real blobs,
kzgcheck-sealed blocks), re-sealed here so every EL header's parentBeaconBlockRoot is its beacon block's parent_root (EIP-4788).

The anchored-origin document is produced end-to-end by anchored_origin.py from the fake DB; header N carries the mixHash/
parentBeaconBlockRoot of whichever L1 block a test makes its true origin, and its deposit names whichever block the test (or attacker)
chooses. KZGCHECK and NODE env vars are required."""
import copy, hashlib, http.server, json, os, shutil, sys, tempfile, threading, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anchor_fixture as F  # noqa: E402
from anchor_fixture import AO, h32  # noqa: E402
import segments as SG  # noqa: E402
import anchored_acceptance as AA  # noqa: E402

TCG = F.pinned_module((os.path.join(F.COV, 'test_coverage_gate.py'),
                       '5d5d8604e41f920ab72eb964516ae3b0a228824207fc5b6ab8ee4244d104fc14'), 'test_coverage_gate_pinned')
OPS = os.path.dirname(F.COV)
TCA = F.pinned_module((os.path.join(OPS, 'test_coverage_activation.py'),
                       '24c37c51d20f164434739093dd513d9206968e0ac60aec1ba59271b1116fa6f7'), 'test_coverage_activation_pinned')
CS = TCA.c                                                    # the existing activation code (source chain_service.py, sha checked below)
KZG, KZG_SHA = TCG.KZG, TCG.KZG_SHA
FIRST, FINAL, HEAD = TCG.FIRST, TCG.FINAL, TCG.HEAD


def serve(chain):
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), TCG.Handler)
    srv.chain = chain
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'


def reseal(chain, start, edits=None):
    """Re-seal blocks start..HEAD in order: EL parent links, EIP-4788 parentBeaconBlockRoot = beacon parent_root, then the beacon
    block's execution block_hash. `edits` overrides header fields of a block before it is sealed."""
    sealer = TCG.cg.Kzg(KZG, KZG_SHA, 'block')
    for n in range(start, HEAD + 1):
        b, msg = chain.el[n], chain.blinded[chain.slots[n]]['data']['message']
        if n > FIRST:
            b['parentHash'] = chain.el[n - 1]['hash']
        b['parentBeaconBlockRoot'] = msg['parent_root']
        b.update((edits or {}).get(n, {}))
        TCG.seal(b, chain.receipts[n], sealer)
        msg['body']['execution_payload_header']['block_hash'] = b['hash']
    sealer.close()
    return chain


class SegTest(unittest.TestCase):
    def setUp(self):
        self._sw = (SG.SEQ_WINDOW, AO.SEQ_WINDOW, TCG.MISSED_AFTER)
        self.tmp = tempfile.TemporaryDirectory()
        self.servers, self.anchors, self.n = [], [], 0

    def tearDown(self):
        SG.SEQ_WINDOW, AO.SEQ_WINDOW, TCG.MISSED_AFTER = self._sw
        for s in self.servers:
            s.shutdown(); s.server_close()
        for a in self.anchors:
            a.close()
        self.tmp.cleanup()

    def path(self, name):
        self.n += 1
        return os.path.join(self.tmp.name, f'{self.n:02d}-{name}')

    def new_chain(self, missed_after=None):
        if missed_after is not None:
            TCG.MISSED_AFTER = missed_after
        return reseal(TCG.Chain(), FIRST)

    def setup_chain(self, seq_window=4, origin=1004, true_origin=None, chain=None, missed_after=None, mix=None, pbr=None,
                    origin_hash=None, seg_blocks=5, batcher=F.BATCHER):
        """Deposit names `origin`; header N is built for `true_origin` (default: the same block) unless mix/pbr override it."""
        SG.SEQ_WINDOW = AO.SEQ_WINDOW = seq_window
        self.chain = TCG.CURRENT = chain or self.new_chain(missed_after)
        self.srv, self.url = serve(self.chain)
        self.servers.append(self.srv)
        t = self.chain.el[true_origin or origin]
        self.a = F.AnchorDB(origin, origin_hash or self.chain.h(origin), mix=mix or t['mixHash'], pbr=pbr or t['parentBeaconBlockRoot'],
                            batcher=batcher)
        self.anchors.append(self.a)
        self.anchored = self.path('anchored.json')
        with open(self.anchored, 'w') as f:
            json.dump(self.a.extract(), f)
        self.plan_path = self.path('plan.json')
        self.plan = SG.make_plan(self.anchored, self.a.receipt, F.NODE, FINAL, seg_blocks, pins=self.a.pins)
        with open(self.plan_path, 'w') as f:
            json.dump(self.plan, f)
        return self.plan

    def run_seg(self, i, url=None, plan=None, scope='batcher'):
        d = self.path(f'seg{i}')
        S = SG.run_segment(plan or self.plan_path, i, d, url or self.url, url or self.url, KZG, KZG_SHA, ['--rps', '500'], blob_scope=scope)
        return d, S

    def agg(self, dirs, plan=None, anchored=None, **kw):
        return SG.aggregate(plan or self.plan_path, anchored or self.anchored, dirs, **kw)

    def refused(self, code, dirs, **kw):
        with self.assertRaises(SG.Refused) as cm:
            self.agg(dirs, **kw)
        self.assertEqual(cm.exception.code, code, cm.exception.detail)
        return cm.exception

    def covered(self):
        dirs = [self.run_seg(i)[0] for i in range(len(self.plan['segments']))]
        return dirs, self.agg(dirs)

    # ---- coverage over the anchored range ----------------------------------------------------------------------------

    def test_two_segments_cover_the_exact_anchored_range_via_cli(self):
        P = self.setup_chain()
        self.assertEqual((P['needFrom'], P['toBlock'], [(s['from'], s['to']) for s in P['segments']]),
                         (FIRST, FINAL, [(1000, 1004), (1005, 1008)]))
        dirs = []
        for i in (1, 0):                                      # any run order
            d = self.path(f'cli-seg{i}')
            rc = SG.main(['run-segment', '--plan', self.plan_path, '--index', str(i), '--out-dir', d, '--el', self.url,
                          '--beacon', self.url, '--kzg', KZG, '--kzg-sha256', KZG_SHA, '--rps', '500'])
            self.assertEqual(rc, 0)
            dirs.append(d)
            G = json.load(open(os.path.join(d, 'gate-report.json')))
            self.assertEqual((G['format'], G['verdict'], G['coverageVerifiedWritten'], G['batcher']), (SG.SEG_GATE_FORMAT, 'COVERED', False, None))
        out = self.path('agg.json')
        cli = ['aggregate', '--plan', self.plan_path, '--anchored', self.anchored, '--receipt', self.a.receipt, '--node', F.NODE]
        with mock.patch.dict(AO.PINS, receipt=self.a.pins['receipt']):
            self.assertEqual(SG.main(cli + ['--segment', dirs[0], '--segment', dirs[1], '--out', out]), 0)
            self.assertEqual(SG.main(cli + ['--segment', dirs[0], '--out', self.path('agg2.json')]), 3)
            with self.assertRaises(SystemExit):
                SG.main(cli + ['--segment', dirs[0], '--out', out])
        A = json.load(open(out))
        self.assertEqual(A['verdict'], 'COVERED_ALL_SEGMENTS')
        self.assertEqual((A['range']['needFrom'], A['range']['toBlock'], A['counts']['blocks']), (FIRST, FINAL, FINAL - FIRST + 1))
        self.assertEqual((A['counts']['blobsVerified'], A['counts']['missingData'], A['counts']['mismatches']), (3, 0, 0))
        self.assertEqual((A['counts']['missedSlots'], A['missedSlotsAtBoundaries']), (1, 0))
        self.assertEqual((A['l1Origin']['number'], A['l1Origin']['segment'], A['l1Block'], A['blobSlot'], A['blobScope']),
                         (1004, 0, FIRST, self.chain.slots[1002], 'batcher'))
        self.assertEqual((A['coverageVerifiedWritten'], A['rootReviewRequired']), (False, True))
        self.assertIn('NOT consensus authority', A['authority'])
        # the default (source-pinned) A1 receipt is not this synthetic anchor: the CLI refuses before aggregating
        self.assertEqual(SG.main(cli + ['--segment', dirs[0], '--segment', dirs[1], '--out', self.path('agg3.json')]), 3)

    def test_missed_slot_exactly_at_a_segment_boundary_is_linked_and_counted(self):
        self.setup_chain(missed_after=1004)
        A = self.covered()[1]
        self.assertEqual((A['missedSlotsAtBoundaries'], A['counts']['missedSlots']), (1, 0))

    def test_el_discontinuity_across_a_boundary_is_refused(self):
        self.setup_chain(seq_window=2, origin=1002)
        fork = copy.deepcopy(self.chain)                      # same chain, block 1004 alone re-sealed with another state root
        sealer = TCG.cg.Kzg(KZG, KZG_SHA, 'block')
        fork.el[1004]['stateRoot'] = h32('fork-state')
        TCG.seal(fork.el[1004], fork.receipts[1004], sealer)
        sealer.close()
        fork.blinded[fork.slots[1004]]['data']['message']['body']['execution_payload_header']['block_hash'] = fork.el[1004]['hash']
        self.srv.chain = fork                                 # same endpoint URL: only the chain behind it changes between runs
        d0, S0 = self.run_seg(0)                              # each segment alone is COVERED on its own chain
        self.srv.chain = self.chain
        d1, S1 = self.run_seg(1)
        self.assertEqual((S0['gateVerdict'], S1['gateVerdict']), ('COVERED', 'COVERED'))
        self.refused('el-discontinuity-at-boundary', [d0, d1])

    def test_cl_discontinuity_across_a_boundary_is_refused(self):
        self.setup_chain()
        fork = copy.deepcopy(self.chain)
        fork.blinded[fork.slots[1005]]['data']['message']['parent_root'] = h32('fork-root')
        d0, _ = self.run_seg(0)
        self.srv.chain = fork                                 # same endpoint URL
        d1, S1 = self.run_seg(1)
        self.assertEqual(S1['gateVerdict'], 'COVERED')        # the gate starts each range with no previous root
        self.refused('cl-discontinuity-at-boundary', [d0, d1])

    def test_partial_duplicate_stale_tampered_and_foreign_segments_are_refused(self):
        self.setup_chain()
        d0, _ = self.run_seg(0)
        d1, S1 = self.run_seg(1)
        self.refused('partial-coverage', [d0])
        d0b, _ = self.run_seg(0)
        self.refused('duplicate-segment', [d0, d0b, d1])
        self.refused('stale-segment', [d0, d1], now=S1['finishedAt'] + SG.MAX_EVIDENCE_AGE + 61)
        with self.assertRaises(SG.Refused):
            self.agg([d0, d1], max_age=SG.MAX_EVIDENCE_AGE + 1)  # the freshness window cannot be widened
        other = self.path('plan-other.json')                  # same content, different creation time: a different plan
        with open(other, 'w') as f:
            json.dump(dict(self.plan, createdAt=self.plan['createdAt'] - 1), f)
        self.refused('segment-from-other-plan', [d0, d1], plan=other)
        g = os.path.join(d1, 'gate-report.json')
        orig = self.path('gate-report.orig')
        shutil.copy(g, orig)
        G = json.load(open(g)); G['counts']['blobsVerified'] += 1
        with open(g, 'w') as f:
            json.dump(G, f)
        self.refused('gate-report-tampered', [d0, d1])
        shutil.copy(orig, g)
        self.assertEqual(self.agg([d0, d1])['verdict'], 'COVERED_ALL_SEGMENTS')
        srv2, url2 = serve(self.chain)                        # a second, different L1 endpoint for one segment
        self.servers.append(srv2)
        d1b, _ = self.run_seg(1, url2)
        self.refused('endpoint-mismatch', [d0, d1b])
        d1c, _ = self.run_seg(1, scope='all')                 # mixed blob scopes are not one coverage
        self.refused('endpoint-mismatch', [d0, d1c])

    def test_a_refused_segment_keeps_the_gate_per_block_refusal(self):
        self.setup_chain()
        self.chain.blob_status[self.chain.slots[1005]] = (404, {'message': 'Insufficient data columns'})
        d1, S1 = self.run_seg(1)
        self.assertEqual((S1['gateRc'], S1['gateRefusal']['code']), (3, 'missing-data'))
        self.chain.blob_status.clear()
        self.chain.el[1001]['stateRoot'] = h32('evil')
        d0, S0 = self.run_seg(0)
        self.assertEqual((S0['gateRc'], S0['gateRefusal']['code']), (3, 'data-mismatch'))
        self.refused('segment-not-covered', [d0, d1])

    def test_plan_gap_overlap_and_cap_are_refused_everywhere(self):
        self.setup_chain()
        d0, _ = self.run_seg(0)
        d1, _ = self.run_seg(1)
        for segs in ([[1000, 1004], [1004, 1008]], [[1000, 1004], [1006, 1008]], [[1000, 1004], [1005, 1007]],
                     [[1001, 1004], [1005, 1008]], [[1000, 1003], [1004, 1008]]):
            bad = self.path('plan-bad.json')
            with open(bad, 'w') as f:
                json.dump(dict(self.plan, segments=[{'index': i, 'from': a, 'to': b} for i, (a, b) in enumerate(segs)]), f)
            self.refused('plan-invalid', [d0, d1], plan=bad)
            with self.assertRaises(SG.Refused) as cm:
                self.run_seg(0, plan=bad)
            self.assertEqual(cm.exception.code, 'plan-invalid')
        cg, _ = SG.load_gate()
        self.assertEqual((cg.HARD_MAX_BLOCKS, SG.HARD_MAX_BLOCKS), (30000, 30000))
        big = dict(self.plan, needFrom=0, l1Origin=dict(self.plan['l1Origin'], number=4), toBlock=30000, blocks=30001,
                   segments=[{'index': 0, 'from': 0, 'to': 30000}])
        with self.assertRaisesRegex(SG.Refused, 'length outside'):
            SG.validate_plan(big, SG.HARD_MAX_BLOCKS)

    # ---- the L1 origin binding (root review 1145) -----------------------------------------------------------------------

    def test_swapped_valid_canonical_origin_is_refused(self):
        # header N is genuinely 1004's child; the DB deposit names canonical 1003 (valid hash, every segment COVERED)
        self.setup_chain(seq_window=2, origin=1003, true_origin=1004, seg_blocks=4)
        dirs, S = zip(*(self.run_seg(i) for i in (0, 1)))
        self.assertEqual([s['gateVerdict'] for s in S], ['COVERED', 'COVERED'])
        e = self.refused('origin-not-bound-to-anchor-header', list(dirs))
        self.assertIn('1003', e.detail)

    def test_same_prev_randao_different_parent_beacon_root_is_refused(self):
        # an L1 chain where 1003 carries 1004's prevRandao: the hinted 1003 matches mixHash, only the beacon parent root differs
        chain = reseal(TCG.Chain(), FIRST)
        reseal(chain, 1003, {1003: {'mixHash': chain.el[1004]['mixHash']}})
        self.assertEqual(chain.el[1003]['mixHash'], chain.el[1004]['mixHash'])
        self.setup_chain(seq_window=2, origin=1003, true_origin=1004, chain=chain, seg_blocks=4)
        self.assertEqual(self.plan['anchor']['mixHash'], chain.el[1003]['mixHash'])
        dirs = [self.run_seg(i)[0] for i in (0, 1)]
        self.refused('origin-not-bound-to-anchor-header', dirs)

    def test_wrong_header_parent_beacon_root_or_mix_is_refused(self):
        for kw in ({'pbr': h32('wrong-pbr')}, {'mix': h32('wrong-mix')}):
            self.setup_chain(**kw)                            # header N binds to its (synthetic) receipt; deposit names real 1004
            self.refused('origin-not-bound-to-anchor-header', [self.run_seg(i)[0] for i in (0, 1)])

    def test_non_canonical_origin_hash_is_refused_by_every_segment(self):
        self.setup_chain(origin_hash=h32('fork-origin'))
        d0, S0 = self.run_seg(0)
        d1, S1 = self.run_seg(1)
        self.assertEqual((S0['gateRefusal']['code'], S1['gateRefusal']['code']), ('origin-not-canonical', 'origin-not-canonical'))
        self.refused('segment-not-covered', [d0, d1])

    def test_wrong_header_number_hash_pbr_and_tampered_documents_are_refused(self):
        self.setup_chain()
        dirs, A = self.covered()
        doc = json.load(open(self.anchored))
        for mutate, code in ((lambda d: d['header']['raw'].update(number=hex(F.N + 1)), 'anchor-binding'),
                             (lambda d: d['header'].update(number=F.N + 1), 'anchor-binding'),
                             (lambda d: d['header'].update(hash=h32('x')), 'anchor-binding'),
                             (lambda d: d['header'].update(parentBeaconBlockRoot=h32('x')), 'anchor-binding'),
                             (lambda d: d['header']['raw'].update(parentBeaconBlockRoot=h32('x')), 'anchor-binding'),
                             (lambda d: d['header']['raw'].update(mixHash=h32('x')), 'anchor-binding'),
                             (lambda d: d.update(needFrom=d['needFrom'] - 1), 'anchored-format'),
                             (lambda d: d['anchor'].update(N=d['anchor']['N'] + 1), 'anchor-mismatch'),
                             (lambda d: d['header'].pop('raw'), 'anchored-format'),
                             (lambda d: d.update(format='enclave-base-snapshot-origin/v1'), 'anchored-format')):
            bad = copy.deepcopy(doc); mutate(bad)
            p = self.path('anchored-bad.json')
            with open(p, 'w') as f:
                json.dump(bad, f)
            with self.assertRaises(SG.Refused) as cm:
                SG.make_plan(p, self.a.receipt, F.NODE, FINAL, 5, pins=self.a.pins)
            self.assertEqual(cm.exception.code, code, cm.exception.detail)
            self.refused('plan-anchored-mismatch', dirs, anchored=p)   # the aggregate refuses any other anchored bytes
        tampered_plan = self.path('plan-tampered.json')       # a plan whose anchor pbr is rewritten no longer names its segments
        with open(tampered_plan, 'w') as f:
            json.dump(dict(self.plan, anchor=dict(self.plan['anchor'], parentBeaconBlockRoot=h32('x'))), f)
        self.refused('plan-anchored-mismatch', dirs, plan=tampered_plan)
        for to_block, size, code in ((1003, 5, 'to-block-below-origin'), (FINAL, 4, 'segment-size'), (FINAL, 30001, 'segment-size')):
            with self.assertRaises(SG.Refused) as cm:
                SG.make_plan(self.anchored, self.a.receipt, F.NODE, to_block, size, pins=self.a.pins)
            self.assertEqual(cm.exception.code, code)
        with self.assertRaises(SG.Refused) as cm:             # the source-pinned receipt is not this test anchor's
            SG.make_plan(self.anchored, self.a.receipt, F.NODE, FINAL, 5)
        self.assertEqual(cm.exception.code, 'receipt-not-pinned')

    # ---- batcher (root review: untrusted batcher must not select coverage) -----------------------------------------------

    def test_untrusted_batcher_never_reaches_the_gate_or_changes_coverage(self):
        self.setup_chain()
        A1 = self.covered()[1]
        self.setup_chain(batcher='1111111111111111111111111111111111111111')   # attacker-chosen batcher in the DB deposit
        self.assertEqual(self.plan['batcherHintUnauthenticated'], '0x' + '11' * 20)
        self.assertNotIn('batcher', self.plan)
        dirs, A2 = self.covered()
        for d in dirs:
            self.assertIsNone(json.load(open(os.path.join(d, 'gate-input.json')))['labels']['safe']['batcher'])
            self.assertIsNone(json.load(open(os.path.join(d, 'gate-report.json')))['batcher'])
        self.assertEqual(A1['counts'], A2['counts'])          # identical blob selection: every BATCH_INBOX blob, any sender
        all_dirs = [self.run_seg(i, scope='all')[0] for i in (0, 1)]
        A3 = self.agg(all_dirs)
        self.assertEqual((A3['blobScope'], A3['counts']['blobsVerified']), ('all', 4))   # strict superset incl. the non-inbox blob

    # ---- activation: old code fails closed; the anchored overlay re-verifies everything --------------------------------

    def acceptance_dir(self, dirs, agg, mutate=None):
        root = Path(self.path('activation'))
        cov = root / 'coverage'
        (cov / 'segments').mkdir(parents=True)
        for i, d in enumerate(dirs):
            shutil.copytree(d, cov / 'segments' / f'seg-{i}')
        f = TCA.Fixture(str(root))
        snap = dict(f.snapshot, block=53048526)
        snap['components'] = {k: v for k, v in f.snapshot['components'].items() if 'file' in v}
        manifest = dict(f.manifest, binaries={'base': self.a.sha, 'reth': 'r' * 64})
        files = {'aggregate.json': agg, 'plan.json': self.plan, 'anchored-origin.json': None, 'a1-receipt.json': None,
                 'snapshot-manifest.json': snap}
        raw = {k: TCA.dump(v) for k, v in files.items() if v is not None}
        raw['plan.json'] = open(self.plan_path, 'rb').read()
        raw['anchored-origin.json'] = open(self.anchored, 'rb').read()
        raw['a1-receipt.json'] = open(self.a.receipt, 'rb').read()
        m_raw = TCA.dump(manifest)
        (root / 'manifest.json').write_bytes(m_raw)
        cfg = copy.deepcopy(f.cfg)
        cfg['baseBootstrap'] = {'coverageVerified': True, 'mode': AA.MODE}
        rc = {'format': AA.RECEIPT_FORMAT, 'decision': 'accepted', 'kzgcheckSha256': CS.KZGCHECK_SHA256, 'baseBinarySha256': self.a.sha,
              'gateSha256': SG.GATE[1], 'baseBootstrap': {'l1Block': agg['l1Block'], 'blobSlot': agg['blobSlot']},
              'review': {'reviewer': 'root', 'gateRunner': 'rpcbase-gate', 'reviewedAt': '2026-10-26T12:00:00Z'},
              'bootstrapManifestSha256': TCA.sha(m_raw), 'snapshotManifestUrl': manifest['snapshotManifests']['base'],
              'chainConfigSha256': CS.config_identity(cfg)}
        if mutate:
            mutate(raw, rc, cfg)
        for k, n in AA.FILES.items():
            if n != 'receipt.json':
                rc.setdefault(k, TCA.sha(raw[n]))
        raw['receipt.json'] = TCA.dump(rc)
        cfg['baseBootstrap'].setdefault('anchoredCoverageAcceptance', {k: TCA.sha(raw[n]) for k, n in AA.FILES.items()})
        for n, b in raw.items():
            (cov / n).write_bytes(b)
        for p in [cov, cov / 'segments', *(cov / 'segments').iterdir()]:
            os.chmod(p, 0o755)
        for p in cov.rglob('*'):
            if p.is_file():
                os.chmod(p, 0o644)
        return cfg, root / 'manifest.json', cov

    def activate(self, cfg, manifest, cov, seq_window=None):
        # The fixture L1 uses the gate tests' small window (SG.SEQ_WINDOW); production BASE_SEQ_WINDOW is 3600. The window is
        # patched to the fixture's, exactly as test_coverage_gate.py patches cg.SEQ_WINDOW; the mismatch case is asserted separately.
        with mock.patch.object(CS, 'BASE_SEQ_WINDOW', SG.SEQ_WINDOW if seq_window is None else seq_window):
            return AA.anchored_coverage_activation(CS, cfg, manifest, self.a.sha, cov, owner=os.getuid(),
                                                   a1_sha256=self.a.pins['receipt'][1])

    def test_old_activation_code_rejects_every_new_document(self):
        self.assertEqual(hashlib.sha256(open(os.path.join(OPS, 'chain_service.py'), 'rb').read()).hexdigest(),
                         '75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92')
        self.setup_chain()
        dirs, A = self.covered()
        G = json.load(open(os.path.join(dirs[0], 'gate-report.json')))
        anch = json.load(open(self.anchored))
        for verdict, origin in ((A, anch), (G, anch), (A, None), (G, None)):
            root = self.path('old')
            os.makedirs(root)                                 # Fixture.write creates only <root>/coverage
            f = TCA.Fixture(root)
            f.verdict = verdict
            if origin is not None:
                f.origin = origin
            f.write()
            with self.assertRaises(AssertionError):
                f.check()
        cfg, manifest, cov = self.acceptance_dir(dirs, A)
        with self.assertRaisesRegex(AssertionError, 'acceptance hashes missing'):
            CS.coverage_activation(cfg, manifest, self.a.sha, directory=cov, owner=os.getuid())

    def test_anchored_overlay_accepts_only_fully_re_verified_evidence(self):
        self.setup_chain()
        dirs, A = self.covered()
        got = self.activate(*self.acceptance_dir(dirs, A))
        self.assertEqual((got['mode'], got['l1Block'], got['blobSlot'], got['anchor']['N'], got['l1Origin']['number']),
                         (AA.MODE, FIRST, self.chain.slots[1002], F.N, 1004))
        self.assertIn('NOT consensus authority', got['qualification'])
        with self.assertRaisesRegex(AssertionError, r'l1Origin\(N\) - 3600'):   # a range not built with the production window
            self.activate(*self.acceptance_dir(dirs, A), seq_window=3600)

        def tamper_agg(raw, rc, cfg):                          # re-pinned everywhere, but not what the evidence re-aggregates to
            raw['aggregate.json'] = TCA.dump(dict(A, counts=dict(A['counts'], blobsVerified=99)))
        with self.assertRaisesRegex(AssertionError, 'differs from the re-aggregated'):
            self.activate(*self.acceptance_dir(dirs, A, tamper_agg))

        def foreign_a1(raw, rc, cfg):
            raw['a1-receipt.json'] = raw['a1-receipt.json'] + b' '
        with self.assertRaisesRegex(AssertionError, 'A1 receipt'):
            self.activate(*self.acceptance_dir(dirs, A, foreign_a1))

        def anchored_swap(raw, rc, cfg):
            d = json.loads(raw['anchored-origin.json']); d['header']['parentBeaconBlockRoot'] = h32('x')
            raw['anchored-origin.json'] = TCA.dump(d)
        with self.assertRaisesRegex(AssertionError, 'plan does not bind'):
            self.activate(*self.acceptance_dir(dirs, A, anchored_swap))

        def wrong_slot(raw, rc, cfg):
            rc['baseBootstrap'] = dict(rc['baseBootstrap'], blobSlot=A['blobSlot'] + 1)
        with self.assertRaisesRegex(AssertionError, 'bindings disagree'):
            self.activate(*self.acceptance_dir(dirs, A, wrong_slot))

        def self_review(raw, rc, cfg):
            rc['review'] = dict(rc['review'], gateRunner='root')
        with self.assertRaisesRegex(AssertionError, 'not independent'):
            self.activate(*self.acceptance_dir(dirs, A, self_review))

        cfg, manifest, cov = self.acceptance_dir(dirs, A)     # a missing segment, then an edited gate report
        shutil.rmtree(cov / 'segments' / 'seg-1')
        with self.assertRaisesRegex(AssertionError, 'partial-coverage'):
            self.activate(cfg, manifest, cov)
        cfg, manifest, cov = self.acceptance_dir(dirs, A)
        g = cov / 'segments' / 'seg-1' / 'gate-report.json'
        g.write_bytes(g.read_bytes().replace(b'"COVERED"', b'"COVERED" '))
        with self.assertRaisesRegex(AssertionError, 'gate-report-tampered'):
            self.activate(cfg, manifest, cov)
        cfg, manifest, cov = self.acceptance_dir(dirs, A)
        os.chmod(cov / 'segments' / 'seg-0' / 'segment.json', 0o666)
        with self.assertRaisesRegex(AssertionError, 'operator-owned'):
            self.activate(cfg, manifest, cov)


class RealScalePlanTest(unittest.TestCase):
    """Production SEQ_WINDOW 3600 and the probe-2 HINT numbers (not the exact origin): 2 segments, each under the unchanged 30000 cap."""

    def test_hint_scale_range_is_split_not_capped_up(self):
        a = F.AnchorDB(26235784, h32('hint-origin'))
        try:
            p = os.path.join(a.tmp.name, 'anchored.json')
            with open(p, 'w') as f:
                json.dump(a.extract(), f)
            P = SG.make_plan(p, a.receipt, F.NODE, 26276116, 30000, pins=a.pins)
            self.assertEqual((P['needFrom'], P['blocks']), (26232184, 43933))
            self.assertEqual([(s['from'], s['to']) for s in P['segments']], [(26232184, 26254150), (26254151, 26276116)])
            self.assertTrue(all(s['to'] - s['from'] + 1 <= 30000 for s in P['segments']))
        finally:
            a.close()


if __name__ == '__main__':
    unittest.main()
