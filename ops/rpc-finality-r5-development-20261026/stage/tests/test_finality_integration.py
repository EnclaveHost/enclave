#!/usr/bin/env python3
"""base-finality-proof-stage/r5 REAL-TOOL integration (PREPARED; NOT run by Claude: jobs/root-finality-r5-tests.sh, exact count 11).
Every decision is made by the real code: the r5 recovery harness (r7 + the shared-ledger path) (capture_binding, pinned A1 gate, gate_a1, the durable admission
ledger, gate_watermark) executing the REAL capture r4 module (pinned bytes) over that stage's own stub sources and r7's capture
stubs (as r7's tests do: test-observed runtime pins, A1_CAPTURE_REVIEWED patched in THIS process only); the r5 finality tool and
its pinned JS core over a loopback JSON-RPC chain (r2 helpers); the r5 wrapper (journal, lock, watermark, launch_finality,
launch_handshake) and the r5 producer (record_finality). Test seams only: OWNER/TRUSTED_UID = this uid, a fake /proc root, the
watermark/archive paths, and - in the handshake checks - launch_record (its qualification files are covered by r7's suites).
Every reviewed flag is False in the sources; each test patches what it exercises for its own duration."""
import contextlib, functools, hashlib, importlib.util, json, os, pathlib, shutil, sys, tempfile, types, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent; ROOT = HERE.parent
WORK = pathlib.Path(os.environ.get('PRODUCER_WORK', '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025'))
R7 = WORK / 'base-reanchor-recovery-stage/r7'; CAP_STAGE = WORK / 'a1-capture-binding-stage/r4'; CAP_SRC = CAP_STAGE / 'src/a1_capture.py'
STAGE = WORK / 'source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage'
sys.path.insert(0, str(STAGE / 'test')); sys.path.insert(0, str(HERE))
import test_a2a4 as TA                                               # the harness fixture's A1 receipt builder (fresh_a1)
import test_finality_state as T2                                    # r5 tool tests: Stub, CHAIN, N, NP, L1 (loads ../src/finality_state)
import readiness_sampler as RS                                      # the r5 readiness gate (T2 put ../readiness on sys.path)
FS = T2.FS
def load(name, p):
    s = importlib.util.spec_from_file_location(name, p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
R = load('a2a4_recovery_r5', ROOT / 'harness/a2a4.py'); R.TRUSTED_UID = os.getuid()
W = load('chain_service_r5', ROOT / 'wrapper/chain_service.py')
P = load('base_launch_r5', ROOT / 'producer/base_launch.py')
NODE, DEPS = os.path.realpath(os.environ['FINALITY_NODE']), os.environ['ANCHOR_DEPS_ROOT']
sha = lambda b: hashlib.sha256(b).hexdigest()
N, NP, CHAIN = T2.N, T2.NP, T2.CHAIN; NP2 = NP + 20; GAME0 = '0x' + 'cd' * 20


class Integration(unittest.TestCase):
    def setUp(self):
        self.uid = os.getuid(); t = self.t = pathlib.Path(tempfile.mkdtemp(prefix='fin4-')); self.addCleanup(shutil.rmtree, t, True)
        for k in ('etc', 'work', 'finality', 'data/db'):
            (t / k).mkdir(parents=True)
        os.chmod(t / 'work', 0o700); (t / 'data/db/mdbx.dat').write_bytes(b'db'); st = os.stat(t / 'data/db/mdbx.dat')
        self.release = b'base-release-binary'; self.store = t / 'etc/wm'; self.ledger = t / 'etc/base-a1-admission.jsonl'; self.fdir = t / 'finality'
        stack = contextlib.ExitStack(); self.addCleanup(stack.close)
        for obj, k, v in ((R, 'A1_CAPTURE_REVIEWED', True), (R, 'A1_CAPTURE_SOURCE', CAP_SRC), (R, 'A1_CAPTURE_TEST_PINS', lambda: self.cpins),
                          (W, 'A1_ADMISSION_LEDGER', self.ledger), (R, 'A1_ADMISSION_LEDGER', self.ledger), (W, 'BOOTSTRAP_WATERMARK', self.store), (W, 'BOOTSTRAP_ARCHIVE', t / 'etc/archive')):
            stack.enter_context(patch.object(obj, k, v))
        self.cap_setup(stack)
        self.launch = {'format': W.LAUNCH_FORMAT, 'anchor': f'{N}:{CHAIN["headers"][str(N)]["hash"]}', 'baseReleaseSha256': sha(self.release),
                       'bindings': {'datadir': str(t / 'data'), 'dbIdentity': {'mdbx': {'dev': st.st_dev, 'ino': st.st_ino, 'size': 2, 'mtimeNs': 0}},
                                    'a1': {'N': str(N), 'outputRoot': CHAIN['outputRoots'][str(N)], 'game': GAME0, 'l1Finalized': 1, 'initialSha256': 'x'}}}
        self.stub = T2.Stub(CHAIN); self.addCleanup(self.stub.close); self.url = f'http://127.0.0.1:{self.stub.port}/'; self.proc_start = '111'

    # ---- the real capture module over its own stubs (r7 cap_setup, verbatim pins) -------------------------------------
    def cap_setup(self, stack):
        C = self.C = R.load_capture(); stack.enter_context(patch.object(C, 'OWNER', self.uid))
        t = self.t / 'capsrc'; shutil.copytree(CAP_STAGE / 'tests/stubs', t / 'src')
        shutil.copyfile(R7 / 'tests/capture-stubs/a1-read.mjs', t / 'src/initial/a1-read.mjs')
        shutil.copyfile(R7 / 'tests/capture-stubs/a1-recheck-read.mjs', t / 'src/recheck/a1-recheck-read.mjs')
        self.tpl = t / 'receipt-template.json'
        ex = json.loads((t / 'src/initial/a1-config.example.json').read_text()); ex['fixtureReceipt'] = str(self.tpl)
        (t / 'src/initial/a1-config.example.json').write_text(json.dumps(ex))
        (t / 'checkpoint.json').write_text('{"stub": "checkpoint"}')
        (t / 'l1.json').write_text(json.dumps({'format': 'enclave-l1-authority/v1', 'binary': {'path': '/nonexistent/helios', 'sha256': 'ab' * 32},
                                               'listen': {'ip': '127.0.0.1', 'port': 28550}, 'checkpointFile': str(t / 'checkpoint.json')}))
        (t / 'portal.json').write_text(json.dumps({'readSucceeded': True, 'asr': C.MAINNET['asr'], 'block': {'hash': '0x' + '11' * 32}}))
        (t / 'src/initial-receipt.json').write_text('{"stub": "initial receipt"}')
        self.csrc = C.Sources(initial_dir=t / 'src/initial', recheck_dir=t / 'src/recheck', l1_authority=t / 'src/l1_authority.py', l1_config=t / 'l1.json',
                              portal_result=t / 'portal.json', initial_receipt=t / 'src/initial-receipt.json', deps_root=t / 'src/deps', node=NODE)
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
                            node_accepted={sha(pathlib.Path(NODE).read_bytes()): {'provenance': 'test-observed'}},
                            python_accepted={sha(pathlib.Path(os.path.realpath(sys.executable)).read_bytes()): {'provenance': 'test-observed'}},
                            libpython_accepted={(sha(pathlib.Path(libs[0]).read_bytes()) if len(libs) == 1 else None): {'provenance': 'test-observed'}})
        self.ncap = 0

    def captures(self, n, l1_bump=0):
        """A REAL initial capture naming game/N/root of block n, plus a REAL recheck-capture of exactly it."""
        e = TA.fresh_a1(TA.utcnow() - TA.datetime.timedelta(hours=1), root=CHAIN['outputRoots'][str(n)]); e['N'] = str(n)
        e['l1'] = {**e['l1'], 'number': e['l1']['number'] + l1_bump}; self.tpl.write_text(json.dumps(e))
        outs = []
        for mode in ('initial', 'recheck-capture'):
            self.ncap += 1; out = self.t / f'cap-{self.ncap}'
            ok, res = self.C.capture(mode, out, src=self.C.Sources(**{**self.csrc.__dict__, 'initial_capture': outs[0] if outs else None}),
                                     pins=self.cpins, hooks={'poll': 0.05}, helios_timeout=20, a1_timeout=60)
            self.assertTrue(ok, res); outs.append(out)
        return {'initialOut': str(outs[0]), 'recheckOut': str(outs[1])}

    # ---- the launch: real wrapper journal; a fake /proc root bound to the stub's port --------------------------------
    def launched(self, watermark_binding=False):
        if watermark_binding:
            self.launch['watermark'] = {'entrySha256': None}
        self.d = self.t / 'launch'; (self.d / 'journal').mkdir(parents=True)
        lb = json.dumps(self.launch, sort_keys=True).encode(); (self.d / 'launch.json').write_bytes(lb); self.lsha = sha(lb)
        (self.t / 'chain.json').write_text(json.dumps({'baseBootstrap': {'anchorLaunch': {'launchSha256': self.lsha}}}))
        os.close(os.open(self.d / 'journal.lock', os.O_CREAT | os.O_RDWR, 0o600))
        es = []
        for ev in ('armed', 'consumed'):
            es = W.journal_append(self.d / 'journal', self.uid, self.lsha, es, ev, {'test': ev}, 'at', self.t)
        self.proc(self.proc_start)

    def proc(self, start):
        p = self.t / 'proc'; shutil.rmtree(p, ignore_errors=True); (p / 'net').mkdir(parents=True)
        (p / 'net/tcp').write_text(f'  sl local rem st tx rx tr tm retr uid timeout inode\n  0: 0100007F:{self.stub.port:04X} 00000000:0000 0A 0 0 0 0 0 900 1\n')
        pd = p / '4242'; (pd / 'fd').mkdir(parents=True)
        os.symlink('socket:[900]', pd / 'fd/3'); os.symlink(self.t / 'data/db/mdbx.dat', pd / 'fd/4')
        (pd / 'exe').write_bytes(self.release); (pd / 'stat').write_text(f'4242 (base) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0\n')
        self.procdir = str(p)

    def qualify(self, cap, write=True):
        with patch.object(FS, 'FINALITY_PROTOTYPE_REVIEWED', True):
            return FS.qualify(self.d, self.t / 'chain.json', self.fdir, cap, self.url, W=W, R=R, node=NODE, deps_root=DEPS, workdir=self.t / 'work',
                              write=write, top=self.t, proc=self.procdir, chunk=32)

    def F(self, status=None):
        """the REAL tool's functions; only status gets this test's /proc root (the producer passes none)"""
        return types.SimpleNamespace(OWNER=FS.OWNER, Refused=FS.Refused, load_launch=FS.load_launch, entries=FS.entries,
                                     status=status or functools.partial(FS.status, proc=self.procdir))

    def record(self, F=None):
        with patch.object(P, 'FINALITY_PROOF_REVIEWED', True):
            return P.record_finality(self.d, self.t / 'chain.json', self.fdir, self.url, W=W, F=F or self.F(), owner=self.uid, top=self.t, watermark=self.store)

    def journal(self):
        return W.journal_entries(self.d / 'journal', self.uid, self.lsha, self.t)

    def wm(self):
        return [(e['kind'], e['number']) for _, e in W.watermark_entries(self.store, self.uid, self.t)]

    def handshake(self):
        fd = W.launch_lock(self.d, self.uid, self.t)
        try:
            with patch.object(W, 'launch_record', lambda *a, **k: (self.lsha, self.launch, N)), patch.object(W, 'LAUNCH_PRODUCER_REVIEWED', True):
                return W.launch_handshake(fd, {}, sha(self.release), directory=self.d, owner=self.uid, top=self.t)
        finally:
            os.close(fd)

    def refused(self, mod, code, fn, *a, **k):
        with self.assertRaises(mod.Refused) as cm:
            fn(*a, **k)
        got = cm.exception.code if mod is FS else str(cm.exception).split(':', 1)[0]
        self.assertEqual(got, code, str(cm.exception))

    def permit(self):
        """TEST stand-in for the producer's permit-restart (its REAL-harness stopped-DB checks run in r7-ported FinalityRestart)"""
        own = W.launch_finality(self.launch, self.lsha, self.journal(), self.store, self.uid, self.t); st = os.stat(self.t / 'data/db/mdbx.dat')
        W.journal_append(self.d / 'journal', self.uid, self.lsha, self.journal(), 'restart-permitted',
                         {'floor': {'entrySha256': own[-1][0], 'number': own[-1][1]['number'], 'blockHash': own[-1][1]['blockHash']},
                          'mdbx': {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns}}, 'at', self.t)

    def status(self):
        return FS.status(self.d, self.t / 'chain.json', self.fdir, self.url, W=W, top=self.t, proc=self.procdir)

    def reanchor_gate(self, cap, n, ledger=None):
        """the RE-ANCHOR path's own admission of a capture (harness gate_a1 at A2) into the same shared ledger"""
        w = self.t / f'ra-{self.ncap}'; w.mkdir(mode=0o700)
        c = {'workdir': str(w), 'node': NODE, 'a1GateDir': str(ROOT / 'a1gate'), 'a1MaxAgeSec': 600, 'a1Mode': 'capture-recheck', 'N': n,
             'outputRoot': CHAIN['outputRoots'][str(n)], 'game': json.loads(self.tpl.read_text())['game'],
             'reanchor': {'a1Capture': cap, 'admissionLedger': str(ledger or W.A1_ADMISSION_LEDGER)}}
        return R.gate_a1(c, at_a2=True)

    # ==== tests =========================================================================================================
    def test_first_bootstrap_floor_restart_requalify_and_retained_floor(self):
        self.launched(); cap = self.captures(NP)
        self.assertEqual(self.qualify(cap, write=False)['event'], None); self.assertFalse(self.ledger.exists(), 'check wrote the shared ledger')
        r = self.qualify(cap); self.assertEqual((r['event'], r['fresh']['N'], r['a1']['admitted']), ('qualified', NP, 'shared-ledger'))
        self.assertEqual(len(R.ledger_records(self.ledger)[0]), 1)
        self.refused(P, 'hold_finality', P.record_finality, self.d, self.t / 'chain.json', self.fdir, self.url, W=W, F=self.F(), owner=self.uid, top=self.t)
        self.assertFalse(self.store.exists())
        self.assertTrue(self.record()['appended']); self.assertEqual(self.wm(), [('finality-proof', NP)])       # the FIRST floor
        self.assertEqual(self.journal()[-1][1]['event'], 'bootstrapped')
        self.assertFalse(self.record()['appended'])                                                         # idempotent
        s = self.status(); self.assertEqual((s['state'], s['recordedAs']), ('qualified', self.journal()[-1][0]))   # r5: current right after record
        with self.assertRaisesRegex(AssertionError, 'permit-restart'):
            self.handshake()                                                                                # bootstrapped alone never starts
        self.permit(); self.assertEqual(self.handshake(), [], 'one ordinary restart: no --bootstrap.anchor (never replayed)')
        self.assertEqual(self.journal()[-1][1]['event'], 'restarted'); self.proc('999')                    # the node restarted
        self.assertEqual(self.status()['state'], 'stale-launch-changed')
        self.refused(P, 'not_qualified', self.record)                                                       # requalification required
        self.refused(FS, 'not_newer', self.qualify, self.captures(NP, l1_bump=50))
        r2 = self.qualify(self.captures(NP2, l1_bump=100)); self.assertEqual(r2['priorChecked'], [NP])
        self.assertTrue(self.record()['appended']); self.assertEqual(self.wm(), [('finality-proof', NP), ('finality-proof', NP2)])
        with self.assertRaisesRegex(R.Refused, '^watermark_below'):                                         # a re-anchor below the floor
            R.gate_watermark({'N': NP2 - 1, 'reanchor': {'watermarkStore': str(self.store)}}, None)

    def test_shared_ledger_refuses_replay_in_both_directions(self):
        self.launched()
        a = self.captures(NP); self.reanchor_gate(a, NP)                                                    # re-anchor admitted it first
        self.refused(FS, 'a1_replayed', self.qualify, a); self.assertEqual(os.listdir(self.fdir), [])
        b = self.captures(NP, l1_bump=10); self.assertEqual(self.qualify(b)['event'], 'qualified')
        with self.assertRaisesRegex(R.Refused, '^a1_replayed'):
            self.reanchor_gate(b, NP)                                                                       # finality admitted it first

    def test_interrupted_record_is_adopted_never_a_trap(self):
        self.launched(); self.qualify(self.captures(NP))
        real = P._append
        with patch.object(P, '_append', side_effect=OSError('crash after the watermark entry landed')):
            with self.assertRaises(OSError):
                self.record()
        self.assertEqual(self.wm(), [('finality-proof', NP)]); self.assertEqual(self.journal()[-1][1]['event'], 'consumed')
        with self.assertRaisesRegex(AssertionError, 'not exactly its recorded finality proofs'):
            W.launch_finality(self.launch, self.lsha, self.journal(), self.store, self.uid, self.t)
        self.assertIs(P._append, real); r = self.record(); self.assertTrue(r['adopted'])
        self.assertEqual(self.wm(), [('finality-proof', NP)]); self.assertEqual(self.status()['state'], 'qualified')
        self.assertEqual(len(W.launch_finality(self.launch, self.lsha, self.journal(), self.store, self.uid, self.t)), 1)

    def test_identity_change_at_append_refuses_and_writes_nothing(self):
        self.launched(); self.qualify(self.captures(NP)); calls = []
        def status(*a, **k):
            calls.append(1)
            if len(calls) == 2:
                self.proc('555')                                                                            # restarted between checks
            return FS.status(*a, proc=self.procdir, **k)
        self.refused(P, 'not_qualified', self.record, F=self.F(status=status))
        self.assertEqual((self.wm(), self.journal()[-1][1]['event']), ([], 'consumed'))

    def test_before_finality_a_consumed_launch_still_refuses_restart(self):
        self.launched()
        with self.assertRaisesRegex(AssertionError, 'already consumed'):
            self.handshake()
        self.qualify(self.captures(NP)); self.record(); self.permit()
        (self.t / 'data/db/other').write_bytes(b'other db'); os.replace(self.t / 'data/db/other', self.t / 'data/db/mdbx.dat')   # another DB file
        with self.assertRaisesRegex(AssertionError, 'changed since the restart permit'):
            self.handshake()

    def test_rollback_after_bootstrapped_is_terminal_and_rearm_never_allowed(self):
        self.launched(); self.qualify(self.captures(NP)); self.record()
        with self.assertRaisesRegex(AssertionError, "'bootstrapped' -> 'rearmed' is not allowed"):
            W.journal_append(self.d / 'journal', self.uid, self.lsha, self.journal(), 'rearmed', {}, 'at', self.t)
        P.rollback(self.d, 'crash', W=W, owner=self.uid, top=self.t)
        self.refused(P, 'transition', self.record)
        with self.assertRaisesRegex(AssertionError, 'rolled back'):
            self.handshake()
        self.refused(FS, 'rolled_back', self.qualify, self.captures(NP2, l1_bump=100))

    def test_reanchor_launch_appends_after_its_own_anchor_and_refuses_foreign_entries(self):
        self.launched(watermark_binding=True)
        W.watermark_append(self.store if self.store.exists() else (self.store.mkdir() or self.store), self.uid, [], N, self.launch['anchor'].split(':')[1],
                           'launch-anchor', self.lsha, 'at', self.t)
        self.qualify(self.captures(NP)); self.assertTrue(self.record()['appended'])
        self.assertEqual(self.wm(), [('launch-anchor', N), ('finality-proof', NP)])
        es = W.watermark_entries(self.store, self.uid, self.t)
        W.watermark_append(self.store, self.uid, es, NP + 5, '0x' + '77' * 32, 'launch-anchor', 'ef' * 32, 'at', self.t)
        with self.assertRaisesRegex(AssertionError, 'not exactly its recorded finality proofs'):
            W.launch_finality(self.launch, self.lsha, self.journal(), self.store, self.uid, self.t)

    def test_harness_refuses_another_ledger_path_before_any_admission(self):
        self.launched(); cap = self.captures(NP); other = self.t / 'etc/other-ledger.jsonl'
        with self.assertRaisesRegex(R.Refused, '^a1_ledger_path'):
            self.reanchor_gate(cap, NP, ledger=other)                                                       # the re-anchor path itself
        self.assertFalse(other.exists() or other.with_name(other.name + '.lock').exists(), 'nothing read-locked or written there')
        with patch.object(W, 'A1_ADMISSION_LEDGER', other):
            self.refused(FS, 'a1_ledger_path', self.qualify, cap)                                           # wrapper and harness disagree
        self.assertFalse(self.ledger.exists())

    def test_readiness_gate_requires_a_post_restart_proof_end_to_end(self):
        self.launched(); self.qualify(self.captures(NP)); self.record()
        (self.t / 'run').mkdir(); out = self.t / 'run/base-finality-status.json'
        a = types.SimpleNamespace(finality_status=str(out), finality_status_uid=self.uid, proc_root=self.procdir)
        def gate(exc=None):
            if exc is None:
                return RS.validate_finality_status(a)
            with self.assertRaises(exc) as cm:
                RS.validate_finality_status(a)
            return cm.exception.code
        FS.publish_status(self.status(), out, top=self.t); self.assertEqual(gate()['freshN'], NP)       # current right after record
        self.permit(); self.handshake(); self.proc('777')                                                   # one ordinary restart
        self.assertEqual(gate(RS.Unavailable), 'finality-stale-after-restart')                              # the old proof's process is gone
        FS.publish_status(self.status(), out, top=self.t); self.assertEqual(gate(RS.Unavailable), 'finality-not-current')
        self.qualify(self.captures(NP2, l1_bump=100))                                                       # the post-restart proof
        FS.publish_status(self.status(), out, top=self.t); self.assertEqual(gate()['freshN'], NP2)
        self.record(); FS.publish_status(self.status(), out, top=self.t); self.assertEqual(gate()['freshN'], NP2)

    def test_dependency_tamper_refuses_core_runs_only_pinned_bytes(self):
        self.launched(); cap = self.captures(NP)
        bad = self.t / 'deps'; shutil.copytree(pathlib.Path(DEPS, 'node_modules/@noble/hashes'), bad / 'node_modules/@noble/hashes')
        f = bad / 'node_modules/@noble/hashes/sha3.js'; f.write_bytes(f.read_bytes() + b'\n// tampered\n')
        with patch.object(FS, 'FINALITY_PROTOTYPE_REVIEWED', True):
            with self.assertRaises(FS.Refused) as cm:
                FS.qualify(self.d, self.t / 'chain.json', self.fdir, cap, self.url, W=W, R=R, node=NODE, deps_root=bad, workdir=self.t / 'work',
                           write=False, top=self.t, proc=self.procdir, chunk=32)
        self.assertEqual(cm.exception.code, 'deps')

    def test_capture_hold_and_unreviewed_tool_write_nothing(self):
        self.launched(); cap = self.captures(NP)
        with patch.object(R, 'A1_CAPTURE_REVIEWED', False):
            self.refused(FS, 'a1_capture_pending', self.qualify, cap)
        self.refused(FS, 'hold_prototype', FS.qualify, self.d, self.t / 'chain.json', self.fdir, cap, self.url, W=W, R=R, node=NODE, deps_root=DEPS,
                     workdir=self.t / 'work', write=True, top=self.t, proc=self.procdir)
        self.assertFalse(self.ledger.exists()); self.assertEqual(os.listdir(self.fdir), [])
        for flag in (P.FINALITY_PROOF_REVIEWED, FS.FINALITY_PROTOTYPE_REVIEWED, W.LAUNCH_PRODUCER_REVIEWED):
            self.assertIs(flag, False)


if __name__ == '__main__':
    unittest.main()
