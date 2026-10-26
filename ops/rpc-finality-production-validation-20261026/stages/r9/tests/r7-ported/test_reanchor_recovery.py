"""Offline tests of the R-A re-anchor recovery, r4 (base-reanchor-recovery-stage/r4). Root runs these; Claude did not.

r4: the r3 tests unchanged, plus `Ledger` (5): the admission ledger under its own lock - real multi-process races on the SAME
capture from DIFFERENT workdirs, real interrupted appends (SIGKILL mid-write / after fsync / before write), busy lock, strict
schema/chain/duplicate/tail and file-safety refusals.

r7: run_step reads the record its own invocation wrote; the stale probe asserts the clock restore.
r3: a NEWER anchor goes through the REAL capture module (a1-capture-binding-stage/r2 src/a1_capture.py, loaded by the harness
from its pinned bytes) over pinned STUB A1 sources: real capture/verify/runtime/binding checks and the REAL pinned A1 gate, with
no substitute verifier or gate. The r2 placeholder verifier and its tests are removed; the bounds fixture is fixed (write()
sets a1RecheckSha256) and every config refusal asserts its exact reason.

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
  - capture tests: A1_CAPTURE_REVIEWED=True and A1_CAPTURE_SOURCE = the real r2 module (its pinned sha is asserted);
    A1_CAPTURE_TEST_PINS = that module's Pins over STUB A1 sources (two read stubs in tests/capture-stubs emit harness-fixture
    receipts) and THIS host's observed node/python/libpython - test-reviewed pins exactly as that stage's own tests use them.
    No capture here is an independent fresh capture of mainnet; nothing is activated."""
import contextlib, fcntl, hashlib, importlib.util, json, os, pathlib, shutil, signal, subprocess, sys, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import test_r3_launcher as L3                        # byte-identical r3 suite: loads TA, this stage's wrapper (T.c) and producer
TA, T, P, W = L3.TA, L3.T, L3.P, L3.W
_s = importlib.util.spec_from_file_location('a2a4_recovery', ROOT / 'harness/a2a4.py')
R = importlib.util.module_from_spec(_s); _s.loader.exec_module(R)
R.TRUSTED_UID = os.getuid(); R.ALLOW_INCOMPLETE_PROC_SCAN = True      # as the fixture does for the reviewed harness
R.RETH_ENV_PASS = ('FAKE_STATE', 'FAKE_LOG', 'FAKE_SLEEP', 'FAKE_BIG', 'FAKE_ORPHAN', 'FAKE_SPAM', 'FAKE_EXIT', 'FAKE_RESULT')   # r6.2: fake reth's own variables only
TA.A = R; L3.A = R; A = R                              # the fixture's and the r3 Pipeline's functions now drive the recovery copy
assert pathlib.Path(W.__file__).resolve() == (ROOT / 'wrapper/chain_service.py').resolve()
assert pathlib.Path(P.__file__).resolve() == (ROOT / 'producer/base_launch.py').resolve()
sha = L3.sha
CAP_STAGE = L3.WORK / 'a1-capture-binding-stage/r4'   # r6: r4 = r3 limits + the verified-bytes l1 loader
CAP_SRC = WORK / 'production-capture-closure-stage/src/a1_capture.py'   # r9: the closure module (harness pin fc16b26c); stubs still from capture r4
N1 = TA.N                                             # the original launch anchor 52,866,960
N2 = TA.N + 3_000                                     # a newer anchor height (the observed latest anchor 52,869,960)
HEAD = TA.N + 5_000                                   # where the consumed node had run before it crashed
FX2 = json.loads(subprocess.run(['node', str(TA.H / 'test/make_fixture.mjs'), str(N2)], capture_output=True, text=True, check=True,
                                env=dict(os.environ, A=TA.ANCHOR.as_uri(), D=(TA.DEPS / 'node_modules/@noble/hashes/sha3.js').as_uri())).stdout)


