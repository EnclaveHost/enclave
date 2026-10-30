"""r5: post-bootstrap restart handoff. The PATCHED wrapper's REAL run('base') over a REAL launch record, hash-chained journal, watermark
store and launch lock (the wrapper's own journal_append / watermark_append write them, as root `arm`/`record-finality`/`permit-restart`
would), faked only at the system/RPC boundary; the producer's new permit helpers with fake harness/finality tools; and the PATCHED
readiness sampler's phase decision on the r14 synthetic chain harness.

Phase rule under test (anchored mode only; legacy unchanged): armed|rearmed -> INITIAL (r4 current-time whole coverage); restart-permitted
-> CONTINUATION (the latest-floor STOPPED-DB permit + authenticated floor timestamp within the 7-day operational bound + the floor's exact
A1 L1 block canonical on our L1; no historical coverage, no N/first-blob probe); any other state refuses with nothing consumed."""
import contextlib, datetime, hashlib, json, os, shutil, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_r3_integration as I  # noqa: E402   (patched wrapper W, readiness RS/TRS, Evidence/Installed)
W, RS, TRS = I.W, I.RS, I.TRS
STAGE = HERE.parent
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location('base_launch_r5', STAGE / 'overlay/producer/base_launch.py')
P = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(P)

N = 52866960
N2 = N + 3000
H = lambda t: '0x' + hashlib.sha256(str(t).encode()).hexdigest()     # noqa: E731
REL = 'e' * 64
A1L1 = {'number': 26276000, 'hash': H('a1-l1')}
DAY = 86400


class Executed(Exception):
    pass


class Tree:
    """A private root: etc/base-bootstrap (launch.json, qualification/, journal/, journal.lock), etc/wm (watermark), srv/data/db/mdbx.dat."""

    def __init__(self, base_dir, upto='restart-permitted', permit=None, legacy=False):
        self.root = Path(tempfile.mkdtemp(dir=base_dir)); self.uid = os.getuid()
        self.bd, self.wm = self.root / 'etc/base-bootstrap', self.root / 'etc/wm'
        (self.bd / 'qualification').mkdir(parents=True); self.wm.mkdir(parents=True)
        self.datadir = self.root / 'srv/data'; (self.datadir / 'db').mkdir(parents=True)
        (self.datadir / 'db/mdbx.dat').write_bytes(b'db')
        self.anchor = f'{N}:{H("block-n")}'
        q = {'m10LaunchSha256': ('m10-launch.json', {'bootstrapAnchor': self.anchor}), 'a2Sha256': ('a2-authenticated.json', {'a2': 1}),
             'a4Sha256': ('a4-rebuilt.json', {'a4': 1})}
        shas = {}
        for k, (f, doc) in q.items():
            b = json.dumps(doc).encode(); (self.bd / 'qualification' / f).write_bytes(b); shas[k] = hashlib.sha256(b).hexdigest()
        b = json.dumps({'a4Sha256': shas['a4Sha256']}).encode(); (self.bd / 'qualification/bytecodes-verified.json').write_bytes(b)
        shas['bytecodesVerifiedSha256'] = hashlib.sha256(b).hexdigest()
        st = os.stat(self.datadir / 'db/mdbx.dat')
        launch = {'format': W.LAUNCH_FORMAT, 'baseReleaseSha256': REL, 'anchor': self.anchor, 'qualification': shas,
                  'notAfter': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=30)).isoformat(),
                  'bindings': {'datadir': str(self.datadir), 'dbIdentity': {'mdbx': {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size,
                                                                                  'mtimeNs': st.st_mtime_ns}}}}
        lb = json.dumps(launch).encode(); (self.bd / 'launch.json').write_bytes(lb); self.lsha = hashlib.sha256(lb).hexdigest()
        (self.bd / 'journal').mkdir()
        fd = os.open(self.bd / 'journal.lock', os.O_CREAT | os.O_WRONLY, 0o600); os.close(fd)
        for p in [self.root, *self.root.rglob('*')]:
            if p.name != 'journal.lock':
                os.chmod(p, 0o755 if p.is_dir() else 0o644)
        self.cfg = {'baseBootstrap': {'coverageVerified': True, 'anchorLaunch': {'launchSha256': self.lsha}},
                    'baseRetention': {'historyFromBlock': 48_000_000, 'stateHistoryFromBlock': 52_500_000}}
        if not legacy:
            self.cfg['baseBootstrap']['mode'] = 'anchored-segments'
        with self.patched():
            self.build(upto, permit)

    def patched(self):
        st = contextlib.ExitStack()
        for name, v in (('TRUSTED_TOP', self.root), ('ROOT_UID', self.uid), ('BOOTSTRAP_DIR', self.bd), ('BOOTSTRAP_WATERMARK', self.wm),
                        ('BOOTSTRAP_ARCHIVE', self.root / 'etc/no-archive'), ('BASE_RELEASE_SHA256', REL), ('CONFIG', self.cfg),
                        ('LAUNCH_PRODUCER_REVIEWED', True)):
            st.enter_context(patch.object(W, name, v))
        return st

    def journal(self):
        return W.journal_entries(self.bd / 'journal', self.uid, self.lsha, self.root)

    def append(self, event, evidence):
        W.journal_append(self.bd / 'journal', self.uid, self.lsha, self.journal() if os.listdir(self.bd / 'journal') else [], event, evidence,
                         'at', self.root)

    def build(self, upto, permit):
        order = ['armed', 'consumed', 'bootstrapped', 'restart-permitted']
        steps = order[:order.index(upto) + 1] if upto in order else order[:3] + [upto] if upto in ('restarted', 'finality-terminal') \
            else ['armed', 'consumed', upto] if upto == 'rolled-back' else None
        assert steps, upto
        for ev in steps:
            if ev == 'bootstrapped':
                es = W.watermark_append(self.wm, self.uid, W.watermark_entries(self.wm, self.uid, self.root), N2, H('floor'), 'finality-proof',
                                        'ab' * 32, 'at', self.root)
                self.floor = {'entrySha256': es[-1][0], 'number': N2, 'blockHash': H('floor')}
                self.append('bootstrapped', {'watermarkEntrySha256': es[-1][0], 'finalityEntrySha256': 'ab' * 32, 'number': N2, 'blockHash': H('floor')})
            elif ev in ('restart-permitted', 'restarted'):
                if ev == 'restarted':
                    self.append('restart-permitted', self.permit_evidence({}))
                    self.append('restarted', {'pid': 1})
                else:
                    self.append(ev, self.permit_evidence(permit or {}))
            else:
                self.append(ev, {'note': 'test'})

    def permit_evidence(self, over):
        st = os.stat(self.datadir / 'db/mdbx.dat')
        ev = {'floor': self.floor, 'checkpoints': {'Finish': N2 + 10}, 'mdbx': {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size,
              'mtimeNs': st.st_mtime_ns}, 'floorTimestamp': int(time.time()) - 3600, 'floorA1L1': dict(A1L1)}
        for k, v in over.items():
            if v is KeyError:
                ev.pop(k, None)
            else:
                ev[k] = v
        return ev


