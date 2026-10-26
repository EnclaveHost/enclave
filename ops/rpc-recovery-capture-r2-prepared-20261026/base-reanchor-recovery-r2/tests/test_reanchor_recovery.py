"""Offline tests of the R-A re-anchor recovery, r2 (base-reanchor-recovery-stage/r2). Root runs these; Claude did not.

r2: the 7 r1 tests are kept, adapted only to the explicit watermark config and the directory-shaped capture boundary; 6 new tests
cover the persisted authenticated-finality watermark, downtime refusals, crash points and gate_download on the reused DB.

The REAL pipeline: the recovery harness copy (harness/a2a4.py) drives the A2-A4 harness's own fake-base fixture (no reth, no
network); the recovery producer and wrapper copies run their real code; every start goes through the wrapper's real
run('base') with the r3 launcher suite's boundary (system/RPC faked, os.execve a fake executor). The r3 suite's Pipeline is
reused unchanged (tests/test_r3_launcher.py is byte-identical to r3); here its module globals are rebound to the recovery harness.

TEST-ONLY substitutions, each labelled where used and reset by setUp/tearDown (no production check is weakened):
  - the r3 suite's: fixture A1 recheck-mode pin, fake checker v2 pin, fake release, test-owned top/uid, LAUNCH_PRODUCER_REVIEWED
    inside the wrapper module, recorded (not performed) privilege drop;
  - BOOTSTRAP_ARCHIVE inside the wrapper module -> a test-owned archive;
  - BOOTSTRAP_WATERMARK inside the wrapper module -> a test-owned store; wm_put() stands in for a FUTURE reviewed watermark
    writer (record_finality is HOLD) using the real durable append;
  - A1_CAPTURE_VERIFIER: a FAKE verifier, ONLY in the tests that exercise a NEWER anchor. The real interface owner
    (a1-capture-binding-stage) has delivered nothing; with the real None verifier the newer-anchor path refuses (HOLD), which is
    asserted. Passing the fake-verifier tests proves only that the rest of the pipeline is consistent, NOT capture binding."""
import importlib.util, json, os, pathlib, shutil, subprocess, sys, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import test_r3_launcher as L3                        # byte-identical r3 suite: loads TA, this stage's wrapper (T.c) and producer
TA, T, P, W = L3.TA, L3.T, L3.P, L3.W
_s = importlib.util.spec_from_file_location('a2a4_recovery', ROOT / 'harness/a2a4.py')
R = importlib.util.module_from_spec(_s); _s.loader.exec_module(R)
R.TRUSTED_UID = os.getuid(); R.ALLOW_INCOMPLETE_PROC_SCAN = True      # as the fixture does for the reviewed harness
TA.A = R; L3.A = R; A = R                              # the fixture's and the r3 Pipeline's functions now drive the recovery copy
assert pathlib.Path(W.__file__).resolve() == (ROOT / 'wrapper/chain_service.py').resolve()
assert pathlib.Path(P.__file__).resolve() == (ROOT / 'producer/base_launch.py').resolve()
sha = L3.sha
N1 = TA.N                                             # the original launch anchor 52,866,960
N2 = TA.N + 3_000                                     # a newer anchor height (the observed latest anchor 52,869,960)
HEAD = TA.N + 5_000                                   # where the consumed node had run before it crashed
FX2 = json.loads(subprocess.run(['node', str(TA.H / 'test/make_fixture.mjs'), str(N2)], capture_output=True, text=True, check=True,
                                env=dict(os.environ, A=TA.ANCHOR.as_uri(), D=(TA.DEPS / 'node_modules/@noble/hashes/sha3.js').as_uri())).stdout)


