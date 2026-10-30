"""Offline tests of producer/base_launch.py over workdirs produced by the REAL A2-A4 harness (a2-v2-release-bound a2a4.main,
driven by that stage's own fake-base fixture: no reth, no network), cross-checked by the REAL candidate wrapper
(base-wrapper-integration-stage/src/chain_service.py bootstrap_anchor_args). Root runs these; Claude did not.
Test-only substitutions: the fake checker's sha as the source v2 pin (as the harness's own BytecodeGate tests do), a fake
release binary + its sha, a test-owned trusted top, and LAUNCH_PRODUCER_REVIEWED=True inside the wrapper module only."""
import datetime, hashlib, importlib.util, json, os, pathlib, sys, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
WORK = pathlib.Path(os.environ.get('PRODUCER_WORK', '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025'))
STAGE = WORK / 'source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage'
WRAPPER = WORK / 'base-wrapper-integration-stage/src/chain_service.py'
sys.path.insert(0, str(STAGE / 'test')); sys.path.insert(0, str(HERE.parent / 'producer'))
import test_a2a4 as TA                               # the harness's own fixtures (loads ./a2a4.py of that stage)
import base_launch as P
A = TA.A
sha = lambda b: hashlib.sha256(b).hexdigest()

_m = {'mounts': {'base': '/srv/enclave-base-holder'}, 'binaries': {}}
_rt = lambda p, *a, **k: json.dumps({'disks': []} if str(p).endswith('disks.json') else _m if str(p).endswith('manifest.json') else {})
with patch.object(pathlib.Path, 'read_text', _rt):
    _s = importlib.util.spec_from_file_location('wrapper_candidate', WRAPPER); Wr = importlib.util.module_from_spec(_s); _s.loader.exec_module(Wr)
FAKE_RELEASE = b'#!/bin/false\nfake M7+M10 release (tests)\n'