class Recovery(L3.Pipeline):
    def setUp(self):
        super().setUp()
        self.assertFalse(hasattr(R, 'A1_CAPTURE_VERIFIER'), 'the placeholder interface must remain removed')
        self.assertFalse(R.A1_CAPTURE_REVIEWED, 'capture activation must remain on HOLD outside each fixture')
        self.archive = self.d / 'etc/base-bootstrap-archive'; self.store = self.d / 'etc/base-finality-watermark'; self.gen = 0
        # finality r4 port (only change): `arm` requires the harness ledger to be the wrapper's SHARED A1_ADMISSION_LEDGER
        p = patch.object(W, 'A1_ADMISSION_LEDGER', self.d / 'etc/base-a1-admission.jsonl'); p.start(); self.addCleanup(p.stop)
        q = patch.object(R, 'A1_ADMISSION_LEDGER', self.d / 'etc/base-a1-admission.jsonl'); q.start(); self.addCleanup(q.stop)   # r5 harness
        # r8: the recovery harness parses ONLY the pinned reth checkpoint format, so this suite's fixture fake is the pinned-format emitter
        # (pinned-checkpoint-parser fixtures/fake_base.py; its sha is verified by the job). The shim and the fixture-scoped binary pin follow.
        shim = self.d / 'bin/base'; shim.write_text(f'#!/bin/sh\nexec {sys.executable} {os.environ["PINNED_FAKE_BASE"]} "$@"\n'); shim.chmod(0o755)
        self.cfg['baseBinarySha256'] = sha(shim.read_bytes())
        pb = patch.object(P, 'HARNESS_BINARY_SHA256', self.cfg['baseBinarySha256']); pb.start(); self.addCleanup(pb.stop)

    def tearDown(self):
        super().tearDown()

    # ---- the fixture runs in the CONFIGURED workdir (each launch gets a fresh harness workdir) -------------------------
    def run_step(self, step):
        # r7: read the run record THIS invocation wrote (exactly one new file), never "the newest name": a step run under a
        # patched clock names its record in that clock's time, so a later real-time record can sort BEFORE it (r6's actual
        # failure re-read the earlier a1_stale record instead of the untrusted_file refusal the harness had just printed)
        wd = pathlib.Path(self.cfg['workdir']); before = set(wd.glob(f'run-{step}-*.json')) if wd.exists() else set()
        self.write(); code = A.main(['a2a4.py', step, str(self.d / 'cfg.json')]); self.state = self.st()
        new = sorted(set(wd.glob(f'run-{step}-*.json')) - before)
        self.assertEqual(len(new), 1, f'exactly one new run record for {step}: {[n.name for n in new]}')
        return code, json.loads(new[0].read_text())

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

    def reanchor_config(self, prev_n, legacy=None):
        """Explicit: a watermark store always; legacyNoWatermark only when the store holds no accepted entry (or forced)."""
        ra = {'predecessorN': prev_n, 'watermarkStore': str(self.store)}
        if (not R.watermark_entries(self.store)) if legacy is None else legacy:
            ra['legacyNoWatermark'] = True
        self.cfg['reanchor'] = ra

    def reanchor_pipeline(self):
        """R-A on the SAME datadir: A0 rollback + retire, fresh A1, A2, A3 unwind, A4 full rebuild, bytecodes, release (new workdir)."""
        prev, prev_n = self.lsha, int(self.launch['anchor'].split(':')[0])
        self.assertEqual(self.rollback('crash: the consumed launch cannot restart')['event'], 'rolled-back')
        self.assertEqual(self.retire()['retired'], prev)
        self.gen += 1; self.cfg['workdir'] = str(self.d / f'work-{self.gen}')
        self.reanchor_config(prev_n)
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
    # ==== derived bounds / pin / config (r3: the fixture writes the recheck hashes; every refusal asserts its reason) ======
    def cfg_with(self, **over):
        if self.rk is None:
            TA.Recheck.use_recheck(self)
        self.write()                    # r3 FIX: write() sets a1RecheckSha256 (root's original run errored without it)
        c = dict(self.cfg, **over); p = self.d / 'cfg-probe.json'; p.write_text(json.dumps(c)); return p

    def bad_config(self, p, why):
        with self.assertRaises(A.Refused) as e:
            A.load_config(p)
        self.assertTrue(str(e.exception).startswith('bad_config:') and why in str(e.exception), str(e.exception))

    def test_bounds_are_derived_never_widened(self):
        wm = str(self.store); ra = lambda **k: dict({'predecessorN': N1, 'watermarkStore': wm}, **k)
        self.bad_config(self.cfg_with(N=R.SNAPSHOT_HEAD), f'N must be an integer in [{R.STATE_FLOOR}, {R.SNAPSHOT_HEAD})')
        ok = A.load_config(self.cfg_with(N=R.SNAPSHOT_HEAD + 10, reanchor=ra()))
        self.assertEqual(ok['N'], R.SNAPSHOT_HEAD + 10, 'a re-anchor has no static upper bound ...')
        self.bad_config(self.cfg_with(N=N1 - 1, reanchor=ra()), 'never moves backward')
        self.bad_config(self.cfg_with(reanchor=ra(predecessorN=R.STATE_FLOOR - 1)), 'reanchor must be')
        self.bad_config(self.cfg_with(reanchor=ra(extra=1)), 'reanchor must be')
        self.bad_config(self.cfg_with(reanchor=ra(predecessorN=True)), 'reanchor must be')
        self.bad_config(self.cfg_with(reanchor={'predecessorN': N1}), 'watermarkStore (absolute) is required')
        self.bad_config(self.cfg_with(reanchor=ra(watermarkStore='rel')), 'watermarkStore (absolute) is required')
        self.bad_config(self.cfg_with(reanchor=ra(legacyNoWatermark=1)), 'explicit boolean')
        c = dict(self.cfg); [c.pop(k) for k in R.A1_RECHECK_KEYS]; c.update(a1Mode='fresh-initial', reanchor=ra())
        p = self.d / 'cfg-fresh.json'; p.write_text(json.dumps(c)); self.bad_config(p, 'a re-anchor runs original-game-recheck')
        # ... its upper bound is the STOPPED DB: every stage must hold N (A1 isolated here so only the DB bound is exercised)
        c = A.load_config(self.cfg_with(N=R.SNAPSHOT_HEAD + 10, reanchor=ra(legacyNoWatermark=True))); w = A.workdir(c)
        with patch.object(A, 'gate_a1', return_value={}):
            with self.assertRaisesRegex(A.Refused, '^below_anchor: execution checkpoint'):
                A.step_plan(c, A.Base(c, [], w), w)
            self.state['cp'].update(execution=R.SNAPSHOT_HEAD + 20, headers=R.SNAPSHOT_HEAD + 5); self.write()
            with self.assertRaisesRegex(A.Refused, '^below_anchor: stage checkpoints'):
                A.step_plan(c, A.Base(c, [], w), w)
            self.state['cp'].update(headers=R.SNAPSHOT_HEAD + 20, bodies=R.SNAPSHOT_HEAD + 20, finish=R.SNAPSHOT_HEAD + 20); self.write()
            plan = A.step_plan(c, A.Base(c, [], w), w)                                  # the target bound reached: N is plannable
            self.assertEqual(plan['a3'][-1][-1], str(R.SNAPSHOT_HEAD + 10))
            os.unlink(self.cfg['downloadReceipt'])                                       # gate_download is not relaxed
            with self.assertRaisesRegex(A.Refused, '^no_receipt'):
                A.step_plan(c, A.Base(c, [], w), w)

    def test_initial_pin_is_the_source_pin_only_and_the_capture_module_is_pinned(self):
        TA.Recheck.use_recheck(self); self.write(); base = A.load_config(self.d / 'cfg.json')
        self.assertEqual(A.initial_pin(base), 'source-pin')
        for c in (dict(base, a1InitialSha256='77' * 32), dict(base, a1InitialSha256='77' * 32, reanchor={'predecessorN': N1, 'watermarkStore': str(self.store)})):
            with self.assertRaisesRegex(A.Refused, '^a1_initial_pin'):
                A.initial_pin(c)                                                     # never a config-supplied receipt hash
        self.assertFalse(hasattr(A, 'A1_CAPTURE_VERIFIER'), 'the r2 placeholder boundary is gone')
        self.assertIs(A.A1_CAPTURE_REVIEWED, False); self.assertIsNone(A.A1_CAPTURE_TEST_PINS)
        self.assertEqual(A.A1_CAPTURE_SHA256, sha(CAP_SRC.read_bytes()), 'the pin is the actual capture/r4 module')
        with self.assertRaisesRegex(A.Refused, '^a1_capture_pending: HOLD'):
            A.load_capture()

    # ==== r3: newer anchor through the REAL capture module ============================================================
    def cap_setup(self):
        """The capture stage's own stub sources (copied), with the two read stubs replaced by tests/capture-stubs; pins = their
        current bytes + this host's observed runtimes (test-reviewed, as that stage's tests do)."""
        stack = contextlib.ExitStack(); self.addCleanup(stack.close)
        for k, v in (('A1_CAPTURE_REVIEWED', True), ('A1_CAPTURE_SOURCE', CAP_SRC), ('A1_CAPTURE_TEST_PINS', lambda: self.cpins)):
            stack.enter_context(patch.object(R, k, v))
        C = self.C = R.load_capture(); stack.enter_context(patch.object(C, 'OWNER', os.getuid()))
        t = self.d / 'capsrc'; shutil.copytree(CAP_STAGE / 'tests/stubs', t / 'src')
        shutil.copyfile(HERE / 'capture-stubs/a1-read.mjs', t / 'src/initial/a1-read.mjs')
        shutil.copyfile(HERE / 'capture-stubs/a1-recheck-read.mjs', t / 'src/recheck/a1-recheck-read.mjs')
        e = TA.fresh_a1(TA.utcnow() - TA.datetime.timedelta(hours=1), root=FX2['outputRoot']); e['N'] = str(N2)
        (t / 'receipt-template.json').write_text(json.dumps(e))
        ex = json.loads((t / 'src/initial/a1-config.example.json').read_text()); ex['fixtureReceipt'] = str(t / 'receipt-template.json')
        (t / 'src/initial/a1-config.example.json').write_text(json.dumps(ex))
        (t / 'checkpoint.json').write_text('{"stub": "checkpoint"}')
        (t / 'l1.json').write_text(json.dumps({'format': 'enclave-l1-authority/v1', 'binary': {'path': '/nonexistent/helios', 'sha256': 'ab' * 32},
                                               'listen': {'ip': '127.0.0.1', 'port': 28550}, 'checkpointFile': str(t / 'checkpoint.json')}))
        (t / 'portal.json').write_text(json.dumps({'readSucceeded': True, 'asr': C.MAINNET['asr'], 'block': {'hash': '0x' + '11' * 32}}))
        (t / 'src/initial-receipt.json').write_text('{"stub": "initial receipt"}')
        node = self.cfg['node']
        self.csrc = C.Sources(initial_dir=t / 'src/initial', recheck_dir=t / 'src/recheck', l1_authority=t / 'src/l1_authority.py', l1_config=t / 'l1.json',
                              portal_result=t / 'portal.json', initial_receipt=t / 'src/initial-receipt.json', deps_root=t / 'src/deps', node=node)
        names = {'initial': ['a1-read.mjs', 'a1-anchor.mjs', 'vendor/anchor-bootstrap.mjs', 'test/deps.mjs'],
                 'recheck': ['a1-recheck-read.mjs', 'a1-recheck.mjs', 'a1-read.mjs', 'a1-anchor.mjs', 'vendor/anchor-bootstrap.mjs', 'test/deps.mjs']}
        mods = {m: {r: sha((d / r).read_bytes()) for r in names[m]} for m, d in (('initial', self.csrc.initial_dir), ('recheck', self.csrc.recheck_dir))}
        mods['recheck-capture'] = dict(mods['recheck'])
        libs = sorted({l.split()[-1] for l in pathlib.Path('/proc/self/maps').read_text().splitlines() if 'libpython' in l and '/' in l})
        pf = C.read_package(self.csrc.deps_root, 'fakehash')
        self.cpins = C.Pins(modules=mods, l1_authority=sha(self.csrc.l1_authority.read_bytes()), helios='ab' * 32,
                            a1_example=sha((self.csrc.initial_dir / 'a1-config.example.json').read_bytes()), initial=sha(self.csrc.initial_receipt.read_bytes()),
                            lock=sha((self.csrc.deps_root / 'package-lock.json').read_bytes()),
                            deps={'fakehash': ('1.0.0', C.tree_rows({r: sha(x) for r, x in pf.items()}))},
                            node_accepted={sha(pathlib.Path(os.path.realpath(node)).read_bytes()): {'provenance': 'test-observed'}},
                            python_accepted={sha(pathlib.Path(os.path.realpath(sys.executable)).read_bytes()): {'provenance': 'test-observed'}},
                            libpython_accepted={(sha(pathlib.Path(libs[0]).read_bytes()) if len(libs) == 1 else None): {'provenance': 'test-observed'}})
        self.ledger = self.d / 'etc/base-a1-admission.jsonl'; self.ncap = 0

    def capture(self, mode, initial=None):
        self.ncap += 1; out = self.d / f'cap-{self.ncap}'
        ok, res = self.C.capture(mode, out, src=self.C.Sources(**{**self.csrc.__dict__, 'initial_capture': initial}), pins=self.cpins,
                                 hooks={'poll': 0.05}, helios_timeout=20, a1_timeout=60)
        self.assertTrue(ok, res); return out

    def new_recheck(self, initial=None):
        """A NEW recheck-capture of the (given or configured) initial capture, named in the config for the next gated step."""
        ini = pathlib.Path(initial or self.cfg['reanchor']['a1Capture']['initialOut'])
        out = self.capture('recheck-capture', initial=ini)
        self.cfg['reanchor']['a1Capture']['recheckOut'] = str(out); self.cfg['a1Evidence'] = str(out / 'capture/evidence.json')
        return out

    def capture_recovery_config(self, prev_n):
        self.cap_setup(); iout = self.capture('initial')
        for k in R.A1_RECHECK_KEYS:
            self.cfg.pop(k, None)
        self.rk = None                                                              # no config-named receipt files in this mode
        self.cfg.update(a1Mode='capture-recheck', N=N2, outputRoot=FX2['outputRoot']); self.reanchor_config(prev_n)
        self.cfg['reanchor'].update(a1Capture={'initialOut': str(iout), 'recheckOut': str(self.d / 'none')}, admissionLedger=str(self.ledger))
        return iout

    def test_newer_anchor_recovers_through_real_initial_and_recheck_captures(self):
        self.launched(); self.assertEqual(self.start(), 'exec'); first = self.launch['anchor']
        self.node_ran(extra_headers=[(N2, FX2['header'])])
        prev = self.lsha; self.rollback('crash'); self.retire()
        self.gen += 1; self.cfg['workdir'] = str(self.d / f'work-{self.gen}')
        iout = self.capture_recovery_config(N1)
        for st in ('a2', 'a3', 'a4'):
            self.new_recheck(); rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        a2 = json.loads((pathlib.Path(self.cfg['workdir']) / 'a2-authenticated.json').read_bytes())['a1Gate']
        isum = self.C.verify(iout, pins=self.cpins, node=self.cfg['node'], workdir=str(self.d))
        self.assertEqual((a2['initialCapture']['captureSha256'], a2['initialSha256'], a2['N']), (isum['captureSha256'], isum['evidenceSha256'], str(N2)))
        self.checker(dict(TA.V2_GOOD, datadir=self.cfg['datadir'], checkpoints={k: N2 for k in TA.V2_GOOD['checkpoints']}))
        A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        rc, rec = self.run_step('bytecodes'); self.assertEqual(rc, 0, rec)
        self.new_recheck(); rc, rec = self.run_step('release'); self.assertEqual(rc, 0, rec)
        self.produce_successor(prev)
        self.assertEqual(self.launch['a1Capture']['initialCapture'], a2['initialCapture'])
        self.assertEqual((self.launch['anchor'], self.launch['predecessor']['anchor']), (f'{N2}:{FX2["blockHash"]}', first))
        self.arm(); self.assertEqual(self.start(), 'exec')
        self.assertEqual(self.execs()[-1][2][-2:], ['--bootstrap.anchor', f'{N2}:{FX2["blockHash"]}'])
        keys = set().union(*(json.loads(l)['keys'] for l in self.ledger.read_text().splitlines()))
        self.assertEqual(len([k for k in keys if k.startswith('capture:')]), 5, 'the initial + 4 rechecks, each admitted once')

    def test_capture_refusals_hold_replay_wrong_initial_tamper_pin_stale_ledger(self):
        self.launched(); self.start(); self.node_ran(extra_headers=[(N2, FX2['header'])])
        self.rollback('crash'); self.retire(); self.gen += 1; self.cfg['workdir'] = str(self.d / f'work-{self.gen}')
        iout = self.capture_recovery_config(N1); used = self.new_recheck()
        with patch.object(R, 'A1_CAPTURE_REVIEWED', False):
            self.step_refused('a2', 'a1_capture_pending')                          # the REAL default: HOLD
        rc, rec = self.run_step('a2'); self.assertEqual(rc, 0, rec)                 # admits the initial and this recheck
        self.step_refused('a3', 'a1_replayed')                                       # the same recheck again
        jout = self.capture('initial'); jr = self.capture('recheck-capture', initial=jout)
        self.cfg['reanchor']['a1Capture'] = {'initialOut': str(jout), 'recheckOut': str(jr)}; self.cfg['a1Evidence'] = str(jr / 'capture/evidence.json')
        self.step_refused('a3', 'a1_capture_binding')                                # another genuine initial than A2 recorded
        self.cfg['reanchor']['a1Capture']['initialOut'] = str(iout)
        self.step_refused('a3', 'a1_capture')                                        # a recheck of another initial
        self.new_recheck()
        with patch.object(R, 'A1_CAPTURE_SHA256', '00' * 32):
            self.step_refused('a3', 'a1_capture_pin')                                # module bytes are not the pin
        real_now = R.now
        with patch.object(R, 'now', lambda: TA.utcnow() + TA.datetime.timedelta(seconds=self.cfg['a1MaxAgeSec'] + 60)):
            self.step_refused('a3', 'a1_stale')
        self.assertIs(R.now, real_now, 'r7: the harness clock is restored after the stale probe')
        self.assertLess(abs((R.now() - TA.utcnow()).total_seconds()), 5, 'r7: and reads real time again')
        self.ledger.chmod(0o666); self.step_refused('a3', 'untrusted_file'); self.ledger.chmod(0o600)
        ev = iout / 'capture/evidence.json'; b = ev.read_bytes(); ev.chmod(0o600); ev.write_bytes(b[:-1] + b' '); ev.chmod(0o400)
        self.step_refused('a3', 'a1_capture')                                        # the initial tampered after A2
        ev.chmod(0o600); ev.write_bytes(b); ev.chmod(0o400)
        rc, rec = self.run_step('a3'); self.assertEqual(rc, 0, rec)                  # restored + this unused fresh recheck: passes
        self.assertEqual(self.st()['cp']['execution'], N2)

    def test_capture_mode_config_rules(self):
        TA.Recheck.use_recheck(self); self.write()
        cap = {'initialOut': str(self.d / 'i'), 'recheckOut': str(self.d / 'r')}
        base = {k: v for k, v in self.cfg.items() if k not in R.A1_RECHECK_KEYS}
        base.update(a1Mode='capture-recheck', a1Evidence=str(self.d / 'r/capture/evidence.json'),
                    reanchor={'predecessorN': N1, 'watermarkStore': str(self.store), 'a1Capture': cap, 'admissionLedger': str(self.d / 'l')})
        def probe(c):
            p = self.d / 'cfg-cap.json'; p.write_text(json.dumps(c)); return p
        self.assertEqual(A.load_config(probe(base))['a1Mode'], 'capture-recheck')
        self.bad_config(probe(dict(base, reanchor={k: v for k, v in base['reanchor'].items() if k != 'admissionLedger'})), 'go together')
        self.bad_config(probe(dict(base, a1RecheckSha256='aa' * 32)), 'belong to a1Mode original-game-recheck only')
        self.bad_config(probe(dict(base, a1Evidence=str(self.d / 'other.json'))), 'a1Evidence is the recheck capture evidence')
        self.bad_config(probe({k: v for k, v in base.items() if k != 'reanchor'}), 'exactly the re-anchor mode')
        orig = dict(self.cfg, reanchor=dict(base['reanchor']))
        self.bad_config(probe(orig), 'exactly the re-anchor mode')                  # a1Capture with original-game-recheck

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


