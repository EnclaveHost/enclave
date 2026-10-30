"""r3/r4 integration (r4: current-time freshness): the PATCHED r14 wrapper (chain_service.base_coverage) and the PATCHED r14 readiness_sampler / publish_readiness accept
exactly the same N-anchored coverage evidence, built end-to-end here (fake DB -> anchored_origin -> plan -> 2 gate segments over the
pinned gate's fake L1 -> aggregate), installed root-owned (test uid) with the pinned verifier library, and both refuse the same tampering.

Env: KZGCHECK, NODE (as test_segments), READINESS_DIR = a private dir holding the patched readiness_sampler.py + publish_readiness.py and
the UNMODIFIED r14 test_readiness_sampler.py (its synthetic loopback L1/Base harness is reused for the READY path)."""
import argparse, copy, hashlib, json, os, shutil, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import anchor_fixture as F  # noqa: E402
from anchor_fixture import AO, h32  # noqa: E402
import segments as SG  # noqa: E402
import test_segments as TS  # noqa: E402   (reuses its pinned gate fixture, reseal() and serve(); its tests are not collected here)

STAGE = HERE.parent
SRC = STAGE / 'src'
WRAPPER = STAGE / 'overlay' / 'wrapper' / 'chain_service.py'
sys.path.insert(0, os.environ['READINESS_DIR'])
import test_readiness_sampler as TRS  # noqa: E402   (r14, unmodified; imports the patched readiness_sampler beside it)
RS = TRS.rs
import publish_readiness as PUB  # noqa: E402

_manifest0 = {'mounts': {'l1': '/srv/enclave-l1-pair', 'base': '/srv/enclave-base-holder'}, 'binaries': {}}
_disks0 = {'disks': [{'role': r, 'mount': m, 'uuid': 'expected'} for r, m in _manifest0['mounts'].items()]}
with patch.object(Path, 'read_text', lambda p, *a, **k: json.dumps(_disks0 if str(p).endswith('disks.json') else _manifest0
                                                                 if str(p).endswith('manifest.json') else {'checkpoint': {'stateTime': 0}})):
    import importlib.util
    _spec = importlib.util.spec_from_file_location('chain_service_r3', WRAPPER)
    W = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(W)

SEQ = 4                              # the pinned gate fixture's window (test_coverage_gate patches cg.SEQ_WINDOW the same way)
NR = 49500                           # anchor block N inside the readiness harness's served Base range
ORIGIN = 1004
LIB_FILES = ('anchored_origin.py', 'segments.py', 'anchored_acceptance.py')
SNAPSHOT_PROFILE = ('[prune]\nblock_interval = 5\n\n[prune.segments]\nsender_recovery = "full"\ntransaction_lookup = "full"\n\n'
                    + ''.join(f'[prune.segments.{n}]\ndistance = 140000\n\n' for n in ('receipts', 'account_history', 'storage_history', 'bodies_history'))
                    + '[static_files.blocks_per_file]\nheaders = 500000\n')
dump = lambda d: json.dumps(d, indent=1, sort_keys=True).encode()   # noqa: E731
sha = lambda b: hashlib.sha256(b).hexdigest()                       # noqa: E731


class Executed(Exception):
    pass


def windows(fn):
    """Run the loaded verifier with the fixture window (production 3600 is asserted elsewhere to refuse this evidence)."""
    def wrapped(owner):
        aa = fn(owner)
        aa.SG.SEQ_WINDOW = SEQ
        return aa
    return wrapped