class Recovery(L3.Pipeline):
    def setUp(self):
        super().setUp()
        self.assertIsNone(R.A1_CAPTURE_VERIFIER, 'the capture-binding verifier is a pending interface (HOLD)')
        self.archive = self.d / 'etc/base-bootstrap-archive'; self.store = self.d / 'etc/base-finality-watermark'; self.gen = 0

    def tearDown(self):
        R.A1_CAPTURE_VERIFIER = None; super().tearDown()

    # ---- the fixture runs in the CONFIGURED workdir (each launch gets a fresh harness workdir) -------------------------
    def run_step(self, step):
        self.write(); code = A.main(['a2a4.py', step, str(self.d / 'cfg.json')]); self.state = self.st()
        recs = sorted(pathlib.Path(self.cfg['workdir']).glob(f'run-{step}-*.json')); return code, json.loads(recs[-1].read_text())

    def start(self, executor=None, **kw):
        with patch.object(W, 'BOOTSTRAP_ARCHIVE', self.archive), patch.object(W, 'BOOTSTRAP_WATERMARK', self.store):
            return super().start(executor=executor, **kw)

    def arm(self, **kw):
        return P.arm(self.out, self.d / 'cfg.json', A=A, W=W, owner=self.uid, top=self.top, archive=self.archive, watermark=self.store, **kw)

    def retire(self):
        return P.retire(self.out, self.archive, W=W, owner=self.uid, top=self.top)

    def node_ran(self, head=HEAD, extra_headers=()):
        """The consumed, anchored node ran to `head` and crashed: every stage, header and label moved; it wrote its DB."""
        st = self.state
        st['cp'] = {k: head for k in st['cp']}; st['headersTip'] = head
        st['labels'] = {'LastFinalizedBlock': head - 300, 'LastSafeBlock': head - 20}
        for n, h in extra_headers:
            st['headers'][str(n)] = h
        self.write(); (self.d / 'datadir/db/mdbx.dat').write_bytes(b'written by the running node')

    def fresh_recheck(self):
        """A NEW original-game recheck of the CURRENT initial receipt, run now (root re-runs the reviewed recheck)."""
        at = TA.utcnow(); pin = sha(self.initial)
        self.rk, self.run = TA.make_recheck(self.ini, pin, at), TA.run_record(at, pin)

    def newer_initial(self):
        """TEST fixture: an initial receipt for the newer anchor N2 (root -> the synthetic header N2), same shape as fresh_a1."""
        e = TA.fresh_a1(TA.utcnow() - TA.datetime.timedelta(hours=1), root=FX2['outputRoot']); e['N'] = str(N2)
        self.initial = json.dumps(e).encode(); self.ini = json.loads(self.initial)
        self.cfg.update(N=N2, outputRoot=FX2['outputRoot'], a1InitialSha256=sha(self.initial))
        self.cfg['reanchor'].update(a1Capture=str(self.d / f'capture-{self.gen}'), a1CaptureSha256='c1' * 32)   # a capture OUT dir

    def reanchor_config(self, prev_n, legacy=None):
        """Explicit: a watermark store always; legacyNoWatermark only when the store holds no accepted entry (or forced)."""
        ra = {'predecessorN': prev_n, 'watermarkStore': str(self.store)}
        if (not R.watermark_entries(self.store)) if legacy is None else legacy:
            ra['legacyNoWatermark'] = True
        self.cfg['reanchor'] = ra

    def reanchor_pipeline(self, newer=False):
        """R-A on the SAME datadir: A0 rollback + retire, fresh A1, A2, A3 unwind, A4 full rebuild, bytecodes, release (new workdir)."""
        prev, prev_n = self.lsha, int(self.launch['anchor'].split(':')[0])
        self.assertEqual(self.rollback('crash: the consumed launch cannot restart')['event'], 'rolled-back')
        self.assertEqual(self.retire()['retired'], prev)
        self.gen += 1; self.cfg['workdir'] = str(self.d / f'work-{self.gen}')
        self.reanchor_config(prev_n)
        if newer:
            self.newer_initial()
        self.fresh_recheck()
        for st in ('a2', 'a3', 'a4'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        a3 = json.loads((pathlib.Path(self.cfg['workdir']) / 'a3-unwound.json').read_bytes())
        self.assertEqual(set(a3['checkpoints'].values()), {self.cfg['N']}, 'every block above the new anchor was unwound')
        self.checker(dict(TA.V2_GOOD, datadir=self.cfg['datadir'], checkpoints={k: self.cfg['N'] for k in TA.V2_GOOD['checkpoints']}))
        A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        for st in ('bytecodes', 'release'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        return prev

    def produce_successor(self, prev, **kw):
        return self.produce(predecessor=prev, archive=self.archive, W=W, watermark=self.store, **kw)

    # ==== end to end ====================================================================================================
    def test_crash_then_same_anchor_reanchor_recovers_exactly_once_twice(self):
        self.launched(); self.assertEqual(self.start(), 'exec'); first = self.launch['anchor']
        self.node_ran()
        self.assertRegex(self.start(), 'already consumed')                    # Base stays down: no replay
        self.refused(self.rearm, 'db_changed')                                # no fast resume from inode identity / labels
        self.refused(self.retire, 'retire')                                   # a consumed launch is never archived
        prev = self.reanchor_pipeline()
        self.refused(lambda: self.produce(), 'lineage')                       # a re-anchor launch must name its predecessor
        self.refused(lambda: self.produce_successor('00' * 32), 'lineage')    # not an archived launch
        self.cfg['reanchor']['predecessorN'] = N1 - 1; self.write()
        self.refused(lambda: self.produce_successor(prev), 'lineage')         # predecessorN is not the predecessor's anchor
        self.cfg['reanchor']['predecessorN'] = N1; self.write()
        self.produce_successor(prev)
        self.assertEqual((self.launch['anchor'], self.launch['predecessor']['launchSha256']), (first, prev))
        self.assertEqual(self.arm()['event'], 'armed')
        self.assertEqual(self.start(), 'exec'); self.assertRegex(self.start(), 'already consumed')
        self.assertEqual(self.execs()[-1][2][-2:], ['--bootstrap.anchor', first]); self.assertEqual(len(self.execs()), 2)
        self.node_ran(HEAD + 1_000)                                           # a second crash: lineage of two
        prev2 = self.reanchor_pipeline(); self.produce_successor(prev2); self.arm()
        self.assertEqual(W.launch_lineage(self.launch, self.archive, self.uid, self.top), [first] * 3)
        self.assertEqual(self.start(), 'exec'); self.assertEqual(len(self.execs()), 3)
        self.assertEqual(sorted(os.listdir(self.archive)), sorted([prev, prev2]))

    def test_newer_anchor_is_held_until_a_reviewed_capture_verifier_exists(self):
        self.launched(); self.assertEqual(self.start(), 'exec')
        self.node_ran(extra_headers=[(N2, FX2['header'])])
        self.rollback('crash'); self.retire()
        self.cfg['workdir'] = str(self.d / 'work-1'); self.reanchor_config(N1)
        self.newer_initial(); self.fresh_recheck()
        rc, rec = self.run_step('a2')                                         # the REAL (None) verifier
        self.assertEqual(rc, 1, rec); self.assertTrue(rec['refused'].startswith('a1_capture_pending:'), rec['refused'])
        self.assertFalse((pathlib.Path(self.cfg['workdir']) / 'a2-authenticated.json').exists())
        self.assertEqual(self.state['cp']['execution'], HEAD, 'nothing was unwound')

    def test_newer_anchor_pipeline_with_a_test_only_capture_verifier(self):
        """TEST-ONLY verifier: it trusts the test's capture record. Proves pipeline consistency for N2 > N1, NOT capture binding."""
        R.A1_CAPTURE_VERIFIER = lambda cap, ini: {'captureSha256': 'c1' * 32, 'initialSha256': sha(ini), 'N': json.loads(ini)['N'],
                                                  'game': json.loads(ini)['game'], 'outputRoot': json.loads(ini)['outputRoot']}
        self.launched(); self.assertEqual(self.start(), 'exec'); first = self.launch['anchor']
        self.node_ran(extra_headers=[(N2, FX2['header'])])
        prev = self.reanchor_pipeline(newer=True)
        self.produce_successor(prev)
        self.assertEqual(self.launch['anchor'], f'{N2}:{FX2["blockHash"]}'); self.assertEqual(self.launch['predecessor']['anchor'], first)
        self.arm(); self.assertEqual(self.start(), 'exec')
        self.assertEqual(self.execs()[-1][2][-2:], ['--bootstrap.anchor', f'{N2}:{FX2["blockHash"]}'])
        R.A1_CAPTURE_VERIFIER = lambda cap, ini: {'captureSha256': 'c1' * 32, 'initialSha256': sha(ini), 'N': str(N2 + 1), 'game': TA.GAME,
                                                  'outputRoot': FX2['outputRoot']}
        self.refused(lambda: P._initial_ok(A, A.load_config(self.d / 'cfg.json'), {'initialSha256': self.cfg['a1InitialSha256']}), 'a1')

    # ==== lineage (adversarial), through the real call path after a valid recovery =====================================
    def test_lineage_tamper_fork_and_orphans_refuse_before_consuming(self):
        self.launched(); self.start(); self.node_ran()
        prev = self.reanchor_pipeline(); self.produce_successor(prev); self.arm(); before = self.journal()
        a = self.archive; pd = a / prev
        jl = sorted((pd / 'journal').glob('[0-9]*.json'))[-1]; jb = jl.read_bytes()
        cases = []
        def orphan():
            shutil.copytree(pd, a / ('ab' * 32), symlinks=True)
        def unorphan():
            shutil.rmtree(a / ('ab' * 32))
        cases.append((orphan, unorphan, "outside this launch's lineage"))
        def drop_rollback():                          # the terminal entry removed from the archived journal
            jl.rename(self.d / 'rolled-back.bak')
        def restore_rollback():
            (self.d / 'rolled-back.bak').rename(jl)
        cases.append((drop_rollback, restore_rollback, 'not terminally rolled back'))
        lj = pd / 'launch.json'; lb = lj.read_bytes()
        cases.append((lambda: lj.write_bytes(lb + b' '), lambda: lj.write_bytes(lb), 'differs from its name'))
        def hide():
            pd.rename(self.d / 'hidden')
        def unhide():
            (self.d / 'hidden').rename(pd)
        cases.append((hide, unhide, 'is not an archived launch'))
        def link():
            a.rename(self.d / 'real-archive'); a.symlink_to(self.d / 'real-archive')
        def unlink():
            a.unlink(); (self.d / 'real-archive').rename(a)
        cases.append((link, unlink, 'is a symlink'))
        for do, undo, why in cases:
            with self.subTest(why):
                do(); self.assertRegex(self.start(), why); undo()
        self.assertEqual(jl.read_bytes(), jb); self.assertEqual(self.journal(), before); self.assertEqual(len(self.execs()), 1)
        self.assertEqual(self.start(), 'exec')

    def test_lineage_rules_unit(self):
        """Synthetic archived launches (real launch.json bytes + real journal appends): backward, same-height-other-hash, first
        bootstrap with a non-empty archive, malformed and repeated predecessors."""
        def archived(anchor, events=('armed', 'rolled-back')):
            b = json.dumps({'format': W.LAUNCH_FORMAT, 'anchor': anchor}).encode(); name = sha(b)
            d = self.archive / name; (d / 'journal').mkdir(parents=True); (d / 'launch.json').write_bytes(b)
            entries = []
            for ev in events:
                entries = W.journal_append(d / 'journal', self.uid, name, entries, ev, {}, 'now', self.top)
            return name, entries[-1][0]
        self.archive.mkdir(mode=0o755)
        h = lambda c: '0x' + c * 64
        n1, e1 = archived(f'{N1}:{h("1")}')
        lin = lambda cur: W.launch_lineage(cur, self.archive, self.uid, self.top)
        self.assertEqual(lin({'anchor': f'{N2}:{h("2")}', 'predecessor': {'launchSha256': n1, 'rolledBackEntrySha256': e1, 'anchor': f'{N1}:{h("1")}'}}),
                         [f'{N2}:{h("2")}', f'{N1}:{h("1")}'])
        bad = [({'anchor': f'{N1 - 1}:{h("2")}', 'predecessor': {'launchSha256': n1, 'rolledBackEntrySha256': e1, 'anchor': f'{N1}:{h("1")}'}}, 'moved backward'),
               ({'anchor': f'{N1}:{h("3")}', 'predecessor': {'launchSha256': n1, 'rolledBackEntrySha256': e1, 'anchor': f'{N1}:{h("1")}'}}, 'moved backward'),
               ({'anchor': f'{N2}:{h("2")}'}, "outside this launch's lineage"),
               ({'anchor': f'{N2}:{h("2")}', 'predecessor': {'launchSha256': n1, 'rolledBackEntrySha256': '00' * 32, 'anchor': f'{N1}:{h("1")}'}}, 'named journal entry'),
               ({'anchor': f'{N2}:{h("2")}', 'predecessor': {'launchSha256': n1, 'rolledBackEntrySha256': e1, 'anchor': f'{N1}:{h("4")}'}}, 'named anchor'),
               ({'anchor': f'{N2}:{h("2")}', 'predecessor': {'launchSha256': n1}}, 'malformed')]
        for cur, why in bad:
            with self.subTest(why), self.assertRaisesRegex(AssertionError, why):
                lin(cur)
        n2, e2 = archived(f'{N2}:{h("2")}', ('armed', 'consumed'))                 # consumed, never rolled back
        with self.assertRaisesRegex(AssertionError, 'not terminally rolled back'):
            lin({'anchor': f'{N2 + 1}:{h("5")}', 'predecessor': {'launchSha256': n2, 'rolledBackEntrySha256': e2, 'anchor': f'{N2}:{h("2")}'}})

    # ==== derived bounds and the pending interface (harness, no pipeline) =============================================
    def cfg_with(self, **over):
        TA.Recheck.use_recheck(self); c = dict(self.cfg, **over); p = self.d / 'cfg-probe.json'; p.write_text(json.dumps(c)); return p

    def bad_config(self, p):
        with self.assertRaises(A.Refused) as e:
            A.load_config(p)
        self.assertTrue(str(e.exception).startswith('bad_config:'), str(e.exception))

    def test_bounds_are_derived_never_widened(self):
        self.bad_config(self.cfg_with(N=R.SNAPSHOT_HEAD))                          # first bootstrap: the static bound is unchanged
        wm = str(self.store)
        ok = A.load_config(self.cfg_with(N=R.SNAPSHOT_HEAD + 10, reanchor={'predecessorN': N1, 'watermarkStore': wm}))
        self.assertEqual(ok['N'], R.SNAPSHOT_HEAD + 10, 'a re-anchor has no static upper bound ...')
        self.bad_config(self.cfg_with(N=N1 - 1, reanchor={'predecessorN': N1}))   # backward
        self.bad_config(self.cfg_with(N=N1, reanchor={'predecessorN': R.STATE_FLOOR - 1}))
        self.bad_config(self.cfg_with(reanchor={'predecessorN': N1, 'extra': 1}))
        self.bad_config(self.cfg_with(reanchor={'predecessorN': N1, 'a1Capture': '/x'}))
        self.bad_config(self.cfg_with(reanchor={'predecessorN': True, 'watermarkStore': wm}))
        self.bad_config(self.cfg_with(reanchor={'predecessorN': N1}))                          # r2: the watermark store is required
        self.bad_config(self.cfg_with(reanchor={'predecessorN': N1, 'watermarkStore': 'rel'}))
        self.bad_config(self.cfg_with(reanchor={'predecessorN': N1, 'watermarkStore': wm, 'legacyNoWatermark': 1}))
        c = dict(self.cfg); [c.pop(k) for k in R.A1_RECHECK_KEYS]; c.update(a1Mode='fresh-initial', reanchor={'predecessorN': N1})
        p = self.d / 'cfg-fresh.json'; p.write_text(json.dumps(c)); self.bad_config(p)
        # ... its upper bound is the STOPPED DB: every stage must hold N (A1 isolated here so only the DB bound is exercised)
        c = A.load_config(self.cfg_with(N=R.SNAPSHOT_HEAD + 10, reanchor={'predecessorN': N1, 'watermarkStore': wm})); w = A.workdir(c)
        with patch.object(A, 'gate_a1', return_value={}):
            with self.assertRaisesRegex(A.Refused, '^below_anchor'):
                A.step_plan(c, A.Base(c, [], w), w)
            self.state['cp'].update(execution=R.SNAPSHOT_HEAD + 20, headers=R.SNAPSHOT_HEAD + 5); self.write()
            with self.assertRaisesRegex(A.Refused, '^below_anchor: stage checkpoints'):
                A.step_plan(c, A.Base(c, [], w), w)
        os.unlink(self.cfg['downloadReceipt'])                                       # gate_download is not relaxed in re-anchor mode
        with patch.object(A, 'gate_a1', return_value={}), self.assertRaisesRegex(A.Refused, '^no_receipt'):
            A.step_plan(c, A.Base(c, [], w), w)

    def test_initial_pin_rules_and_the_pending_capture_interface(self):
        TA.Recheck.use_recheck(self); self.write()
        base = A.load_config(self.d / 'cfg.json')
        self.assertEqual(A.initial_pin(base), 'source-pin')
        other = dict(base, a1InitialSha256='77' * 32)
        with self.assertRaisesRegex(A.Refused, '^a1_initial_pin'):
            A.initial_pin(other)                                                     # first bootstrap: source pin only
        with self.assertRaisesRegex(A.Refused, '^a1_initial_pin'):
            A.initial_pin(dict(other, reanchor={'predecessorN': N1}))                # re-anchor without a capture record
        ra = {'predecessorN': N1, 'watermarkStore': str(self.store), 'a1Capture': str(self.d / 'capture-x'), 'a1CaptureSha256': 'c1' * 32}
        with self.assertRaisesRegex(A.Refused, '^a1_capture_pending: HOLD'):
            A.initial_pin(dict(other, reanchor=ra))                                  # the REAL interface state (50cf r2 not final)
        real_ini = sha(self.initial); bound = dict(base, a1InitialSha256=real_ini, reanchor=ra)
        good = lambda cap, ini: {'captureSha256': 'c1' * 32, 'initialSha256': sha(ini), 'N': str(base['N']), 'game': base['game'], 'outputRoot': base['outputRoot']}
        with patch.object(A, 'A1_INITIAL_SHA256', '88' * 32):                       # (so the receipt is NOT the source pin)
            R.A1_CAPTURE_VERIFIER = lambda cap, ini: good(cap, ini) if cap == ra['a1Capture'] else None
            self.assertEqual(A.initial_pin(bound), 'capture-bound')                  # TEST-ONLY verifier
            for wrong in ({'N': str(base['N'] + 1)}, {'captureSha256': 'c2' * 32}):
                R.A1_CAPTURE_VERIFIER = lambda cap, ini, wrong=wrong: dict(good(cap, ini), **wrong)
                with self.subTest(wrong), self.assertRaisesRegex(A.Refused, '^a1_capture_binding'):
                    A.initial_pin(bound)
            with self.assertRaisesRegex(A.Refused, '^a1_initial_pin'):
                A.initial_pin(dict(bound, a1InitialSha256='99' * 32))                # bytes are not the configured receipt

    # ==== r2: the persisted authenticated-finality watermark ==========================================================
    def crashed_and_retired(self, extra_headers=()):
        """The first launch consumed, the node ran and crashed; rolled back and retired; a new workdir and a fresh recheck."""
        self.launched(); self.assertEqual(self.start(), 'exec'); self.node_ran(extra_headers=extra_headers)
        self.rollback('crash'); prev = self.retire()['retired']
        self.gen += 1; self.cfg['workdir'] = str(self.d / f'work-{self.gen}'); self.fresh_recheck()
        return prev

    def wm_put(self, number, block_hash, kind='finality-proof', ref='ab' * 32):
        """TEST-ONLY stand-in for a FUTURE reviewed watermark writer (record_finality is HOLD): the real durable append."""
        if not self.store.exists():
            self.store.mkdir(mode=0o755)
        return W.watermark_append(self.store, self.uid, W.watermark_entries(self.store, self.uid, self.top), number, block_hash, kind, ref,
                                  'now', self.top)

    def step_refused(self, step, code, head=HEAD):
        rc, rec = self.run_step(step); self.assertEqual(rc, 1, rec); self.assertTrue(rec['refused'].startswith(code + ':'), rec['refused'])
        self.assertEqual(self.st()['cp']['execution'], head, 'the refusal changed nothing'); return rec

    def test_missing_watermark_needs_explicit_legacy_and_legacy_only_without_one(self):
        self.crashed_and_retired()
        self.cfg['reanchor'] = {'predecessorN': N1, 'watermarkStore': str(self.store)}
        self.step_refused('a2', 'watermark_missing')                                 # missing authority: never implicit
        self.assertFalse((pathlib.Path(self.cfg['workdir']) / 'a2-authenticated.json').exists())
        self.wm_put(N1, TA.FX['blockHash'], kind='launch-anchor')
        self.cfg['reanchor']['legacyNoWatermark'] = True
        self.step_refused('a2', 'watermark_legacy')                                  # legacy is only for a store with no entry
        del self.cfg['reanchor']['legacyNoWatermark']
        rc, rec = self.run_step('a2'); self.assertEqual(rc, 0, rec)                  # anchor == watermark height, same block
        self.refused(lambda: P.record_finality(), 'hold_finality')                   # no finality-proof writer exists (HOLD)

    def test_anchor_below_or_conflicting_with_the_watermark_refuses_before_any_mutation(self):
        self.crashed_and_retired(extra_headers=[(N1 - 7, TA.FX['header'])])
        self.cfg['reanchor'] = {'predecessorN': N1, 'watermarkStore': str(self.store)}
        cases = [((N1 + 100, '0x' + 'cd' * 32, 'finality-proof'), 'watermark_below'),   # a later accepted finalized guarantee
                 ((N1, '0x' + 'ee' * 32, 'launch-anchor'), 'watermark_conflict'),       # same height, another block
                 ((N1 - 7, '0x' + 'ef' * 32, 'finality-proof'), 'watermark_conflict')]  # the DB holds another block there
        for (n, h, kind), code in cases:
            with self.subTest(code=code, n=n):
                shutil.rmtree(self.store, ignore_errors=True); self.wm_put(n, h, kind)
                self.step_refused('a2', code)
                self.assertFalse((pathlib.Path(self.cfg['workdir']) / 'a2-authenticated.json').exists())
        shutil.rmtree(self.store); self.wm_put(N1 - 7, TA.FX['blockHash'])             # the DB's block at the watermark: accepted
        for st in ('a2', 'a3'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))

    def full_recovery_with_seed(self):
        """A recovery over a store seeded with an accepted entry at N1-7 (the DB's block there); returns after produce."""
        prev = self.crashed_and_retired(extra_headers=[(N1 - 7, TA.FX['header'])])
        self.wm_put(N1 - 7, TA.FX['blockHash']); self.reanchor_config(N1)
        self.assertNotIn('legacyNoWatermark', self.cfg['reanchor'])
        for st in ('a2', 'a3', 'a4'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        self.checker(dict(TA.V2_GOOD, datadir=self.cfg['datadir'])); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        rc, rec = self.run_step('bytecodes'); self.assertEqual(rc, 0, rec)
        return prev

    def test_watermark_accepted_during_downtime_refuses_release_arm_and_start(self):
        prev = self.full_recovery_with_seed()
        with self.assertRaises(FileNotFoundError):                                   # downtime: no launch directory: the wrapper
            self.start()                                                              # exits non-zero before any gate
        later = self.store / '000002.json'
        self.wm_put(N1 + 50, '0x' + 'cd' * 32)                                       # accepted while Base was down
        self.step_refused('release', 'watermark_below', head=N1); later.unlink()     # (A3 already unwound to N1)
        rc, rec = self.run_step('release'); self.assertEqual(rc, 0, rec)
        self.produce_successor(prev); self.assertEqual(self.launch['watermark']['number'], N1 - 7)
        self.wm_put(N1 + 50, '0x' + 'cd' * 32)
        self.refused(self.arm, 'watermark'); later.unlink()                         # changed since produce: re-produce
        self.assertFalse((self.out / 'journal').exists())
        self.arm(); self.assertEqual([e['kind'] for _, e in W.watermark_entries(self.store, self.uid, self.top)], ['finality-proof', 'launch-anchor'])
        self.wm_put(N1 + 50, '0x' + 'cd' * 32)                                       # accepted after arm, before start
        self.assertRegex(self.start(), "not this launch's anchor"); (self.store / '000003.json').unlink()
        self.assertEqual(self.states(), ['armed'])
        self.assertEqual(self.start(), 'exec')

    def test_watermark_tamper_refuses_in_harness_and_wrapper_before_consuming(self):
        prev = self.full_recovery_with_seed()
        rc, rec = self.run_step('release'); self.assertEqual(rc, 0, rec); self.produce_successor(prev); self.arm(); before = self.journal()
        s1, s2 = self.store / '000001.json', self.store / '000002.json'; b1, b2 = s1.read_bytes(), s2.read_bytes()

        def edit():
            d = json.loads(b1); d['at'] = 'edited'; s1.write_bytes(json.dumps(d).encode())
        def regress():
            prev_sha = sha(b2); (self.store / '000003.json').write_bytes(json.dumps({'format': W.WATERMARK_FORMAT, 'seq': 3, 'prevSha256': prev_sha,
                'number': N1 - 100, 'blockHash': '0x' + '12' * 32, 'kind': 'finality-proof', 'ref': 'ab' * 32, 'at': 'now'}).encode())
        def symlink():
            self.store.rename(self.d / 'real-store'); self.store.symlink_to(self.d / 'real-store')
        def restore():
            if self.store.is_symlink():
                self.store.unlink(); (self.d / 'real-store').rename(self.store)
            for n in os.listdir(self.store):
                if n not in ('000001.json', '000002.json'):
                    os.unlink(self.store / n)
            s1.write_bytes(b1); s1.chmod(0o644)
            if not s2.exists():
                s2.write_bytes(b2)
        cases = [(edit, 'watermark: chain broken at 000002', ('watermark_tamper',)),
                 (lambda: s2.rename(self.store / '000003.json'), 'watermark: unexpected entry 000003', ('watermark_tamper',)),
                 (lambda: s1.chmod(0o666), 'non-writable', ('untrusted_file', 'watermark_tamper')),
                 (symlink, 'is a symlink', ('watermark_tamper',)),
                 (regress, 'watermark: regresses or conflicts at 000003', ('watermark_tamper',)),
                 (lambda: s2.unlink(), "not this launch's anchor", None)]              # truncation: the harness sees a valid chain
        for do, why, harness_codes in cases:
            with self.subTest(why):
                do()
                self.assertRegex(self.start(), why)
                if harness_codes:
                    with self.assertRaises(A.Refused) as e:
                        R.watermark_entries(self.store)
                    self.assertTrue(str(e.exception).split(':')[0] in harness_codes, str(e.exception))
                restore()
        self.assertEqual(self.journal(), before); self.assertEqual(self.start(), 'exec')

    def test_crash_points_retire_produce_arm_fail_closed_and_rearm_is_idempotent(self):
        prev = self.crashed_and_retired(); self.reanchor_config(N1)
        with self.assertRaises(FileNotFoundError):                                   # retired, nothing produced: the wrapper exits
            self.start()                                                              # non-zero before any gate (fail closed)
        for st in ('a2', 'a3', 'a4'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        self.checker(dict(TA.V2_GOOD, datadir=self.cfg['datadir'])); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        for st in ('bytecodes', 'release'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        self.produce_successor(prev)
        self.assertRegex(self.start(), 'launch lock .* unavailable')                 # produced, not armed
        with patch.object(P, '_append', side_effect=OSError('simulated crash after the watermark record')):
            with self.assertRaises(OSError):
                self.arm()
        self.assertEqual(len(W.watermark_entries(self.store, self.uid, self.top)), 1)
        self.assertRegex(self.start(), 'no launch journal')                          # recorded, not armed: still no start
        self.assertEqual(self.arm()['event'], 'armed')                               # re-arm: the watermark record is idempotent
        self.assertEqual(len(W.watermark_entries(self.store, self.uid, self.top)), 1)
        self.assertEqual(self.start(), 'exec'); self.assertRegex(self.start(), 'already consumed')

    def test_gate_download_on_the_reused_db(self):
        """The ORIGINAL receipt still qualifies the reused datadir's ORIGIN (A2 passes); a replaced datadir or a non-empty marker refuses."""
        self.crashed_and_retired(); self.reanchor_config(N1)
        rc, rec = self.run_step('a2'); self.assertEqual(rc, 0, rec)
        dd = pathlib.Path(self.cfg['datadir']); os.rename(dd, self.d / 'datadir-old'); shutil.copytree(self.d / 'datadir-old', dd)
        self.step_refused('a3', 'receipt_datadir')                                   # same bytes, another directory (dev/ino)
        shutil.rmtree(dd); os.rename(self.d / 'datadir-old', dd)
        pathlib.Path(self.cfg['snapshotMarker']).write_text('x')
        self.step_refused('a3', 'marker')


if __name__ == '__main__':
    unittest.main(verbosity=2)