class WrapperPhase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.tmp, True)

    def start(self, t, l1_hash=A1L1['hash'], l1_finalized=A1L1['number'] + 100, coverage=None, legacy_cov=None, patch_base_coverage=True):
        self.cov = MagicMock(side_effect=coverage or AssertionError('segments-stale-segment: expired historical evidence'))
        self.beacon = MagicMock(side_effect=AssertionError('blob probe must not run'))
        self.legacy = MagicMock(side_effect=legacy_cov or AssertionError('legacy coverage must not run'))
        self.events = []
        rpc = lambda port, m, p: {'hash': l1_hash} if m == 'eth_getBlockByNumber' else []   # noqa: E731
        man = {'mounts': {}, 'binaries': {'base': REL}, 'baseRelease': {'path': '/pinned/release', 'sha256': REL}}
        with contextlib.ExitStack() as st:
            st.enter_context(t.patched())
            if patch_base_coverage:
                st.enter_context(patch.object(W, 'base_coverage', new=self.cov))
            for name, kw in (('MANIFEST', {'new': man}), ('mount', {'return_value': str(t.root / 'srv')}),
                             ('coverage_activation', {'new': self.legacy}), ('beacon', {'new': self.beacon}), ('rpc', {'side_effect': rpc}),
                             ('l1_ready', {'return_value': {'l1Finalized': l1_finalized}}), ('history_files_present', {}),
                             ('segment_files_present', {}), ('base_release', {'return_value': '/pinned/release'}),
                             ('binary', {'side_effect': lambda n: '/pinned/' + n}), ('service_identity', {'return_value': None}),
                             ('drop_privileges', {})):
                st.enter_context(patch.object(W, name, **kw))
            st.enter_context(patch.object(Path, 'is_file', return_value=True))
            st.enter_context(patch.object(Path, 'read_text', return_value=I.SNAPSHOT_PROFILE))
            st.enter_context(patch.dict(os.environ, {W.HANDSHAKE_ENV: '1'}))
            st.enter_context(patch.object(W.os, 'geteuid', return_value=t.uid))
            exe = st.enter_context(patch.object(W.os, 'execve', side_effect=Executed))
            before = [e[1]['event'] for e in t.journal()]
            try:
                W.run('base')
            except Executed:
                return 'exec', exe.call_args.args[1], before
            except AssertionError as e:
                return 'refused: ' + str(e), None, before
        raise AssertionError('run returned without exec')

    def states(self, t):
        with t.patched():
            return [e[1]['event'] for e in t.journal()]

    def assertRefusedNothingConsumed(self, t, want, **kw):
        r, argv, before = self.start(t, **kw)
        self.assertTrue(r.startswith('refused') and want in r, r)
        self.assertEqual(self.states(t), before, 'nothing consumed')
        return r

    def test_continuation_after_coverage_expiry_starts_without_anchor_coverage_or_blob_probe(self):
        t = Tree(self.tmp)
        r, argv, before = self.start(t)
        self.assertEqual(r, 'exec')
        self.assertNotIn('--bootstrap.anchor', argv)
        self.assertEqual(self.states(t)[-1], 'restarted')
        self.cov.assert_not_called(); self.beacon.assert_not_called(); self.legacy.assert_not_called()

    def test_expired_initial_refuses_but_the_same_evidence_does_not_block_a_continuation(self):
        t = Tree(self.tmp, upto='armed')
        self.assertRefusedNothingConsumed(t, 'segments-stale-segment')     # initial: the r4 current-time whole coverage still decides
        self.cov.assert_called_once()
        t2 = Tree(self.tmp)
        self.assertEqual(self.start(t2)[0], 'exec')                        # continuation: never consults it

    def test_continuation_floor_timestamp_and_a1_binding_refusals(self):
        now = int(time.time())
        cases = [({'floorTimestamp': now - 8 * DAY}, 'operational continuation bound'), ({'floorTimestamp': now + 3600}, 'in the future'),
                 ({'floorTimestamp': True}, 'no authenticated floor timestamp'), ({'floorTimestamp': 1.5}, 'no authenticated floor timestamp'),
                 ({'floorTimestamp': str(now)}, 'no authenticated floor timestamp'),
                 ({'floorTimestamp': KeyError, 'floorTimestampUnavailable': 'floor_time: x'}, 'floor_time'),
                 ({'floorA1L1': KeyError}, 'binds no exact A1 L1 block'), ({'floorA1L1': {'number': 1, 'hash': 'x'}}, 'binds no exact A1 L1 block'),
                 ({'floor': {'entrySha256': 'f' * 64, 'number': N2, 'blockHash': H('floor')}}, 'not for the latest recorded finality floor')]
        for over, want in cases:
            with self.subTest(over):
                self.assertRefusedNothingConsumed(Tree(self.tmp, permit=over), want)
        self.assertRefusedNothingConsumed(Tree(self.tmp), 'not canonical on this L1', l1_hash=H('fork'))
        self.assertRefusedNothingConsumed(Tree(self.tmp), 'above our L1 finalized', l1_finalized=A1L1['number'] - 1)

    def test_every_other_journal_state_refuses_with_nothing_consumed(self):
        for state in ('bootstrapped', 'consumed', 'restarted', 'finality-terminal', 'rolled-back'):
            with self.subTest(state):
                self.assertRefusedNothingConsumed(Tree(self.tmp, upto=state), f"journal state '{state}'")
        self.cov.assert_not_called()

    def test_db_changed_after_the_permit_refuses_before_consume(self):
        t = Tree(self.tmp)
        (t.datadir / 'db/mdbx.dat').write_bytes(b'restored or rolled back after the permit')
        self.assertRefusedNothingConsumed(t, 'changed since the restart permit')

    def test_partial_write_is_not_a_state_and_an_edited_entry_breaks_the_chain(self):
        t = Tree(self.tmp, upto='bootstrapped')
        p = t.bd / 'journal/.partial-4242'                 # an interrupted append of a permit: never an entry
        p.write_bytes(json.dumps({'event': 'restart-permitted'}).encode()); os.chmod(p, 0o644)
        self.assertRefusedNothingConsumed(t, "journal state 'bootstrapped'")
        t2 = Tree(self.tmp)
        first = sorted((t2.bd / 'journal').iterdir())[0]   # an edited earlier entry no longer matches its successor's prevSha256
        first.write_bytes(first.read_bytes().replace(b'"note": "test"', b'"note": "tost"'))
        r, _, _ = self.start(t2)
        self.assertTrue(r.startswith('refused') and 'journal' in r, r)

    def test_legacy_mode_keeps_the_r14_path(self):
        t = Tree(self.tmp, legacy=True)                     # no baseBootstrap.mode: the legacy coverage runs exactly as before
        r, _, _ = self.start(t, legacy_cov=AssertionError('legacy coverage evaluated'), patch_base_coverage=False)
        self.assertIn('legacy coverage evaluated', r)
        self.legacy.assert_called_once(); self.cov.assert_not_called()