class Evidence:
    """Built once: real anchored origin + plan + two COVERED gate segments + aggregate for anchor block NR."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = (SG.SEQ_WINDOW, AO.SEQ_WINDOW)
        SG.SEQ_WINDOW = AO.SEQ_WINDOW = SEQ
        self.chain = TS.reseal(TS.TCG.Chain(), TS.FIRST)
        self.srv, url = TS.serve(self.chain)
        o = self.chain.el[ORIGIN]
        self.a = F.AnchorDB(ORIGIN, o['hash'], mix=o['mixHash'], pbr=o['parentBeaconBlockRoot'], n=NR)
        w = Path(self.tmp.name)
        self.anchored, self.plan = w / 'anchored-origin.json', w / 'plan.json'
        self.anchored.write_text(json.dumps(self.a.extract()))
        self.plan.write_text(json.dumps(SG.make_plan(str(self.anchored), self.a.receipt, F.NODE, TS.FINAL, 5, pins=self.a.pins)))
        self.dirs = []
        for i in (0, 1):
            d = str(w / f'seg{i}')
            S = SG.run_segment(str(self.plan), i, d, url, url, TS.KZG, TS.KZG_SHA, ['--rps', '500'])
            assert S['gateVerdict'] == 'COVERED', S
            self.dirs.append(d)
        self.agg = SG.aggregate(str(self.plan), str(self.anchored), self.dirs)
        self.a1_sha = self.a.pins['receipt'][1]

    def close(self):
        SG.SEQ_WINDOW, AO.SEQ_WINDOW = self.saved
        self.srv.shutdown(); self.srv.server_close()
        self.a.close(); self.tmp.cleanup()


class Installed:
    """A private root: lib/anchored-coverage (pinned verifier bytes), coverage/ evidence, manifest.json; all test-uid owned, 0755/0644.
    `edit(files, segs)` may change evidence bytes BEFORE the receipt and the operator pins are computed (re-pinned tampering)."""

    def __init__(self, ev, base_dir, edit=None):
        self.root = Path(tempfile.mkdtemp(dir=base_dir))
        self.lib, self.cov = self.root / 'lib' / 'anchored-coverage', self.root / 'coverage'
        self.lib.mkdir(parents=True)
        for f in LIB_FILES:
            shutil.copy(SRC / f, self.lib / f)
        segs = {}
        for i, d in enumerate(ev.dirs):
            segs[f'seg-{i}'] = {f: Path(d, f).read_bytes() for f in ('segment.json', 'gate-report.json', 'gate-input.json')}
        fx = TS.TCA.Fixture(str(self.root))
        snap = dict(fx.snapshot, block=53_048_526)
        snap['components'] = {k: v for k, v in fx.snapshot['components'].items() if 'file' in v}
        self.manifest = dict(fx.manifest, binaries={'base': ev.a.sha, 'reth': 'r' * 64})
        files = {'aggregate.json': dump(ev.agg), 'plan.json': ev.plan.read_bytes(), 'anchored-origin.json': ev.anchored.read_bytes(),
                 'a1-receipt.json': Path(ev.a.receipt).read_bytes(), 'snapshot-manifest.json': dump(snap)}
        if edit:
            edit(files, segs)
        m_raw = dump(self.manifest)
        (self.root / 'manifest.json').write_bytes(m_raw)
        self.cfg = {'checkpoint': {'root': h32('cp'), 'epoch': 1}, 'txForwarding': {'endpoint': None},
                    'baseRetention': {'historyFromBlock': 48_000_000, 'stateHistoryFromBlock': 52_500_000},
                    'baseBootstrap': {'coverageVerified': True, 'mode': 'anchored-segments'}}
        rc = {'format': 'enclave-base-anchored-coverage-acceptance/v1', 'decision': 'accepted',
              'kzgcheckSha256': W.KZGCHECK_SHA256, 'baseBinarySha256': ev.a.sha, 'gateSha256': SG.GATE[1],
              'baseBootstrap': {'l1Block': ev.agg['l1Block'], 'blobSlot': ev.agg['blobSlot']},
              'review': {'reviewer': 'root', 'gateRunner': 'rpcbase-gate', 'reviewedAt': '2026-10-26T12:00:00Z'},
              'bootstrapManifestSha256': sha(m_raw), 'snapshotManifestUrl': self.manifest['snapshotManifests']['base'],
              'chainConfigSha256': W.config_identity(self.cfg),
              **{k: sha(files[n]) for k, n in W_FILES.items() if n != 'receipt.json'}}
        files['receipt.json'] = dump(rc)
        self.receipt = rc
        self.cfg['baseBootstrap']['anchoredCoverageAcceptance'] = {k: sha(files[n]) for k, n in W_FILES.items()}
        (self.cov / 'segments').mkdir(parents=True)
        for n, b in files.items():
            (self.cov / n).write_bytes(b)
        for name, fs in segs.items():
            (self.cov / 'segments' / name).mkdir()
            for f, b in fs.items():
                (self.cov / 'segments' / name / f).write_bytes(b)
        for p in [self.root, *self.root.rglob('*')]:
            os.chmod(p, 0o755 if p.is_dir() else 0o644)
        self.receipt_sha = sha(files['receipt.json'])


W_FILES = {'receiptSha256': 'receipt.json', 'aggregateSha256': 'aggregate.json', 'planSha256': 'plan.json',
           'anchoredOriginSha256': 'anchored-origin.json', 'a1ReceiptSha256': 'a1-receipt.json', 'snapshotManifestSha256': 'snapshot-manifest.json'}

# Every tampering case both consumers must refuse, with the shared core's code. Post-install edits are not re-pinned; the `edit`
# cases are re-pinned everywhere (receipt + operator pins), so only the deeper verification can catch them.
def _seg_json(segs, name, f):
    d = json.loads(segs[name]['segment.json']); f(d); segs[name]['segment.json'] = dump(d)


def _wrong_origin(files, segs):     # the recorded L1 origin block claims a different (canonical-looking) block's linkage
    _seg_json(segs, 'seg-0', lambda d: d['originBlock'].update(beaconParentRoot=h32('other-parent'), parentBeaconBlockRoot=h32('other-parent')))


def _stale(files, segs):            # segment evidence older than the plan / the 12 h window
    for n in segs:
        _seg_json(segs, n, lambda d: d.update(startedAt=d['startedAt'] - 13 * 3600, finishedAt=d['finishedAt'] - 13 * 3600))


def _future(files, segs):
    a = json.loads(files['aggregate.json']); a['evaluatedAt'] = time.time() + 3600; files['aggregate.json'] = dump(a)


def _foreign_a1(files, segs):
    files['a1-receipt.json'] += b' '


def _anchored_origin_swapped(files, segs):
    d = json.loads(files['anchored-origin.json']); d['l1Origin']['number'] = ORIGIN - 1; files['anchored-origin.json'] = dump(d)


REPINNED = [('wrong-origin', _wrong_origin, 'segments-origin-not-bound-to-anchor-header'), ('stale', _stale, 'segments-stale-segment'),
            ('future', _future, 'aggregate-evaluation-invalid'), ('foreign-a1', _foreign_a1, 'foreign-a1'),
            ('anchored-origin-swapped', _anchored_origin_swapped, 'plan-anchored-mismatch')]


def _missing_segment(inst):
    shutil.rmtree(inst.cov / 'segments' / 'seg-1')


def _tampered_gate_report(inst):
    g = inst.cov / 'segments' / 'seg-1' / 'gate-report.json'
    os.chmod(g, 0o644); g.write_bytes(g.read_bytes().replace(b'"COVERED"', b'"COVERED" '))


def _writable_evidence(inst):
    os.chmod(inst.cov / 'aggregate.json', 0o666)


def _writable_segment(inst):
    os.chmod(inst.cov / 'segments' / 'seg-0' / 'gate-report.json', 0o664)


def _extra_segment_file(inst):
    (inst.cov / 'segments' / 'seg-0' / 'note.txt').write_bytes(b'x'); os.chmod(inst.cov / 'segments' / 'seg-0' / 'note.txt', 0o644)


POST = [('missing-segment', _missing_segment, 'segments-partial-coverage'), ('tampered-gate-report', _tampered_gate_report, 'segments-gate-report-tampered'),
        ('writable-evidence', _writable_evidence, 'evidence-not-protected'), ('writable-segment', _writable_segment, 'evidence-not-protected'),
        ('extra-segment-file', _extra_segment_file, 'segment-evidence')]


class Common(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ev = Evidence()

    @classmethod
    def tearDownClass(cls):
        cls.ev.close()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = (SG.SEQ_WINDOW, AO.SEQ_WINDOW)
        SG.SEQ_WINDOW = AO.SEQ_WINDOW = SEQ
        self.addCleanup(lambda: (setattr(SG, 'SEQ_WINDOW', self.saved[0]), setattr(AO, 'SEQ_WINDOW', self.saved[1])))

    def install(self, edit=None):
        return Installed(self.ev, self.tmp, edit)

    # ---- the wrapper consumer -----------------------------------------------------------------------------------------
    def wrapper(self, inst, cfg=None, seq=SEQ):
        uid = os.getuid()
        with patch.object(W, 'ANCHORED_COVERAGE_LIB', inst.lib), patch.object(W, 'COVERAGE_DIR', inst.cov), \
                patch.object(W, 'ROOT_UID', uid), patch.object(W, 'TRUSTED_TOP', inst.root), \
                patch.object(W, 'ANCHORED_A1_SHA256', self.ev.a1_sha), patch.object(W, 'BASE_SEQ_WINDOW', seq), \
                patch.object(W, '_anchored_overlay', windows(W._anchored_overlay)):
            return W.base_coverage(inst.cfg if cfg is None else cfg, inst.root / 'manifest.json', self.ev.a.sha)

    # ---- the readiness consumer ---------------------------------------------------------------------------------------
    def readiness_ns(self, inst, **over):
        ns = dict(coverage_anchored_dir=str(inst.cov), expect_anchored_receipt_sha256=inst.receipt_sha,
                  expect_snapshot_manifest_sha256=inst.receipt['snapshotManifestSha256'],
                  expect_chain_config_sha256=inst.receipt['chainConfigSha256'], expect_kzg_sha256=TS.KZG_SHA,
                  expect_base_sha256=self.ev.a.sha, coverage_owner_uid=os.getuid(),
                  coverage_receipt=None, coverage_verdict=None, coverage_origin=None)
        ns.update(over)
        return argparse.Namespace(**ns)

    def readiness_patches(self, inst):
        return [patch.object(RS, 'ANCHORED_COVERAGE_LIB', str(inst.lib)), patch.object(RS, 'ANCHORED_A1_SHA256', self.ev.a1_sha),
                patch.object(RS, 'ANCHORED_SEQ_WINDOW', SEQ), patch.object(RS, '_anchored_lib', windows(RS._anchored_lib))]

    def readiness(self, inst, **over):
        ps = self.readiness_patches(inst)
        for p in ps:
            p.start()
        try:
            return RS.validate_coverage_files(self.readiness_ns(inst, **over))
        finally:
            for p in reversed(ps):
                p.stop()


class WrapperAnchoredTests(Common):
    def test_anchored_mode_accepts_the_complete_bound_evidence(self):
        inst = self.install()
        b, so = self.wrapper(inst)
        self.assertEqual((b['mode'], b['anchor']['N'], b['anchor']['headerHash'], so),
                         ('anchored-segments', NR, self.ev.a.hash, {'number': ORIGIN, 'hash': self.ev.chain.h(ORIGIN)}))
        self.assertEqual((b['l1Block'], b['toBlock'], b['blobSlot']), (ORIGIN - SEQ, TS.FINAL, self.ev.chain.slots[1002]))
        self.assertIn('NOT consensus authority', b['qualification'])

    def test_production_window_refuses_fixture_sized_range(self):
        inst = self.install()                                 # the loaded verifier keeps its production SEQ_WINDOW 3600
        with self.assertRaisesRegex(AssertionError, '^plan-anchored-mismatch'):
            with patch.object(W, 'ANCHORED_COVERAGE_LIB', inst.lib), patch.object(W, 'COVERAGE_DIR', inst.cov), \
                    patch.object(W, 'ROOT_UID', os.getuid()), patch.object(W, 'TRUSTED_TOP', inst.root), \
                    patch.object(W, 'ANCHORED_A1_SHA256', self.ev.a1_sha):
                W.base_coverage(inst.cfg, inst.root / 'manifest.json', self.ev.a.sha)

    def test_every_tampering_case_is_refused(self):
        for name, f, code in POST:
            inst = self.install(); f(inst)
            with self.subTest(name), self.assertRaisesRegex(AssertionError, '^' + code):
                self.wrapper(inst)
        for name, f, code in REPINNED:
            inst = self.install(f)
            with self.subTest(name), self.assertRaisesRegex(AssertionError, '^' + code):
                self.wrapper(inst)

    def test_pins_mode_and_verifier_library(self):
        inst = self.install()
        cfg = copy.deepcopy(inst.cfg); cfg['baseBootstrap']['mode'] = 'anchored'
        with self.assertRaisesRegex(AssertionError, 'unknown baseBootstrap.mode'):
            self.wrapper(inst, cfg)
        cfg = copy.deepcopy(inst.cfg); cfg['baseBootstrap']['anchoredCoverageAcceptance']['receiptSha256'] = 'f' * 64
        with self.assertRaisesRegex(AssertionError, 'receipt-not-pinned'):
            self.wrapper(inst, cfg)
        cfg = copy.deepcopy(inst.cfg); cfg['baseBootstrap']['coverageAcceptance'] = {}
        with self.assertRaisesRegex(AssertionError, 'must not also carry'):
            self.wrapper(inst, cfg)
        cfg = copy.deepcopy(inst.cfg); cfg['checkpoint']['epoch'] = 2                 # a different reviewed chain config
        with self.assertRaisesRegex(AssertionError, 'different chain config'):
            self.wrapper(inst, cfg)
        with self.assertRaisesRegex(AssertionError, 'refuses any baseBootstrap.mode'):   # legacy path never accepts a mode
            W.coverage_activation(inst.cfg, inst.root / 'manifest.json', self.ev.a.sha, directory=inst.cov, owner=os.getuid())
        lib = inst.lib / 'segments.py'
        lib.write_bytes(lib.read_bytes() + b'\n# changed\n')
        with self.assertRaisesRegex(AssertionError, 'not the pinned bytes'):
            self.wrapper(inst)
        inst = self.install(); os.chmod(inst.lib / 'anchored_acceptance.py', 0o666)
        with self.assertRaisesRegex(AssertionError, 'non-writable'):
            self.wrapper(inst)

    def test_legacy_path_is_unchanged(self):
        with patch.object(W, 'coverage_activation', return_value={'safeL1Origin': {'number': 7, 'hash': h32('o')}}) as legacy:
            b, so = W.base_coverage({'baseBootstrap': {'coverageVerified': True}}, Path('/m'), 'a' * 64)
        legacy.assert_called_once_with({'baseBootstrap': {'coverageVerified': True}}, Path('/m'), 'a' * 64)
        self.assertEqual(so, {'number': 7, 'hash': h32('o')})
        with self.assertRaisesRegex(AssertionError, 'coverage not approved'):
            W.base_coverage({}, Path('/m'), 'a' * 64)

    # ---- the real start path: release lock, launch-record binding BEFORE the handshake consumes anything ----------------
    def start_base(self, inst, launch_anchor, lock=True):
        fd = os.open(os.devnull, os.O_RDONLY) if lock else None
        beacon = {}
        slot = str(self.ev.agg['blobSlot'])
        beacon['/eth/v2/beacon/blocks/' + slot] = {'message': {'body': {'blob_kzg_commitments': ['x']}}}
        beacon['/eth/v1/beacon/blobs/' + slot] = ['x']
        origin_hash = self.ev.chain.h(ORIGIN)
        rpc = lambda port, m, p: {'hash': origin_hash} if m == 'eth_getBlockByNumber' else []   # noqa: E731
        import contextlib
        with contextlib.ExitStack() as st:
            for name, value in (('ANCHORED_COVERAGE_LIB', inst.lib), ('COVERAGE_DIR', inst.cov), ('ROOT_UID', os.getuid()),
                                ('TRUSTED_TOP', inst.root), ('ROOT', inst.root), ('ANCHORED_A1_SHA256', self.ev.a1_sha),
                                ('BASE_SEQ_WINDOW', SEQ), ('_anchored_overlay', windows(W._anchored_overlay)), ('CONFIG', inst.cfg),
                                ('MANIFEST', inst.manifest)):
                st.enter_context(patch.object(W, name, value))
            for name, kw in (('release_launch_lock', {'return_value': fd}), ('base_release', {'return_value': '/pinned/release'}),
                             ('launch_record', {'return_value': ('l' * 64, {'anchor': launch_anchor}, NR)}),
                             ('service_identity', {'return_value': None}), ('drop_privileges', {}),
                             ('mount', {'return_value': '/srv/enclave-base-holder'}), ('binary', {'side_effect': lambda n: '/pinned/' + n}),
                             ('history_files_present', {}), ('segment_files_present', {}),
                             ('l1_ready', {'return_value': {'l1Finalized': 30000}}), ('rpc', {'side_effect': rpc}),
                             ('beacon', {'side_effect': beacon.__getitem__})):
                st.enter_context(patch.object(W, name, **kw))
            hs = st.enter_context(patch.object(W, 'launch_handshake', return_value=['--handshake']))
            # r5: these r4 start tests exercise the INITIAL anchored phase (armed); the real journal-driven phase decision is
            # covered by test_r5_continuation.py
            st.enter_context(patch.object(W, 'launch_phase', return_value=('initial', None)))
            st.enter_context(patch.object(Path, 'is_file', return_value=True))
            st.enter_context(patch.object(Path, 'read_text', return_value=SNAPSHOT_PROFILE))
            exe = st.enter_context(patch.object(W.os, 'execve', side_effect=Executed))
            self.hs = hs                                      # observable by the caller even when run() refuses
            try:
                W.run('base')
            except Executed:
                return hs, exe.call_args.args[1]
            finally:
                if lock:
                    with self.assertRaises(OSError):          # run() closed the launch lock it was given
                        os.close(fd)
            return hs, None

    def test_release_start_binds_the_launch_record_to_header_n_before_the_handshake(self):
        inst = self.install()
        hs, argv = self.start_base(inst, f'{NR}:{self.ev.a.hash}')
        hs.assert_called_once()
        self.assertEqual(argv[0], '/pinned/release')
        self.assertIn('--handshake', argv)
        with self.assertRaisesRegex(AssertionError, 'launch anchor is not the anchored-coverage header N'):
            self.start_base(inst, f'{NR}:{h32("other-block")}')
        with self.assertRaisesRegex(AssertionError, 'requires the release launch'):
            self.start_base(inst, f'{NR}:{self.ev.a.hash}', lock=False)

    def test_release_start_refuses_before_the_handshake_on_tampered_evidence(self):
        inst = self.install(); _missing_segment(inst)
        with self.assertRaisesRegex(AssertionError, 'segments-partial-coverage'):
            self.start_base(inst, f'{NR}:{self.ev.a.hash}')
        self.hs.assert_not_called()
        with self.assertRaisesRegex(AssertionError, 'launch anchor is not the anchored-coverage header N'):
            self.start_base(self.install(), f'{NR}:{h32("other-block")}')
        self.hs.assert_not_called()


class ReadinessAnchoredTests(Common):
    def test_parity_with_the_wrapper_on_good_and_every_bad_evidence(self):
        inst = self.install()
        w, so = self.wrapper(inst)
        r = self.readiness(inst)
        self.assertEqual((r['mode'], r['snapshotSafe'], r['snapshotSafeL1Origin'], r['needFromBlock'], r['toBlock'], r['blobSlot']),
                         (w['mode'], {'number': w['anchor']['N'], 'hash': w['anchor']['headerHash']}, so, w['l1Block'], w['toBlock'], w['blobSlot']))
        for name, f, code in POST + REPINNED:
            if (name, f, code) in POST:
                inst = self.install(); f(inst)
            else:
                inst = self.install(f)
            with self.subTest(name):
                with self.assertRaisesRegex(AssertionError, '^' + code):
                    self.wrapper(inst)
                with self.assertRaises(RS.Negative) as cm:
                    self.readiness(inst)
                self.assertEqual(cm.exception.code, code)

    def test_freshness_parity_at_the_current_time(self):
        """Both consumers verify at the CURRENT time: valid now -> accepted; 12 h + 61 s after the review -> expired segments refused;
        NaN / +-Infinity / boolean / future evaluatedAt -> refused. No receipt or aggregate clock is the authority."""
        inst = self.install()
        self.wrapper(inst); self.readiness(inst)              # true current time: both accept
        later = self.ev.agg['evaluatedAt'] + SG.MAX_EVIDENCE_AGE + 61
        with patch('time.time', return_value=later):
            with self.assertRaisesRegex(AssertionError, '^segments-stale-segment'):
                self.wrapper(inst)
            with self.assertRaises(RS.Negative) as cm:
                self.readiness(inst)
            self.assertEqual(cm.exception.code, 'segments-stale-segment')
        for bad in (float('nan'), float('inf'), float('-inf'), True, time.time() + 3600):
            def edit(files, segs, bad=bad):
                a = json.loads(files['aggregate.json']); a['evaluatedAt'] = bad; files['aggregate.json'] = json.dumps(a).encode()
            inst = self.install(edit)
            with self.subTest(repr(bad)):
                with self.assertRaisesRegex(AssertionError, '^aggregate-evaluation-invalid'):
                    self.wrapper(inst)
                with self.assertRaises(RS.Negative) as cm:
                    self.readiness(inst)
                self.assertEqual(cm.exception.code, 'aggregate-evaluation-invalid')

    def test_readiness_pins_mode_conflict_and_library(self):
        inst = self.install()
        for over, code in (({'expect_anchored_receipt_sha256': 'f' * 64}, 'receipt-not-pinned'),
                           ({'expect_chain_config_sha256': 'f' * 64}, 'config-identity-mismatch'),
                           ({'expect_snapshot_manifest_sha256': 'f' * 64}, 'snapshot-identity-mismatch'),
                           ({'expect_base_sha256': 'f' * 64}, 'tool-pin-mismatch'),
                           ({'coverage_receipt': '/x/receipt.json'}, 'coverage-mode-conflict')):
            with self.subTest(code), self.assertRaises(RS.Negative) as cm:
                self.readiness(inst, **over)
            self.assertEqual(cm.exception.code, code)
        with self.assertRaises(RS.Unavailable) as cm:
            self.readiness(inst, expect_anchored_receipt_sha256=None)
        self.assertEqual(cm.exception.code, 'anchored-receipt-pin-absent')
        lib = inst.lib / 'anchored_origin.py'
        lib.write_bytes(lib.read_bytes() + b'\n')
        with self.assertRaises(RS.Negative) as cm:
            self.readiness(inst)
        self.assertEqual(cm.exception.code, 'anchored-verifier-not-pinned')

    # ---- the full sampler: READY only with the anchored evidence AND the live chain serving header N + the bound origin ----
    def sampler(self, inst, serve_n=True, serve_origin=True, extra=(), finality='initial'):
        """finality='initial': the published proof is not (yet) current -> the anchored INITIAL window (fresh evidence decides);
        'current': a current recorded proof for this process -> the r5 post-bootstrap basis."""
        e = TRS.Env(samples=4)
        self.addCleanup(e.close)
        c = e.chain
        if finality == 'initial':
            extra = ('--finality-status', TRS.finality_status_file(e.tmp.name, n=1000, h=c.bhash(1000), state='pending'),
                     '--finality-status-uid', str(os.getuid()), *extra)
        if serve_n:
            bh = c.bhash
            c.bhash = lambda n: self.ev.a.hash if n == NR else bh(n)
        if serve_origin:
            lh = c.l1hash
            c.l1hash = lambda n: self.ev.chain.h(ORIGIN) if n == ORIGIN else lh(n)
        args = ['--coverage-anchored-dir', str(inst.cov), '--expect-anchored-receipt-sha256', inst.receipt_sha,
                '--expect-snapshot-manifest-sha256', inst.receipt['snapshotManifestSha256'],
                '--expect-chain-config-sha256', inst.receipt['chainConfigSha256'], '--expect-kzg-sha256', TS.KZG_SHA,
                '--expect-base-sha256', self.ev.a.sha, '--coverage-owner-uid', str(os.getuid()), *extra]
        ps = self.readiness_patches(inst)
        for p in ps:
            p.start()
        try:
            return e.run(*args)
        finally:
            for p in reversed(ps):
                p.stop()

    def test_sampler_ready_on_anchored_coverage_with_the_live_chain(self):
        inst = self.install()
        rc, r = self.sampler(inst)                         # r5: initial window -> evidence decides; no proof yet -> NOT ready
        self.assertEqual((rc, r['overall'], r['acceptance']), (4, 'INCOMPLETE', False), r['gates'])
        self.assertEqual(r['gates']['post-anchor-finality'].get('code'), 'finality-not-current')
        self.assertEqual((r['coverage']['mode'], r['coverage']['phase'], r['coverage']['snapshotSafe']['number']),
                         ('anchored-segments', 'historical-bootstrap-coverage', NR))
        self.assertEqual(r['gates']['historical-coverage']['status'], 'pass')

    def test_sampler_not_ready_when_chain_or_evidence_disagree(self):
        inst = self.install()
        rc, r = self.sampler(inst, serve_n=False)          # the running Base chain does not hold the authenticated header N
        self.assertEqual((rc, r['overall'], r['gates']['historical-coverage'].get('code')), (3, 'FAIL', 'snapshot-not-ancestor'), r['gates'])
        rc, r = self.sampler(inst, serve_origin=False)     # the bound L1 origin is not canonical on our L1
        self.assertEqual((rc, r['overall'], r['gates']['historical-coverage'].get('code')), (3, 'FAIL', 'snapshot-origin-not-canonical'))
        bad = self.install(); _missing_segment(bad)
        rc, r = self.sampler(bad)
        self.assertEqual((rc, r['overall'], r['gates']['historical-coverage'].get('code')), (3, 'FAIL', 'segments-partial-coverage'))
        rc, r = self.sampler(self.install(_stale))
        self.assertEqual((rc, r['gates']['historical-coverage'].get('code')), (3, 'segments-stale-segment'))
        self.assertIs(r['acceptance'], False)

    def test_publisher_settings_select_exactly_one_coverage_mode(self):
        d = Path(self.tmp)
        good = {'coverage-anchored-dir': '/etc/enclave-rpc/coverage', 'expect-anchored-receipt-sha256': 'a' * 64,
                'finality-status': '/run/enclave-rpc/base-finality-status.json', 'expect-snapshot-manifest-sha256': 'b' * 64,
                'expect-chain-config-sha256': 'c' * 64, 'expect-base-sha256': 'd' * 64}
        legacy = {'coverage-receipt': '/etc/enclave-rpc/coverage/receipt.json', 'coverage-verdict': '/etc/enclave-rpc/coverage/verdict.json',
                  'coverage-origin': '/etc/enclave-rpc/coverage/origin.json', 'finality-status': '/run/x.json',
                  'expect-snapshot-manifest-sha256': 'b' * 64, 'expect-chain-config-sha256': 'c' * 64}

        def load(doc):
            p = d / f's{time.monotonic_ns()}.json'
            p.write_text(json.dumps(doc)); os.chmod(p, 0o644)
            return PUB.load_settings(str(p), os.getuid())
        args = load(good)
        self.assertEqual(args[args.index('--coverage-anchored-dir') + 1], '/etc/enclave-rpc/coverage')
        self.assertIn('--expect-anchored-receipt-sha256', args)
        self.assertIn('--coverage-receipt', load(legacy))                                   # legacy settings unchanged
        for bad in ({**good, 'coverage-receipt': '/etc/enclave-rpc/coverage/receipt.json'},   # mixed modes
                    {k: v for k, v in good.items() if k != 'expect-anchored-receipt-sha256'},
                    {k: v for k, v in good.items() if k != 'finality-status'},
                    {**good, 'coverage-anchored-dir': 'relative'}):
            with self.subTest(sorted(bad)), self.assertRaises(PUB.Config):
                load(bad)


if __name__ == '__main__':
    unittest.main()
