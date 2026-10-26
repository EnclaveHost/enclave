"""Offline tests of the R-A re-anchor recovery (base-reanchor-recovery-stage). Root runs these; Claude did not.

The REAL pipeline: the recovery harness copy (harness/a2a4.py) drives the A2-A4 harness's own fake-base fixture (no reth, no
network); the recovery producer and wrapper copies run their real code; every start goes through the wrapper's real
run('base') with the r3 launcher suite's boundary (system/RPC faked, os.execve a fake executor). The r3 suite's Pipeline is
reused unchanged (tests/test_r3_launcher.py is byte-identical to r3); here its module globals are rebound to the recovery harness.

TEST-ONLY substitutions, each labelled where used and reset by setUp/tearDown (no production check is weakened):
  - the r3 suite's: fixture A1 recheck-mode pin, fake checker v2 pin, fake release, test-owned top/uid, LAUNCH_PRODUCER_REVIEWED
    inside the wrapper module, recorded (not performed) privilege drop;
  - BOOTSTRAP_ARCHIVE inside the wrapper module -> a test-owned archive;
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
        self.archive = self.d / 'etc/base-bootstrap-archive'; self.gen = 0

    def tearDown(self):
        R.A1_CAPTURE_VERIFIER = None; super().tearDown()

    # ---- the fixture runs in the CONFIGURED workdir (each launch gets a fresh harness workdir) -------------------------
    def run_step(self, step):
        self.write(); code = A.main(['a2a4.py', step, str(self.d / 'cfg.json')]); self.state = self.st()
        recs = sorted(pathlib.Path(self.cfg['workdir']).glob(f'run-{step}-*.json')); return code, json.loads(recs[-1].read_text())

    def start(self, executor=None, **kw):
        with patch.object(W, 'BOOTSTRAP_ARCHIVE', self.archive):
            return super().start(executor=executor, **kw)

    def arm(self, **kw):
        return P.arm(self.out, self.d / 'cfg.json', A=A, W=W, owner=self.uid, top=self.top, archive=self.archive, **kw)

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
        cap = self.d / f'capture-{self.gen}.json'; cap.write_bytes(json.dumps({'capture': 'test', 'initial': sha(self.initial)}).encode())
        self.cfg['reanchor'].update(a1Capture=str(cap), a1CaptureSha256=sha(cap.read_bytes()))

    def reanchor_pipeline(self, newer=False):
        """R-A on the SAME datadir: A0 rollback + retire, fresh A1, A2, A3 unwind, A4 full rebuild, bytecodes, release (new workdir)."""
        prev, prev_n = self.lsha, int(self.launch['anchor'].split(':')[0])
        self.assertEqual(self.rollback('crash: the consumed launch cannot restart')['event'], 'rolled-back')
        self.assertEqual(self.retire()['retired'], prev)
        self.gen += 1; self.cfg['workdir'] = str(self.d / f'work-{self.gen}')
        self.cfg['reanchor'] = {'predecessorN': prev_n}
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
        return self.produce(predecessor=prev, archive=self.archive, W=W, **kw)

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
        self.cfg['workdir'] = str(self.d / 'work-1'); self.cfg['reanchor'] = {'predecessorN': N1}
        self.newer_initial(); self.fresh_recheck()
        rc, rec = self.run_step('a2')                                         # the REAL (None) verifier
        self.assertEqual(rc, 1, rec); self.assertTrue(rec['refused'].startswith('a1_capture_pending:'), rec['refused'])
        self.assertFalse((pathlib.Path(self.cfg['workdir']) / 'a2-authenticated.json').exists())
        self.assertEqual(self.state['cp']['execution'], HEAD, 'nothing was unwound')

    def test_newer_anchor_pipeline_with_a_test_only_capture_verifier(self):
        """TEST-ONLY verifier: it trusts the test's capture record. Proves pipeline consistency for N2 > N1, NOT capture binding."""
        R.A1_CAPTURE_VERIFIER = lambda rec, ini: {'initialSha256': sha(ini), 'N': json.loads(ini)['N'], 'game': json.loads(ini)['game'],
                                                  'outputRoot': json.loads(ini)['outputRoot']}
        self.launched(); self.assertEqual(self.start(), 'exec'); first = self.launch['anchor']
        self.node_ran(extra_headers=[(N2, FX2['header'])])
        prev = self.reanchor_pipeline(newer=True)
        self.produce_successor(prev)
        self.assertEqual(self.launch['anchor'], f'{N2}:{FX2["blockHash"]}'); self.assertEqual(self.launch['predecessor']['anchor'], first)
        self.arm(); self.assertEqual(self.start(), 'exec')
        self.assertEqual(self.execs()[-1][2][-2:], ['--bootstrap.anchor', f'{N2}:{FX2["blockHash"]}'])
        R.A1_CAPTURE_VERIFIER = lambda rec, ini: {'initialSha256': sha(ini), 'N': str(N2 + 1), 'game': TA.GAME, 'outputRoot': FX2['outputRoot']}
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
        ok = A.load_config(self.cfg_with(N=R.SNAPSHOT_HEAD + 10, reanchor={'predecessorN': N1}))
        self.assertEqual(ok['N'], R.SNAPSHOT_HEAD + 10, 'a re-anchor has no static upper bound ...')
        self.bad_config(self.cfg_with(N=N1 - 1, reanchor={'predecessorN': N1}))   # backward
        self.bad_config(self.cfg_with(N=N1, reanchor={'predecessorN': R.STATE_FLOOR - 1}))
        self.bad_config(self.cfg_with(reanchor={'predecessorN': N1, 'extra': 1}))
        self.bad_config(self.cfg_with(reanchor={'predecessorN': N1, 'a1Capture': '/x'}))
        self.bad_config(self.cfg_with(reanchor={'predecessorN': True}))
        c = dict(self.cfg); [c.pop(k) for k in R.A1_RECHECK_KEYS]; c.update(a1Mode='fresh-initial', reanchor={'predecessorN': N1})
        p = self.d / 'cfg-fresh.json'; p.write_text(json.dumps(c)); self.bad_config(p)
        # ... its upper bound is the STOPPED DB: every stage must hold N (A1 isolated here so only the DB bound is exercised)
        c = A.load_config(self.cfg_with(N=R.SNAPSHOT_HEAD + 10, reanchor={'predecessorN': N1})); w = A.workdir(c)
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
        cap = self.d / 'cap.json'; cap.write_bytes(b'{"capture": "x"}')
        ra = {'predecessorN': N1, 'a1Capture': str(cap), 'a1CaptureSha256': '00' * 32}
        with self.assertRaisesRegex(A.Refused, '^a1_capture_sha'):
            A.initial_pin(dict(other, reanchor=ra))
        ra['a1CaptureSha256'] = sha(cap.read_bytes())
        with self.assertRaisesRegex(A.Refused, '^a1_capture_pending: HOLD'):
            A.initial_pin(dict(other, reanchor=ra))                                  # the REAL interface state
        cap.chmod(0o666)
        with self.assertRaisesRegex(A.Refused, '^untrusted_file'):
            A.initial_pin(dict(other, reanchor=ra))
        cap.chmod(0o644)
        real_ini = sha(self.initial); bound = dict(base, a1InitialSha256=real_ini, reanchor=ra)
        with patch.object(A, 'A1_INITIAL_SHA256', '88' * 32):                       # (so the receipt is NOT the source pin)
            R.A1_CAPTURE_VERIFIER = lambda rec, ini: {'initialSha256': sha(ini), 'N': str(base['N']), 'game': base['game'], 'outputRoot': base['outputRoot']}
            self.assertEqual(A.initial_pin(bound), 'capture-bound')                  # TEST-ONLY verifier
            R.A1_CAPTURE_VERIFIER = lambda rec, ini: {'initialSha256': sha(ini), 'N': str(base['N'] + 1), 'game': base['game'], 'outputRoot': base['outputRoot']}
            with self.assertRaisesRegex(A.Refused, '^a1_capture_binding'):
                A.initial_pin(bound)
            with self.assertRaisesRegex(A.Refused, '^a1_initial_pin'):
                A.initial_pin(dict(bound, a1InitialSha256='99' * 32))                # bytes are not the configured receipt


if __name__ == '__main__':
    unittest.main(verbosity=2)