class ProducerPermitHelpers(unittest.TestCase):
    def test_floor_timestamp_comes_only_from_a_well_formed_header_field(self):
        self.assertEqual(P._floor_timestamp({'timestamp': '0x6adc0000'}), 0x6adc0000)
        self.assertEqual(P._floor_timestamp({'timestamp': 1792802816}), 1792802816)
        for bad in ({'timestamp': True}, {'timestamp': 1.5}, {'timestamp': '1792802816'}, {}, {'timestamp': '0x'}, None):
            with self.subTest(bad), self.assertRaises(P.Refused):
                P._floor_timestamp(bad)

    def test_floor_a1_l1_is_the_exact_qualified_entry_of_the_floor(self):
        class F:
            class Refused(Exception):
                pass
            rows = []

            @classmethod
            def entries(cls, d, lsha, top):
                return cls.rows
        we = {'ref': 'c' * 64, 'number': N2, 'blockHash': H('floor')}
        good = {'sha': 'c' * 64, 'event': 'qualified', 'evidence': {'fresh': {'N': N2, 'blockHash': H('floor')}, 'a1': {'l1': dict(A1L1)}}}
        F.rows = [good]
        self.assertEqual(P._floor_a1_l1(F, '/x', 'l', we, '/'), A1L1)
        for rows in ([], [dict(good, event='revoked')], [dict(good, sha='d' * 64)],
                     [dict(good, evidence={'fresh': {'N': N2 - 1, 'blockHash': H('floor')}, 'a1': {'l1': dict(A1L1)}})],
                     [dict(good, evidence={'fresh': {'N': N2, 'blockHash': H('floor')}, 'a1': {'l1': {'number': True, 'hash': A1L1['hash']}}})]):
            F.rows = rows
            with self.subTest(rows), self.assertRaises(P.Refused):
                P._floor_a1_l1(F, '/x', 'l', we, '/')