class Producer(TA.Case):
    def setUp(self):
        super().setUp(); A.BYTECODE_CHECKER_V2_SHA256 = TA.REAL_V2_PIN
        self.uid = os.getuid(); self.top = self.d
        self.rel = self.d / 'opt/enclave-rpc/releases/base-m7m10-test/base'; self.rel.parent.mkdir(parents=True)
        self.rel.write_bytes(FAKE_RELEASE); self.rel.chmod(0o555); self.rel_sha = sha(FAKE_RELEASE)
        for q in [self.d / 'opt', self.d / 'opt/enclave-rpc', self.d / 'opt/enclave-rpc/releases', self.rel.parent]: q.chmod(0o755)
        (self.d / 'etc').mkdir(mode=0o755); self.out = self.d / 'etc/base-bootstrap'
        self.cov = {'evidence': {'receiptSha256': 'aa' * 32, 'verdictSha256': 'bb' * 32, 'originSha256': 'cc' * 32, 'snapshotManifestSha256': A.MANIFEST_SHA}}

    def tearDown(self):
        A.BYTECODE_CHECKER_V2_SHA256 = TA.REAL_V2_PIN; super().tearDown()

    def released(self):
        """The REAL pipeline: a2, a3, a4, bytecodes (v2 receipt), release -> m10-launch.json."""
        TA.BytecodeGate.ready(self, TA.V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        for st in ('bytecodes', 'release'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))

    def produce(self, **kw):
        args = dict(A=A, coverage=self.cov, release_path=self.rel, release_sha=self.rel_sha, harness_binary_sha=self.cfg['baseBinarySha256'],
                    owner=self.uid, top=self.top)
        args.update(kw)
        return P.produce(self.d / 'cfg.json', self.out, **args)

    def refused(self, fn, code):                      # (overrides TA.Case.refused, which runs harness steps)
        with self.assertRaises(P.Refused) as e:
            fn()
        self.assertTrue(str(e.exception).startswith(code + ':'), str(e.exception))

    def wrapper_args(self):
        lc = (self.out / 'lifecycle.json').read_bytes()
        cfg = {'baseBootstrap': {'anchorLaunch': {'launchSha256': sha((self.out / 'launch.json').read_bytes()), 'lifecycleSha256': sha(lc)}}}
        with patch.object(Wr, 'LAUNCH_PRODUCER_REVIEWED', True), patch.object(Wr, 'TRUSTED_TOP', self.top), patch.object(Wr, 'ROOT_UID', self.uid), \
                patch.object(Wr, 'BASE_RELEASE_SHA256', self.rel_sha):
            return Wr.bootstrap_anchor_args(cfg, self.rel_sha, directory=self.out, owner=self.uid)

    # ---- produce -------------------------------------------------------------------------------------------------------
    def test_produce_from_an_actual_release_and_the_wrapper_accepts_it(self):
        self.released(); r = self.produce()
        launch = json.loads((self.out / 'launch.json').read_text()); a4 = json.loads((self.d / 'work/a4-rebuilt.json').read_text())
        self.assertEqual(launch['anchor'], f'{TA.N}:{a4["blockHash"]}')
        self.assertEqual(r['launchSha256'], sha((self.out / 'launch.json').read_bytes()))
        for k, f in P.QUAL.items():
            self.assertEqual((self.out / 'qualification' / f).read_bytes(), (self.d / 'work' / f).read_bytes(), f)
            self.assertEqual(launch['qualification'][k], sha((self.d / 'work' / f).read_bytes()))
        self.assertEqual(launch['bindings']['bytecodes']['receiptVersion'], 'v2')
        self.assertFalse(list(self.out.parent.glob('.*partial*')), 'no partial directory remains')
        P.lifecycle_init(self.out, owner=self.uid, top=self.top)
        self.assertEqual(self.wrapper_args(), ['--bootstrap.anchor', launch['anchor']])

    def test_refuses_without_a_newest_successful_release(self):
        TA.BytecodeGate.ready(self, TA.V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        self.run_step('bytecodes')
        self.refused(self.produce, 'release_run')                       # no release yet
        rc, _ = self.run_step('release'); self.assertEqual(rc, 0)
        self.run_step('plan')                                            # any later harness run invalidates the release
        self.refused(self.produce, 'release_run')

    def test_tampered_records_refuse(self):
        self.released(); m = self.d / 'work/m10-launch.json'; d = json.loads(m.read_text())
        d['bootstrapAnchor'] = f'{TA.N}:0x' + '11' * 32; m.write_text(json.dumps(d))
        self.refused(self.produce, 'm10_launch')

    def test_the_real_source_pin_keeps_the_gap_open(self):
        self.released(); A.BYTECODE_CHECKER_V2_SHA256 = TA.REAL_V2_PIN    # the fake checker is not the reviewed b55e6b78...
        self.refused(self.produce, 'open_gaps')

    def test_db_or_journal_change_after_the_scan_refuses(self):
        self.released(); (self.d / 'datadir/db/mdbx.dat').write_bytes(b'changed')
        self.refused(self.produce, 'db_changed')
        self.setUp(); self.released()
        with open(self.d / 'work/mutation-journal.jsonl', 'a') as f: f.write('{"seq": 99}\n')
        self.refused(self.produce, 'bytecodes_stale')

    def test_stale_release_refuses(self):
        self.released()
        rel = json.loads(sorted((self.d / 'work').glob('run-release-*.json'))[-1].read_text())
        late = datetime.datetime.fromisoformat(rel['finishedAt']) + datetime.timedelta(seconds=self.cfg['a1MaxAgeSec'] + 5)
        self.refused(lambda: self.produce(now=late), 'stale_release')

    def test_release_binary_and_coverage_bindings(self):
        self.released()
        self.refused(lambda: self.produce(release_sha='00' * 32), 'release_binary')
        self.refused(lambda: self.produce(coverage={'evidence': dict(self.cov['evidence'], snapshotManifestSha256='00' * 32)}), 'coverage')
        self.refused(lambda: self.produce(coverage=None), 'coverage')
        real = self.rel.parent.with_name('real'); self.rel.parent.rename(real); self.rel.parent.symlink_to(real)
        self.refused(self.produce, 'path')

    def test_never_overwrites_and_needs_the_reviewed_harness_source(self):
        self.released(); self.produce()
        self.refused(self.produce, 'exists')
        self.refused(lambda: P.load_a2a4(STAGE / 'a2a4.py', pin='00' * 32), 'a2a4_source')
        self.assertEqual(P.load_a2a4(STAGE / 'a2a4.py').BYTECODE_CHECKER_V2_SHA256, TA.REAL_V2_PIN, 'the pinned harness bytes load')

    # ---- lifecycle ------------------------------------------------------------------------------------------------------
    def launched(self):
        self.released(); self.produce(); P.lifecycle_init(self.out, owner=self.uid, top=self.top)

    def test_started_lifecycle_never_replays_the_anchor(self):
        self.launched(); P.mark_started(self.out, 'first anchored start issued', owner=self.uid, top=self.top)
        with self.assertRaisesRegex(AssertionError, 'lifecycle state'):
            self.wrapper_args()
        self.refused(lambda: P.lifecycle_init(self.out, owner=self.uid, top=self.top), 'transition')
        self.assertEqual(len(list((self.out / 'lifecycle-history').glob('*.json'))), 2)

    def test_rearm_only_with_the_stopped_db_still_exactly_at_n(self):
        self.launched(); P.mark_started(self.out, 'start 1', owner=self.uid, top=self.top)
        P.rearm(self.out, self.d / 'cfg.json', A=A, owner=self.uid, top=self.top)
        self.assertEqual(self.wrapper_args()[0], '--bootstrap.anchor')
        P.mark_started(self.out, 'start 2', owner=self.uid, top=self.top)
        self.state['cp']['execution'] = TA.N + 5; self.write()           # the node advanced before it crashed
        self.refused(lambda: P.rearm(self.out, self.d / 'cfg.json', A=A, owner=self.uid, top=self.top), 'head_advanced')
        self.state['cp']['execution'] = TA.N; self.state['headersTip'] = TA.N + 1; self.state['headers'][str(TA.N + 1)] = TA.FX['header']; self.write()
        self.refused(lambda: P.rearm(self.out, self.d / 'cfg.json', A=A, owner=self.uid, top=self.top), 'head_advanced')
        self.state['headersTip'] = TA.N; self.write(); os.environ['FAKE_ACTIVE_UNIT'] = 'enclave-base-holder.service'
        with self.assertRaises(A.Refused):                               # the harness's own gate: units must be stopped
            P.rearm(self.out, self.d / 'cfg.json', A=A, owner=self.uid, top=self.top)

    def test_bootstrapped_is_held_without_a_reviewed_finality_proof(self):
        self.launched(); P.mark_started(self.out, 'start', owner=self.uid, top=self.top)
        self.assertIs(P.FINALITY_PROOF_REVIEWED, False)
        self.refused(lambda: P.record_bootstrapped(self.out, {'number': TA.N + 100}), 'hold_finality')

    def test_rollback_is_terminal(self):
        self.launched(); P.rollback(self.out, 'operator abort', owner=self.uid, top=self.top)
        for fn in (lambda: P.mark_started(self.out, 'x', owner=self.uid, top=self.top),
                   lambda: P.rearm(self.out, self.d / 'cfg.json', A=A, owner=self.uid, top=self.top),
                   lambda: P.rollback(self.out, 'again', owner=self.uid, top=self.top)):
            self.refused(fn, 'rolled_back')
        with self.assertRaisesRegex(AssertionError, 'lifecycle state'):
            self.wrapper_args()

    def test_lifecycle_tamper_and_expiry_refuse(self):
        self.released(); r = self.produce()
        launch = json.loads((self.out / 'launch.json').read_text())
        late = datetime.datetime.fromisoformat(launch['notAfter']) + datetime.timedelta(seconds=1)
        self.refused(lambda: P.lifecycle_init(self.out, owner=self.uid, top=self.top, now=late), 'stale_launch')
        P.lifecycle_init(self.out, owner=self.uid, top=self.top)
        p = self.out / 'lifecycle.json'; p.write_text(p.read_text().replace('anchor-pending', 'bootstrapped'))
        self.refused(lambda: P.mark_started(self.out, 'x', owner=self.uid, top=self.top), 'lifecycle_tamper')


if __name__ == '__main__':
    unittest.main(verbosity=2)