class FinalityRestart(Recovery):
    """finality r5: `permit-restart` over the REAL harness (gate_static, stage checkpoints, header at the floor) on the fixture's
    fake reth, and the r5 wrapper consuming the permit. The recorded floor is put with the wrapper's own durable appends (a
    TEST stand-in for record-finality, which test_finality_integration.py covers with the real finality tool)."""
    def bootstrapped(self):
        self.launched(); self.assertEqual(self.start(), 'exec')
        self.node_ran(extra_headers=[(N2, FX2['header'])])
        c = A.load_config(self.d / 'cfg.json'); fh = A.header_hash(c, FX2['header'])
        os.makedirs(self.store, mode=0o755, exist_ok=True)
        es = W.watermark_append(self.store, self.uid, W.watermark_entries(self.store, self.uid, self.top), N2, fh, 'finality-proof', 'ab' * 32, 'at', self.top)
        js = W.journal_entries(self.out / 'journal', self.uid, self.lsha, self.top)
        W.journal_append(self.out / 'journal', self.uid, self.lsha, js, 'bootstrapped', {'watermarkEntrySha256': es[-1][0], 'finalityEntrySha256': 'ab' * 32,
                         'number': N2, 'blockHash': fh}, 'at', self.top)
        return fh

    def permit(self):
        return P.permit_restart(self.out, self.d / 'cfg.json', A=A, W=W, owner=self.uid, top=self.top, watermark=self.store)

    def last(self):
        return W.journal_entries(self.out / 'journal', self.uid, self.lsha, self.top)[-1][1]

    def test_permit_then_one_ordinary_restart_without_the_anchor(self):
        self.bootstrapped()
        self.assertIn('permit-restart', self.start())                              # bootstrapped alone never starts
        r = self.permit(); self.assertEqual(self.last()['event'], 'restart-permitted'); self.assertEqual(r['event'], 'restart-permitted')
        n = len(self.execs()); self.assertEqual(self.start(), 'exec'); self.assertEqual(self.last()['event'], 'restarted')
        self.assertNotIn('--bootstrap.anchor', ' '.join(map(str, self.execs()[n:])), 'the anchor is never replayed')
        self.assertIn('permit-restart', self.start())                              # the permit is consumed: a crash needs a new one

    def test_in_place_rollback_below_the_floor_refuses_same_inode(self):
        self.bootstrapped(); ino = os.stat(self.d / 'datadir/db/mdbx.dat').st_ino
        self.state['cp'] = {k: N2 - 100 for k in self.state['cp']}; self.state['headersTip'] = N2 - 100; self.write()
        self.assertEqual(os.stat(self.d / 'datadir/db/mdbx.dat').st_ino, ino, 'the same DB file (inode) - rolled back in place')
        self.refused(self.permit, 'below_floor'); self.assertEqual(self.last()['event'], 'bootstrapped')

    def test_another_block_at_the_floor_refuses(self):
        self.bootstrapped(); other = dict(FX2['header'], parentHash='0x' + '42' * 32)
        self.state['headers'][str(N2)] = other; self.write()
        self.refused(self.permit, 'floor_conflict')

    def test_db_written_after_the_permit_refuses_the_start(self):
        self.bootstrapped(); self.permit()
        (self.d / 'datadir/db/mdbx.dat').write_bytes(b'restored or rolled back after the permit')
        self.assertIn('changed since the restart permit', self.start()); self.assertEqual(self.last()['event'], 'restart-permitted')

    def test_unpatched_code_pin_refuses_the_fake_binary(self):
        """r7: with the PRODUCTION HARNESS_BINARY_SHA256 (no fixture override) the fake binary's launch refuses binary_pin"""
        self.launched()
        with patch.object(P, 'HARNESS_BINARY_SHA256', '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'):
            self.refused(lambda: P.bound_config(self.launch, self.d / 'cfg.json', A), 'binary_pin')

    def test_permit_only_for_a_bootstrapped_launch_and_rollback_stays_terminal(self):
        self.launched(); self.assertEqual(self.start(), 'exec')
        self.refused(self.permit, 'transition')                                    # consumed (no finality): r7 rules unchanged
        self.rollback('crash'); self.refused(self.permit, 'transition')