class ReadinessPhase(I.Common):
    def run_sampler(self, inst, finality='current', **kw):
        return self.sampler(inst, finality=finality, **kw)

    def test_post_bootstrap_ready_with_expired_historical_evidence_and_a_current_recorded_proof(self):
        inst = self.install(I._stale)                       # historical evidence expired (segments 13 h old)
        rc, r = self.run_sampler(inst, extra=())
        self.assertEqual((rc, r['overall'], r['acceptance']), (0, 'READY', True), r['gates'])
        self.assertEqual((r['coverage']['phase'], r['coverage']['snapshotSafe']['number']), ('post-bootstrap-current-proof', 1000))
        self.assertIn('not re-verified', r['coverage']['basis'])
        self.assertIn('restartWindow', json.dumps(r['gates']['historical-coverage']))

    def test_no_current_proof_falls_back_to_the_initial_window_and_expired_evidence_fails(self):
        rc, r = self.run_sampler(self.install(I._stale), finality='initial')
        self.assertEqual((rc, r['overall'], r['gates']['historical-coverage'].get('code')), (3, 'FAIL', 'segments-stale-segment'))
        self.assertIs(r['acceptance'], False)

    def test_proof_for_another_process_is_not_current(self):
        inst = self.install(I._stale)
        rc, r = self.sampler(inst, finality=None, extra=('--finality-status', TRS.finality_status_file(self.tmp, start='1', n=1000),
                                                         '--finality-status-uid', str(os.getuid())))
        self.assertIs(r['acceptance'], False)
        self.assertNotEqual(r['gates']['post-anchor-finality']['status'], 'pass')
        self.assertEqual(r['gates']['historical-coverage'].get('code'), 'segments-stale-segment')   # initial basis, expired -> FAIL

    def test_post_bootstrap_mode_conflict_is_refused(self):
        inst = self.install()
        rc, r = self.run_sampler(inst, extra=('--coverage-receipt', '/x/receipt.json'))
        self.assertEqual(r['gates']['historical-coverage'].get('code'), 'coverage-mode-conflict')
        self.assertIs(r['acceptance'], False)


if __name__ == '__main__':
    unittest.main()