for _n in [n for n in dir(Recovery) if n.startswith('test_')]:   # r6: run only FinalityRestart's own tests (r5 re-ran 14 inherited)
    setattr(FinalityRestart, _n, None)

class Ledger(unittest.TestCase):
    """admit_captures() alone, with the REAL capture module's admit() rule; no capture needed (summaries are the three ids)."""
    def setUp(self):
        self.tmp = pathlib.Path(__import__('tempfile').mkdtemp(prefix='ledger-')); (self.tmp / 'etc').mkdir(mode=0o755)
        self.p = self.tmp / 'etc/a1-admission.jsonl'; self.lock = self.tmp / 'etc/a1-admission.jsonl.lock'
        st = contextlib.ExitStack(); self.addCleanup(st.close); self.addCleanup(shutil.rmtree, self.tmp, True)
        st.enter_context(patch.object(R, 'A1_CAPTURE_REVIEWED', True)); st.enter_context(patch.object(R, 'A1_CAPTURE_SOURCE', CAP_SRC))
        st.enter_context(patch.object(R, 'A1_ADMISSION_LEDGER', self.p))           # finality r5 port: the harness's shared-ledger path
        self.n = 0

    def c(self, workdir='w0'):
        return {'workdir': str(self.tmp / workdir), 'reanchor': {'admissionLedger': str(self.p)}}

    def summary(self):
        self.n += 1; h = lambda t: hashlib.sha256(f'{t}{self.n}'.encode()).hexdigest()
        return {'captureId': h('id')[:32], 'captureSha256': h('rec'), 'evidenceSha256': h('ev')}

    def code(self, fn):
        with self.assertRaises(R.Refused) as e:
            fn()
        return str(e.exception).split(':')[0]

    def recs(self):
        return R.ledger_records(self.p)[0]

    def child(self, fn, go=None):
        """A REAL separate process; exit 0 = admitted, 3 = refused (code written), 4 = other error."""
        r, w = os.pipe(); sys.stdout.flush(); sys.stderr.flush(); pid = os.fork()
        if pid == 0:
            try:
                os.close(r)
                if go is not None:
                    os.read(go, 1)
                fn(); os.write(w, b'admitted'); os._exit(0)
            except R.Refused as e:
                os.write(w, str(e).encode()); os._exit(3)
            except BaseException as e:                   # noqa: BLE001
                os.write(w, f'error {type(e).__name__}: {e}'.encode()); os._exit(4)
        os.close(w)
        return pid, r

    def reap(self, pid, r):
        out = b''
        while (b := os.read(r, 65536)):
            out += b
        os.close(r); _, st = os.waitpid(pid, 0); return st, out.decode()

    def test_once_only_strict_canonical_chain(self):
        s1, s2 = self.summary(), self.summary()
        R.admit_captures(self.c(), [s1]); self.assertEqual(self.code(lambda: R.admit_captures(self.c('w1'), [s1])), 'a1_replayed')
        R.admit_captures(self.c(), [s2]); recs = self.recs()
        self.assertEqual([r['seq'] for _, r in recs], [1, 2]); self.assertEqual(recs[1][1]['prevSha256'], recs[0][0])
        self.assertEqual(self.p.read_bytes(), b''.join(R.ledger_line(r) for _, r in recs))
        self.assertEqual(oct(self.lock.stat().st_mode & 0o777), '0o600'); self.assertEqual(oct(self.p.stat().st_mode & 0o777), '0o600')
        self.assertEqual(self.code(lambda: R.admit_captures(self.c(), [s1, self.summary()])), 'a1_replayed')   # all-or-nothing
        self.assertEqual(len(self.recs()), 2)

    def test_same_capture_race_from_different_workdirs_admits_exactly_once(self):
        """There is NO per-workdir lock in the harness: different workdirs serialize only on the ledger lock. Six processes
        start together while the parent holds that lock, then race."""
        s = self.summary(); R.admit_captures(self.c(), [self.summary()])                     # an existing ledger
        hold = os.open(self.lock, os.O_RDWR); fcntl.flock(hold, fcntl.LOCK_EX)
        go_r, go_w = os.pipe()
        kids = [self.child(lambda i=i: R.admit_captures(self.c(f'workdir-{i}'), [s]), go=go_r) for i in range(6)]
        os.write(go_w, b'G' * 6); __import__('time').sleep(0.3); fcntl.flock(hold, fcntl.LOCK_UN); os.close(hold)
        res = [self.reap(*k) for k in kids]
        codes = sorted(os.WEXITSTATUS(st) for st, _ in res)
        self.assertEqual(codes, [0, 3, 3, 3, 3, 3], res)
        self.assertTrue(all(o.startswith('a1_replayed:') for st, o in res if os.WEXITSTATUS(st) == 3), res)
        recs = self.recs(); self.assertEqual(len(recs), 2)
        self.assertEqual(len([k for _, r in recs for k in r['keys'] if k == 'capture:' + s['captureId']]), 1)

    def test_a_held_lock_refuses_busy_without_writing(self):
        R.admit_captures(self.c(), [self.summary()]); before = self.p.read_bytes()
        hold = os.open(self.lock, os.O_RDWR); fcntl.flock(hold, fcntl.LOCK_EX)
        try:
            with patch.object(R, 'LEDGER_LOCK_TIMEOUT_SEC', 0.3):
                self.assertEqual(self.code(lambda: R.admit_captures(self.c('other'), [self.summary()])), 'a1_ledger_busy')
        finally:
            os.close(hold)
        self.assertEqual(self.p.read_bytes(), before)

    def test_interrupted_appends_fail_closed_and_never_duplicate(self):
        R.admit_captures(self.c(), [self.summary()])
        real_write, real_fsync, real_open = os.write, os.fsync, os.open
        def kill():
            os.kill(os.getpid(), signal.SIGKILL)
        # (1) SIGKILL after HALF the record bytes: an incomplete tail -> ambiguous -> nothing admitted, by anyone, until root resolves
        s = self.summary()
        def half_then_die():
            with patch.object(R.os, 'write', lambda fd, data: (real_write(fd, bytes(data)[:len(data) // 2]), kill())):
                R.admit_captures(self.c('k1'), [s])
        st, out = self.reap(*self.child(half_then_die)); self.assertTrue(os.WIFSIGNALED(st), out)
        self.assertFalse(self.p.read_bytes().endswith(b'\n'))
        for x in (s, self.summary()):
            self.assertEqual(self.code(lambda: R.admit_captures(self.c(), [x])), 'a1_ledger')
        good = self.p.read_bytes().rsplit(b'\n', 1)[0] + b'\n'; self.p.write_bytes(good)        # (root's explicit repair)
        # (2) SIGKILL right AFTER the fsync: the record is complete -> admitted exactly once
        s2 = self.summary()
        def die_after_fsync():
            with patch.object(R.os, 'fsync', lambda fd: (real_fsync(fd), kill())):
                R.admit_captures(self.c('k2'), [s2])
        st, out = self.reap(*self.child(die_after_fsync)); self.assertTrue(os.WIFSIGNALED(st), out)
        self.assertEqual(self.code(lambda: R.admit_captures(self.c(), [s2])), 'a1_replayed')
        # (3) SIGKILL after C.admit() in memory but BEFORE the append: nothing durable -> the capture is admitted once, later
        s3 = self.summary(); n = len(self.recs())
        def die_before_write():
            with patch.object(R.os, 'open', lambda path, flags, *a: kill() if flags & os.O_APPEND else real_open(path, flags, *a)):
                R.admit_captures(self.c('k3'), [s3])
        st, out = self.reap(*self.child(die_before_write)); self.assertTrue(os.WIFSIGNALED(st), out)
        self.assertEqual(len(self.recs()), n, 'the in-memory admission of the killed process left nothing')
        R.admit_captures(self.c(), [s3]); self.assertEqual(self.code(lambda: R.admit_captures(self.c(), [s3])), 'a1_replayed')
        R.admit_captures(self.c(), [self.summary()])                                         # the lock was never left held

    def test_tampered_or_unsafe_ledger_refuses_without_writing(self):
        R.admit_captures(self.c(), [self.summary()]); R.admit_captures(self.c(), [self.summary()])
        good = self.p.read_bytes(); l1, l2 = good.split(b'\n')[:2]; r1, r2 = json.loads(l1), json.loads(l2)
        line = lambda r: R.ledger_line(r)
        crafted = {
            'duplicate key': line(r1) + line(dict(r2, keys=sorted(set(r2['keys']) | {r1['keys'][0]}))),
            'seq gap': line(r1) + line(dict(r2, seq=3)),
            'chain': line(r1) + line(dict(r2, prevSha256='00' * 32)),
            'extra field': line(r1) + line(dict(r2, note='x')),
            'unsorted keys': line(r1) + line(dict(r2, keys=list(reversed(r2['keys'])))),
            'empty keys': line(r1) + line(dict(r2, keys=[])),
            'bad key': line(r1) + line(dict(r2, keys=['capture:XYZ'])),
            'format': line(dict(r1, format='other')) + line(r2),
            'non-canonical': json.dumps(r1).encode() + b'\n' + l2 + b'\n',
            'not json': line(r1) + b'{nope\n',
            'blank line': line(r1) + b'\n' + line(r2),
        }
        for why, b in crafted.items():
            with self.subTest(why):
                self.p.write_bytes(b); self.assertEqual(self.code(lambda: R.admit_captures(self.c(), [self.summary()])), 'a1_ledger')
                self.assertEqual(self.p.read_bytes(), b)
        self.p.write_bytes(good)
        unsafe = [(lambda: self.p.chmod(0o666), lambda: self.p.chmod(0o600)),
                  (lambda: self.lock.chmod(0o644), lambda: self.lock.chmod(0o600)),
                  (lambda: (self.tmp / 'etc').chmod(0o777), lambda: (self.tmp / 'etc').chmod(0o755)),
                  (lambda: (self.lock.rename(self.tmp / 'real.lock'), self.lock.symlink_to(self.tmp / 'real.lock')),
                   lambda: (self.lock.unlink(), (self.tmp / 'real.lock').rename(self.lock))),
                  (lambda: (self.p.rename(self.tmp / 'real.jsonl'), self.p.symlink_to(self.tmp / 'real.jsonl')),
                   lambda: (self.p.unlink(), (self.tmp / 'real.jsonl').rename(self.p)))]
        for do, undo in unsafe:
            do()
            try:
                self.assertEqual(self.code(lambda: R.admit_captures(self.c(), [self.summary()])), 'untrusted_file')
            finally:
                undo()
        self.assertEqual(self.p.read_bytes(), good); R.admit_captures(self.c(), [self.summary()])


if __name__ == '__main__':
    unittest.main(verbosity=2)
