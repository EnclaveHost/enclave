"""Offline tests of the one-shot launch handshake (r3 suite over the UNCHANGED r2 wrapper 07276ec8 and producer 7e8d295d).

Every start goes through the wrapper's REAL run('base'): every existing gate runs, faked only at the system/RPC boundary
exactly as the existing wrapper suite does, and os.execve is a fake executor. Launch records are produced and armed by the
producer from workdirs of the REAL A2-A4 harness (a2-v2-release-bound a2a4.main over that stage's own fake-base fixture; no
reth, no network). Crashes are REAL (forked children SIGKILL themselves at the named point); concurrency is REAL (forked
processes race for the same flock, sequenced by pipes, no sleeps). Root runs these; Claude did not.

r2 -> r3 (root run root-launch-handshake-r2-0148: 12 errors, all `a1:` in produce): the fixture's default A1 mode
(fresh-initial) records the sha of a synthetic receipt, which can never equal the production A1_INITIAL_SHA256, and the
producer correctly refused. r3 uses the fixture's own original-game-recheck mode (TA.Recheck.use_recheck: initial receipt +
recheck + run record, bound to the synthetic header root) whose CONSISTENT test pin the fixture sets in A.A1_INITIAL_SHA256.

TEST-ONLY substitutions (each reset by setUp/tearDown; no production check is weakened or bypassed):
  - A.A1_INITIAL_SHA256: the fixture's recheck-mode initial-receipt sha (TA.Case.setUp restores the production pin; asserted)
  - A.BYTECODE_CHECKER_V2_SHA256: the fake checker's sha (as the harness's own BytecodeGate tests do)
  - a fake release binary + its sha, a test-owned trusted top/uid, W.LAUNCH_PRODUCER_REVIEWED=True inside the wrapper module
  - service_identity/drop_privileges inside the call path (recorded, not performed: no rpcbase account in the namespace);
    drop_privileges itself is unit-tested with mocked os calls. The real drop needs root's guest canary."""
import contextlib, datetime, hashlib, json, os, pathlib, select, signal, sys, unittest
from unittest.mock import call, patch

HERE = pathlib.Path(__file__).resolve().parent
R3 = HERE.parent
WORK = pathlib.Path(os.environ.get('PRODUCER_WORK', '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025'))
STAGE = WORK / 'source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage'
sys.path.insert(0, str(STAGE / 'test')); sys.path.insert(0, str(R3 / 'producer')); sys.path.insert(0, str(R3 / 'wrapper'))
import test_a2a4 as TA                               # the harness's own fixtures (loads ./a2a4.py of that stage)
import test_chain_service as T                       # the EXISTING wrapper suite's fixtures; it loads r3/wrapper/chain_service.py
import base_launch as P
A = TA.A; W = T.c
sha = lambda b: hashlib.sha256(b).hexdigest()
FAKE_RELEASE = b'#!/bin/false\nfake M7+M10 release (tests)\n'
assert pathlib.Path(W.__file__).resolve() == (R3 / 'wrapper/chain_service.py').resolve(), 'the r3 wrapper copy is under test'
assert pathlib.Path(P.__file__).resolve() == (R3 / 'producer/base_launch.py').resolve(), 'the r3 producer copy is under test'


def kill_self(*_a, **_k):
    os.kill(os.getpid(), signal.SIGKILL)


class Pipeline(TA.Case):
    def setUp(self):
        super().setUp()                               # TA.Case.setUp: A.A1_INITIAL_SHA256 = the production pin
        A.BYTECODE_CHECKER_V2_SHA256 = TA.REAL_V2_PIN
        self.assertEqual(A.A1_INITIAL_SHA256, TA.REAL_INITIAL_SHA, 'every test starts from the production A1 pin')
        self.assertNotIn(W.HANDSHAKE_ENV, os.environ, 'the test runner must not carry the unit drop-in marker')
        self.uid = os.getuid(); self.top = self.d; self.events = []
        self.rel = self.d / 'opt/enclave-rpc/releases/base-m7m10-test/base'; self.rel.parent.mkdir(parents=True)
        self.rel.write_bytes(FAKE_RELEASE); self.rel.chmod(0o555); self.rel_sha = sha(FAKE_RELEASE)
        for q in [self.d / 'opt', self.d / 'opt/enclave-rpc', self.d / 'opt/enclave-rpc/releases', self.rel.parent]: q.chmod(0o755)
        (self.d / 'etc').mkdir(mode=0o755); self.out = self.d / 'etc/base-bootstrap'
        self.srv = self.d / 'srv'; self.srv.mkdir(mode=0o755); os.symlink('../datadir', self.srv / 'data')   # finality r6 port
        # finality r7 port: the fake binary is bound by overriding the code pin for THIS test only (production code keeps the conjunction)
        pp = patch.object(P, 'HARNESS_BINARY_SHA256', self.cfg['baseBinarySha256']); pp.start(); self.addCleanup(pp.stop)
        self.cov = {'evidence': {'receiptSha256': 'aa' * 32, 'verdictSha256': 'bb' * 32, 'originSha256': 'cc' * 32, 'snapshotManifestSha256': A.MANIFEST_SHA}}

    def tearDown(self):
        A.BYTECODE_CHECKER_V2_SHA256 = TA.REAL_V2_PIN; A.A1_INITIAL_SHA256 = TA.REAL_INITIAL_SHA
        os.environ.pop('FAKE_ACTIVE_UNIT', None); super().tearDown()

    # ---- the REAL harness pipeline -> produce -> arm --------------------------------------------------------------------
    def bytecodes_ready(self):
        """a2, a3, a4 (original-game-recheck A1: the fixture's consistent test pin), then the v2 checker pinned for the test."""
        TA.Recheck.use_recheck(self)
        self.assertNotEqual(A.A1_INITIAL_SHA256, TA.REAL_INITIAL_SHA)
        TA.BytecodeGate.ready(self, TA.V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        a1 = json.loads((self.d / 'work/a2-authenticated.json').read_bytes())['a1Gate']
        self.assertEqual((a1['mode'], a1['initialSha256'], a1['N']), ('original-game-recheck', A.A1_INITIAL_SHA256, str(TA.N)))

    def released(self):
        self.bytecodes_ready()
        for st in ('bytecodes', 'release'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))

    def produce(self, **kw):
        args = dict(A=A, coverage=self.cov, release_path=self.rel, release_sha=self.rel_sha, harness_binary_sha=self.cfg['baseBinarySha256'],
                    owner=self.uid, top=self.top)
        args.update(kw)
        r = P.produce(self.d / 'cfg.json', self.out, **args)
        self.lsha = r['launchSha256']; self.launch = json.loads((self.out / 'launch.json').read_bytes())
        return r

    def launched(self):
        self.released(); self.produce(); self.assertEqual(self.arm()['event'], 'armed')

    def arm(self, **kw):
        return P.arm(self.out, self.d / 'cfg.json', A=A, W=W, owner=self.uid, top=self.top, **kw)

    def rearm(self, **kw):
        return P.rearm(self.out, self.d / 'cfg.json', A=A, W=W, owner=self.uid, top=self.top, **kw)

    def rollback(self, why='operator abort'):
        return P.rollback(self.out, why, W=W, owner=self.uid, top=self.top)

    def refused(self, fn, code):                      # (overrides TA.Case.refused, which runs harness steps)
        with self.assertRaises(P.Refused) as e:
            fn()
        self.assertTrue(str(e.exception).startswith(code + ':'), str(e.exception))

    def journal(self):
        """[(name, bytes)] of the on-disk journal, read with plain os calls (Path.read_text is faked inside run)."""
        jd = self.out / 'journal'
        out = []
        for n in sorted(os.listdir(jd)):
            with open(jd / n, 'rb') as f:
                out.append((n, f.read()))
        return out

    def states(self):
        if not (self.out / 'journal').is_dir():
            return []
        return [json.loads(b)['event'] for n, b in self.journal() if W.JOURNAL_ENTRY.fullmatch(n)]

    # ---- the REAL wrapper call path, faked only at the system/RPC boundary --------------------------------------------
    def boundary(self, reviewed=True, now=None, l1=None, drop=None, env=True, manifest=None, pin=None):
        beacon = {'/eth/v2/beacon/blocks/2': {'message': {'body': {'blob_kzg_commitments': ['x']}}}, '/eth/v1/beacon/blobs/2': ['x']}
        man = manifest or {'mounts': T.manifest['mounts'], 'binaries': {'base': self.rel_sha},
                           'baseRelease': {'path': str(self.rel), 'sha256': self.rel_sha}}
        cfg = {'baseBootstrap': {'coverageVerified': True, 'l1Block': 1, 'blobSlot': 2, 'anchorLaunch': pin or {'launchSha256': self.lsha}},
               'baseRetention': {'historyFromBlock': T.HISTORY_FROM, 'stateHistoryFromBlock': T.STATE_FROM}}

        def mount(role, side):                        # THE one boundary mock of the first gate: records when it ran
            # finality r6 port (only change): the wrapper binds the SERVED datadir (mount + /data) to the launch record's
            self.events.append(('mount', self.states())); return str(self.srv)
        ps = [patch.object(W, 'mount', side_effect=mount), patch.object(pathlib.Path, 'is_file', return_value=True),
              patch.object(pathlib.Path, 'read_text', return_value=T.BaseRetentionTests.PROFILE),
              patch.object(W, 'binary', side_effect=lambda n: '/opt/enclave-rpc/bin/' + n),
              patch.object(W, 'MANIFEST', man), patch.object(W, 'CONFIG', cfg), patch.object(W, 'coverage_activation', return_value=T.BOUND),
              patch.object(W, 'history_files_present'), patch.object(W, 'segment_files_present'),
              patch.object(W, 'l1_ready', side_effect=l1 or (lambda: {'l1Finalized': 30000})),
              patch.object(W, 'rpc', side_effect=lambda port, m, p: {'hash': T.BOUND_HASH} if m == 'eth_getBlockByNumber' else []),
              patch.object(W, 'beacon', side_effect=beacon.__getitem__),
              patch.object(W, 'TRUSTED_TOP', self.top), patch.object(W, 'ROOT_UID', self.uid), patch.object(W, 'BASE_RELEASE_SHA256', self.rel_sha),
              patch.object(W, 'BASE_RELEASE_PATH', self.rel), patch.object(W, 'BOOTSTRAP_DIR', self.out),
              patch.object(W, 'LAUNCH_PRODUCER_REVIEWED', reviewed),
              patch.object(W, 'service_identity', return_value='rpcbase-account'),
              patch.object(W, 'drop_privileges', side_effect=drop or (lambda pw: self.events.append(('drop', pw, self.states())))),
              patch.dict(os.environ, {W.HANDSHAKE_ENV: '1'} if env else {})]
        if now is not None:
            ps.append(patch.object(W, '_now', return_value=now))
        return ps

    def executor(self, path, argv, env):
        """The fake exec: records what would have been exec'd and the journal AS ON DISK at that instant."""
        self.events.append(('exec', path, list(argv), dict(env), self.states()))
        raise T.Executed

    def start(self, executor=None, **kw):
        with contextlib.ExitStack() as st:
            for p in self.boundary(**kw):
                st.enter_context(p)
            st.enter_context(patch.object(W.os, 'execve', side_effect=executor or self.executor))
            try:
                W.run('base')
            except T.Executed:
                return 'exec'
            except AssertionError as e:
                return 'refused: ' + str(e)
        raise AssertionError('run returned without exec')

    def execs(self):
        return [e for e in self.events if e[0] == 'exec']

    def mounts(self):
        return [e for e in self.events if e[0] == 'mount']

    def fork_start(self, *, go=None, child_setup=None, **kw):
        """A REAL separate process running the real call path; -> (pid, result fd). The child never returns to unittest."""
        r, w = os.pipe(); sys.stdout.flush(); sys.stderr.flush()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(r)
                if go is not None:
                    os.read(go, 1)
                if child_setup:
                    child_setup()

                def child_exec(path, argv, env):
                    os.write(w, ('exec ' + json.dumps(argv[-2:])).encode()); os._exit(0)
                os.write(w, self.start(executor=child_exec, **kw).encode()); os._exit(3)
            except BaseException as e:                           # noqa: BLE001 - report, never return into the parent's runner
                os.write(w, f'error {type(e).__name__}: {e}'.encode()); os._exit(4)
        os.close(w)
        return pid, r

    def reap(self, pid, r):
        chunks = []
        while True:
            b = os.read(r, 65536)
            if not b:
                break
            chunks.append(b)
        os.close(r); _, status = os.waitpid(pid, 0)
        return status, b''.join(chunks).decode()


# ==== produce: the PRODUCTION checks, positive and negative (r1's producer cases were never run; ported here) ===========
class ProduceRefusals(Pipeline):
    def test_produce_publishes_exact_copies_atomically(self):
        self.released(); r = self.produce()
        a4 = json.loads((self.d / 'work/a4-rebuilt.json').read_bytes())
        self.assertEqual(self.launch['anchor'], f'{TA.N}:{a4["blockHash"]}')
        self.assertEqual(r['launchSha256'], sha((self.out / 'launch.json').read_bytes()))
        for k, f in P.QUAL.items():
            self.assertEqual((self.out / 'qualification' / f).read_bytes(), (self.d / 'work' / f).read_bytes(), f)
            self.assertEqual(self.launch['qualification'][k], sha((self.d / 'work' / f).read_bytes()))
        self.assertEqual(self.launch['bindings']['a1']['initialSha256'], A.A1_INITIAL_SHA256)
        self.assertEqual(self.launch['bindings']['bytecodes']['receiptVersion'], 'v2')
        self.assertFalse(list(self.out.parent.glob('.*partial*')), 'no partial directory remains')
        self.assertFalse((self.out / 'journal').exists() or (self.out / 'journal.lock').exists(), 'produce never arms')

    def test_the_production_a1_pin_refuses_the_fixture_receipt(self):
        self.released(); A.A1_INITIAL_SHA256 = TA.REAL_INITIAL_SHA      # the real b9a90847... (live receipt) is not this receipt
        self.refused(self.produce, 'a1'); self.assertFalse(self.out.exists())

    def test_refuses_without_a_newest_successful_release(self):
        self.bytecodes_ready(); self.assertEqual(self.run_step('bytecodes')[0], 0)
        self.refused(self.produce, 'release_run')                       # no release yet
        self.assertEqual(self.run_step('release')[0], 0)
        self.run_step('plan')                                            # any later harness run supersedes the release
        self.refused(self.produce, 'release_run')

    def test_tampered_harness_records_refuse(self):
        self.released(); w = self.d / 'work'
        cases = [('m10-launch.json', lambda d: d.update(bootstrapAnchor=f'{TA.N}:0x' + '11' * 32), 'm10_launch'),
                 ('a4-rebuilt.json', lambda d: d.update(blockHash='0x' + '22' * 32), 'a2_a4'),
                 ('a3-unwound.json', lambda d: d['checkpoints'].update(finish=TA.N + 1), 'a3')]
        for name, mutate, code in cases:
            with self.subTest(name):
                orig = (w / name).read_bytes(); d = json.loads(orig); mutate(d); (w / name).write_text(json.dumps(d))
                self.refused(self.produce, code); (w / name).write_bytes(orig)
        self.assertFalse(self.out.exists())

    def test_the_real_source_checker_pin_keeps_the_gap_open(self):
        self.released(); A.BYTECODE_CHECKER_V2_SHA256 = TA.REAL_V2_PIN   # the fake checker is not the reviewed b55e6b78...
        self.refused(self.produce, 'open_gaps')

    def test_db_or_journal_change_after_the_scan_refuses(self):
        self.released(); (self.d / 'datadir/db/mdbx.dat').write_bytes(b'changed')
        self.refused(self.produce, 'db_changed')
        self.setUp(); self.released()
        with open(self.d / 'work/mutation-journal.jsonl', 'a') as f:
            f.write('{"seq": 99}\n')
        self.refused(self.produce, 'bytecodes_stale')

    def test_stale_release_refuses(self):
        self.released()
        rel = json.loads(sorted((self.d / 'work').glob('run-release-*.json'))[-1].read_bytes())
        late = datetime.datetime.fromisoformat(rel['finishedAt']) + datetime.timedelta(seconds=self.cfg['a1MaxAgeSec'] + 5)
        self.refused(lambda: self.produce(now=late), 'stale_release')

    def test_binary_harness_and_coverage_bindings_refuse(self):
        self.released()
        self.refused(lambda: self.produce(release_sha='00' * 32), 'release_binary')
        self.refused(lambda: self.produce(harness_binary_sha='00' * 32), 'harness_binary')
        self.refused(lambda: self.produce(coverage={'evidence': dict(self.cov['evidence'], snapshotManifestSha256='00' * 32)}), 'coverage')
        self.refused(lambda: self.produce(coverage=None), 'coverage')
        real = self.rel.parent.with_name('real'); self.rel.parent.rename(real); self.rel.parent.symlink_to(real)
        self.refused(self.produce, 'path')
        self.assertFalse(self.out.exists())

    def test_never_overwrites_and_needs_the_reviewed_harness_source(self):
        self.released(); self.produce(); before = (self.out / 'launch.json').read_bytes()
        self.refused(self.produce, 'exists'); self.assertEqual((self.out / 'launch.json').read_bytes(), before)
        self.refused(lambda: P.load_a2a4(STAGE / 'a2a4.py', pin='00' * 32), 'a2a4_source')
        self.assertEqual(P.load_a2a4(STAGE / 'a2a4.py').BYTECODE_CHECKER_V2_SHA256, TA.REAL_V2_PIN, 'the pinned harness bytes load')


# ==== base_release: the production release selection (r1 wrapper cases were not re-run in r2) ===========================
class ReleaseSelection(Pipeline):
    def sel(self, manifest):
        with patch.object(W, 'TRUSTED_TOP', self.top), patch.object(W, 'ROOT_UID', self.uid), \
                patch.object(W, 'BASE_RELEASE_SHA256', self.rel_sha), patch.object(W, 'BASE_RELEASE_PATH', self.rel):
            return W.base_release(manifest)

    def test_valid_release_selected_and_every_deviation_refused(self):
        m = {'binaries': {'base': self.rel_sha}, 'baseRelease': {'path': str(self.rel), 'sha256': self.rel_sha}}
        self.assertEqual(self.sel(m), str(self.rel)); self.assertIsNone(self.sel({'binaries': {'base': '9c' * 32}}))
        cases = {'not the reviewed': {**m, 'baseRelease': {**m['baseRelease'], 'sha256': '00' * 32}},
                 'versioned path': {**m, 'baseRelease': {**m['baseRelease'], 'path': str(self.rel) + '2'}},
                 'binaries.base must name the release': {**m, 'binaries': {'base': '9c' * 32}},
                 'exactly': {**m, 'baseRelease': {**m['baseRelease'], 'extra': 1}}}
        for why, man in cases.items():
            with self.subTest(why), self.assertRaisesRegex(AssertionError, why):
                self.sel(man)
        self.rel.chmod(0o755); self.rel.write_bytes(FAKE_RELEASE + b'x'); self.rel.chmod(0o555)
        with self.assertRaisesRegex(AssertionError, 'release binary pin mismatch'):
            self.sel(m)
        self.rel.chmod(0o755); self.rel.write_bytes(FAKE_RELEASE); self.rel.chmod(0o555)
        real = self.rel.parent.with_name('real'); self.rel.parent.rename(real); self.rel.parent.symlink_to(real)
        with self.assertRaisesRegex(AssertionError, 'is a symlink'):          # symlinked parent directory
            self.sel(m)
        self.rel.parent.unlink(); real.rename(self.rel.parent)
        os.chmod(self.rel.parent.parent, 0o777)
        with self.assertRaisesRegex(AssertionError, 'non-writable'):          # group/other-writable parent
            self.sel(m)
        os.chmod(self.rel.parent.parent, 0o755)
        self.rel.unlink(); self.rel.symlink_to(pathlib.Path('/bin/true'))
        with self.assertRaisesRegex(AssertionError, 'is a symlink'):          # symlinked target
            self.sel(m)

    def test_tampered_release_refuses_in_the_real_call_path_before_consuming(self):
        self.launched(); before = self.journal()
        self.rel.chmod(0o755); self.rel.write_bytes(FAKE_RELEASE + b'x'); self.rel.chmod(0o555)
        self.assertRegex(self.start(), 'release binary pin mismatch')
        self.assertEqual(self.journal(), before); self.assertEqual(self.execs(), [])


# ==== launch-record bindings (r1 wrapper mismatch cases), through the real call path ====================================
class LaunchBinding(Pipeline):
    def test_every_binding_mismatch_refuses_before_consuming(self):
        self.launched(); before = self.journal(); q = self.out / 'qualification'
        files = [self.out / 'launch.json'] + [q / f for f in P.QUAL.values()]
        orig = {p: p.read_bytes() for p in files}
        n, h = self.launch['anchor'].split(':')

        def requal(launch, fname):                   # re-bind the launch record to an edited qualification file
            k = next(k for k, f in P.QUAL.items() if f == fname); launch['qualification'][k] = sha((q / fname).read_bytes())

        def edit(path, mutate):
            d = json.loads(path.read_bytes()); mutate(d); path.write_bytes(json.dumps(d, indent=1, sort_keys=True).encode())
        cases = [
            ('another binary', lambda L: L.update(baseReleaseSha256='00' * 32), None),
            ('lower-case hex', lambda L: L.update(anchor=f'{n}:0x' + h[2:].upper()), None),
            ('launch record format', lambda L: L.update(format='enclave-base-bootstrap-launch/v0'), None),
            ('notAfter is not an ISO timestamp', lambda L: L.pop('notAfter'), None),
            ('lacks the A2-A4 qualification hashes', lambda L: L['qualification'].pop('a2Sha256'), None),
            ('not the A2-A4 release anchor', lambda L: requal(L, 'm10-launch.json'),
             ('m10-launch.json', lambda d: d.update(bootstrapAnchor=f'{n}:0x' + '33' * 32))),
            ('another A4 result', lambda L: requal(L, 'bytecodes-verified.json'),
             ('bytecodes-verified.json', lambda d: d.update(a4Sha256='44' * 32))),
            ('a4-rebuilt.json bytes differ from the launch record', lambda L: None,
             ('a4-rebuilt.json', lambda d: d.update(note='edited'))),
        ]
        for why, launch_mut, qual in cases:
            with self.subTest(why):
                if qual:
                    edit(q / qual[0], qual[1])
                edit(self.out / 'launch.json', launch_mut)
                self.lsha = sha((self.out / 'launch.json').read_bytes())           # root re-pinned the edited record
                self.assertRegex(self.start(), why)
                for p, b in orig.items():
                    p.write_bytes(b)
        self.lsha = sha(orig[self.out / 'launch.json'])
        (q / 'a2-authenticated.json').unlink()                                   # a partial copy
        self.assertRegex(self.start(), 'unreadable'); (q / 'a2-authenticated.json').write_bytes(orig[q / 'a2-authenticated.json'])
        os.chmod(q, 0o777); self.assertRegex(self.start(), 'non-writable'); os.chmod(q, 0o755)
        self.assertEqual(self.journal(), before); self.assertEqual(self.execs(), [])
        self.assertEqual(self.start(), 'exec')                                  # restored: nothing was consumed by any refusal
        self.assertEqual(self.states(), ['armed', 'consumed'])

    def test_launch_pin_is_the_immutable_record_only(self):
        self.launched()
        self.assertRegex(self.start(pin={'launchSha256': self.lsha, 'lifecycleSha256': '00' * 32}), r'anchorLaunch \{launchSha256\}')
        self.assertRegex(self.start(pin={'launchSha256': '00' * 32}), 'differ from the operator pin')
        p = self.out / 'launch.json'; p.write_bytes(p.read_bytes() + b' ')
        self.assertRegex(self.start(), 'differ from the operator pin')          # the record is immutable: any edit refuses
        self.assertEqual(self.states(), ['armed']); self.assertEqual(self.execs(), [])


# ==== the one-shot handshake ===========================================================================================
class Handshake(Pipeline):
    def test_one_shot_gates_under_lock_consume_before_exec_and_restarts_refuse(self):
        self.launched()
        self.assertEqual(self.start(), 'exec')
        (kind, path, argv, env, at_exec), = self.execs()
        self.assertEqual((path, argv[0]), (str(self.rel), str(self.rel)))
        self.assertEqual(argv[-2:], ['--bootstrap.anchor', self.launch['anchor']])
        self.assertEqual(env['BASE_NODE_L1_TRUST_RPC'], 'false')
        self.assertEqual(self.mounts(), [('mount', ['armed'])], 'the first gate ran (under the lock) before anything was consumed')
        self.assertEqual(at_exec, ['armed', 'consumed'], 'the consumed entry is on disk BEFORE exec')
        drops = [e for e in self.events if e[0] == 'drop']
        self.assertEqual([(d[1], d[2]) for d in drops], [('rpcbase-account', ['armed', 'consumed'])])
        self.assertLess(self.events.index(drops[0]), self.events.index(self.execs()[0]), 'privileges drop after consume, before exec')
        consumed = json.loads(self.journal()[-1][1])
        self.assertEqual((consumed['seq'], consumed['launchSha256'], consumed['evidence']['anchor']), (2, self.lsha, self.launch['anchor']))
        before = self.journal()
        for _ in range(3):                                         # systemd Restart=on-failure, manual restarts
            self.assertRegex(self.start(), 'already consumed')
        self.assertEqual(self.journal(), before); self.assertEqual(len(self.execs()), 1, 'exactly one launch')

    def test_crash_after_consume_refuses_until_rearm_with_the_unchanged_db(self):
        self.launched()
        pid, r = self.fork_start(drop=kill_self)                   # SIGKILL between the durable consume and the exec
        status, out = self.reap(pid, r)
        self.assertTrue(os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL, (status, out))
        self.assertEqual(out, '', 'the killed child never exec\'d')
        self.assertEqual(self.states(), ['armed', 'consumed'])
        self.assertEqual(json.loads(self.journal()[-1][1])['evidence']['pid'], pid)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertRegex(self.start(), 'already consumed')         # a dead PID is never read as "not started"
        self.refused(self.arm, 'armed')                            # cannot re-genesis the journal
        self.assertEqual(self.rearm()['event'], 'rearmed')         # the harness's own stopped-DB proof, DB identity unchanged
        self.assertEqual(self.start(), 'exec'); self.assertRegex(self.start(), 'already consumed')
        self.assertEqual(self.states(), ['armed', 'consumed', 'rearmed', 'consumed']); self.assertEqual(len(self.execs()), 1)
        self.rearm()

        def exec_fails(path, argv, env):                           # an exec that fails after the consume
            raise OSError(2, 'exec failed')
        with self.assertRaises(OSError):
            self.start(executor=exec_fails)
        self.assertEqual(self.states()[-1], 'consumed'); self.assertRegex(self.start(), 'already consumed')

    def test_crash_before_consume_keeps_the_launch_pending(self):
        self.launched()
        pid, r = self.fork_start(child_setup=lambda: patch.object(W.os, 'link', side_effect=kill_self).start())
        status, out = self.reap(pid, r)                            # killed after the partial entry was written, before its link
        self.assertTrue(os.WIFSIGNALED(status), (status, out)); self.assertEqual(out, '')
        self.assertEqual(self.states(), ['armed']); self.assertIn(f'.partial-{pid}', [n for n, _ in self.journal()])
        status, out = self.reap(*self.fork_start(l1=kill_self))    # killed inside the gates, lock held
        self.assertTrue(os.WIFSIGNALED(status), (status, out)); self.assertEqual(self.states(), ['armed'])
        self.assertEqual(self.start(), 'exec')                     # the kernel released the dead holders' locks
        self.assertEqual(self.states(), ['armed', 'consumed']); self.assertEqual(len(self.execs()), 1)
        self.assertFalse([n for n, _ in self.journal() if n.startswith('.partial')], 'the interrupted append was cleaned under the lock')

    def test_two_concurrent_starts_launch_exactly_once(self):
        """Deterministic: the lock holder blocks INSIDE its gates on a pipe until the parent releases it; no sleeps."""
        self.launched()
        go_r, go_w = os.pipe(); held_r, held_w = os.pipe(); rel_r, rel_w = os.pipe()

        def hold():                                                # reached ONLY by the child holding the lock
            os.write(held_w, b'L'); os.read(rel_r, 1); return {'l1Finalized': 30000}
        kids = [self.fork_start(go=go_r, l1=hold) for _ in range(2)]
        released = False
        try:
            os.write(go_w, b'GG')
            self.assertEqual(os.read(held_r, 1), b'L')             # one child holds the lock, blocked in its gates
            ready, _, _ = select.select([k[1] for k in kids], [], [], 120)
            self.assertEqual(len(ready), 1, 'only the child that did not get the lock can finish while it is held')
            loser = next(k for k in kids if k[1] == ready[0]); winner = next(k for k in kids if k is not loser)
            s, out = self.reap(*loser); kids.remove(loser)
            self.assertEqual((os.WIFEXITED(s), os.WEXITSTATUS(s)), (True, 3), out); self.assertRegex(out, '^refused: launch lock busy')
            self.refused(self.rollback, 'lock'); self.refused(self.rearm, 'lock')
            self.assertRegex(self.start(), 'launch lock busy')
            self.assertEqual(self.states(), ['armed'], 'nothing is consumed while the holder is still inside its gates')
            os.write(rel_w, b'R'); released = True
            s, out = self.reap(*winner); kids.remove(winner)
            self.assertEqual((os.WIFEXITED(s), os.WEXITSTATUS(s)), (True, 0), out)
            self.assertEqual(json.loads(out[len('exec '):]), ['--bootstrap.anchor', self.launch['anchor']])
        finally:
            if not released:
                os.write(rel_w, b'RR')
            for k in kids:
                self.reap(*k)
        self.assertEqual(self.states(), ['armed', 'consumed'])
        res = [self.reap(*self.fork_start()) for _ in range(2)]   # a later pair (sequential here): both refuse
        self.assertTrue(all(o.startswith('refused: bootstrap anchor already consumed') for _, o in res), res)
        self.assertEqual(self.states(), ['armed', 'consumed'])

    def test_expired_start_refuses_without_consuming(self):
        self.launched(); before = self.journal()
        na = datetime.datetime.fromisoformat(self.launch['notAfter']).timestamp()
        self.assertRegex(self.start(now=na + 1), 'expired')
        self.assertEqual(self.journal(), before); self.assertEqual(self.execs(), [])
        self.assertEqual(self.start(now=na), 'exec')               # <= notAfter
        late = datetime.datetime.fromisoformat(self.launch['notAfter']) + datetime.timedelta(seconds=1)
        self.refused(lambda: self.rearm(now=late), 'stale_launch')
        self.setUp(); self.released(); self.produce()
        late = datetime.datetime.fromisoformat(self.launch['notAfter']) + datetime.timedelta(seconds=1)
        self.refused(lambda: self.arm(now=late), 'stale_launch')
        self.assertFalse((self.out / 'journal').exists() or (self.out / 'journal.lock').exists())

    def test_rearm_refuses_unless_the_stopped_db_is_unchanged_at_n(self):
        self.launched(); self.assertEqual(self.start(), 'exec'); before = self.journal()
        self.refused(self.arm, 'armed')
        os.environ['FAKE_ACTIVE_UNIT'] = 'enclave-base-holder.service'
        with self.assertRaises(A.Refused):                          # the harness's own gate: units must be stopped
            self.rearm()
        os.environ.pop('FAKE_ACTIVE_UNIT')
        self.state['cp']['execution'] = TA.N + 5; self.write()     # the node advanced before it crashed
        self.refused(self.rearm, 'head_advanced')
        self.state['cp']['execution'] = TA.N; self.state['headersTip'] = TA.N + 1; self.state['headers'][str(TA.N + 1)] = TA.FX['header']; self.write()
        self.refused(self.rearm, 'head_advanced')
        self.state['headersTip'] = TA.N; self.state['headers'].pop(str(TA.N + 1)); self.write()
        (self.d / 'datadir/db/mdbx.dat').write_bytes(b'written by a run')  # same checkpoints, but the DB file was written
        self.refused(self.rearm, 'db_changed')
        self.assertEqual(self.journal(), before); self.assertRegex(self.start(), 'already consumed')
        self.assertEqual(len(self.execs()), 1)

    def test_rearm_needs_a_consumed_start_and_arm_needs_the_db_at_n(self):
        self.launched()
        self.refused(self.rearm, 'transition')                     # armed: nothing to re-open
        self.setUp(); self.released(); self.produce()
        self.assertRegex(self.start(), 'launch lock .* unavailable')  # produced but never armed: no start
        self.assertEqual(self.mounts(), [], 'refused before the first gate')
        self.state['cp']['finish'] = TA.N + 1; self.write()
        self.refused(self.arm, 'head_advanced')
        self.assertFalse((self.out / 'journal').exists(), 'a refused arm writes no journal')
        self.state['cp']['finish'] = TA.N; self.write(); self.assertEqual(self.arm()['event'], 'armed')   # an interrupted arm may be repeated
        self.refused(self.arm, 'armed')

    def test_rollback_is_terminal(self):
        self.launched(); self.assertEqual(self.rollback()['event'], 'rolled-back')
        self.assertRegex(self.start(), 'rolled back')
        self.refused(self.rearm, 'rolled_back'); self.refused(self.rollback, 'rolled_back'); self.refused(self.arm, 'armed')
        self.assertEqual(self.states(), ['armed', 'rolled-back']); self.assertEqual(self.execs(), [])

    def test_source_holds_refuse_before_consuming_and_no_finality_is_accepted(self):
        self.assertIs(W.LAUNCH_PRODUCER_REVIEWED, False); self.assertIs(P.FINALITY_PROOF_REVIEWED, False)
        self.assertEqual((W.BASE_SERVICE_USER, W.TRUSTED_TOP, W.ROOT_UID), ('rpcbase', pathlib.Path('/'), 0))
        self.assertEqual(W.BASE_RELEASE_SHA256, '4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f')
        self.assertEqual(A.A1_INITIAL_SHA256, 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c')
        self.launched(); before = self.journal()
        self.assertRegex(self.start(reviewed=False), 'HOLD')
        self.assertEqual(self.journal(), before); self.assertEqual(self.execs(), [])
        self.refused(lambda: P.record_bootstrapped(self.out, {'number': TA.N + 100}), 'hold_finality')
        last_sha, last = W.journal_entries(self.out / 'journal', self.uid, self.lsha, self.top)[-1]
        forged = {**last, 'seq': 2, 'prevSha256': last_sha, 'event': 'bootstrapped', 'evidence': {'number': TA.N + 100}}
        (self.out / 'journal/000002.json').write_bytes(json.dumps(forged).encode())
        self.assertRegex(self.start(), "'armed' -> 'bootstrapped' is not allowed")
        self.assertEqual(self.execs(), [])

    def test_release_mode_needs_the_root_handshake_and_legacy_is_unchanged(self):
        self.launched(); before = self.journal()
        self.assertRegex(self.start(env=False), 'root one-shot launch handshake')
        with patch.object(W.os, 'geteuid', return_value=self.uid + 1):
            self.assertRegex(self.start(), 'root one-shot launch handshake')
        self.assertEqual(self.mounts(), [], 'both refused before the first gate (the boundary mount mock never ran)')
        self.assertEqual(self.journal(), before)
        legacy = {'mounts': T.manifest['mounts'], 'binaries': {}}
        self.assertRegex(self.start(manifest=legacy), 'legacy bin/base under the root release-mode unit drop-in')
        self.assertEqual(self.mounts(), [])
        self.assertEqual(self.start(manifest=legacy, env=False), 'exec')
        (_, path, argv, env, _), = self.execs()
        self.assertEqual(path, '/opt/enclave-rpc/bin/base'); self.assertNotIn('--bootstrap.anchor', argv)
        self.assertEqual(env['BASE_NODE_L1_TRUST_RPC'], 'false'); self.assertEqual(len(self.mounts()), 1)
        self.assertFalse([e for e in self.events if e[0] == 'drop'], 'legacy mode never touches identities')
        self.assertEqual(self.journal(), before)

    def test_lock_and_journal_tamper_refuse(self):
        self.launched(); self.assertEqual(self.start(), 'exec'); lock = self.out / 'journal.lock'; jd = self.out / 'journal'
        lock.rename(self.out / 'real.lock'); lock.symlink_to(self.out / 'real.lock')
        self.assertRegex(self.start(), 'launch lock .* unavailable'); lock.unlink(); (self.out / 'real.lock').rename(lock)
        lock.chmod(0o644); self.assertRegex(self.start(), 'not a private regular file'); lock.chmod(0o600)
        jd.rename(self.out / 'real-journal'); jd.symlink_to(self.out / 'real-journal')
        self.assertRegex(self.start(), 'is a symlink'); jd.unlink(); (self.out / 'real-journal').rename(jd)
        e1 = jd / '000001.json'; e1.chmod(0o666); self.assertRegex(self.start(), 'non-writable'); e1.chmod(0o644)
        os.chmod(jd, 0o777); self.assertRegex(self.start(), 'non-writable'); os.chmod(jd, 0o755)
        b1 = e1.read_bytes(); d1 = json.loads(b1); d1['evidence'] = {'reason': 'edited'}; e1.write_bytes(json.dumps(d1).encode())
        self.assertRegex(self.start(), 'journal chain broken at 000002'); e1.write_bytes(b1)
        (jd / '000002.json').rename(jd / '000003.json'); self.assertRegex(self.start(), 'unexpected journal entry 000003')
        (jd / '000003.json').rename(jd / '000002.json')
        self.assertRegex(self.start(), 'already consumed')        # restored exactly: the consumed state is back
        (jd / '000002.json').unlink(); (jd / '000001.json').unlink()
        self.assertRegex(self.start(), 'no launch journal')       # a fully removed journal refuses (it never re-arms by itself)
        self.assertEqual(len(self.execs()), 1)


class DropPrivileges(unittest.TestCase):
    pw = type('PW', (), {'pw_name': 'rpcbase', 'pw_uid': 994, 'pw_gid': 985})()   # the live account (launcher-service-audit-0143)

    def test_drop_order_ids_and_irreversibility(self):
        calls = []
        with patch.object(W.os, 'initgroups', side_effect=lambda *a: calls.append(('initgroups',) + a)), \
                patch.object(W.os, 'setresgid', side_effect=lambda *a: calls.append(('setresgid',) + a)), \
                patch.object(W.os, 'setresuid', side_effect=lambda *a: calls.append(('setresuid',) + a)), \
                patch.object(W.os, 'getresuid', return_value=(994,) * 3), patch.object(W.os, 'getresgid', return_value=(985,) * 3), \
                patch.object(W.os, 'setuid', side_effect=PermissionError) as su:
            W.drop_privileges(self.pw)
        self.assertEqual(calls, [('initgroups', 'rpcbase', 985), ('setresgid', 985, 985, 985), ('setresuid', 994, 994, 994)])
        self.assertEqual(su.call_args, call(0))

    def test_incomplete_or_reversible_drop_refuses(self):
        for extra, why in (([patch.object(W.os, 'getresuid', return_value=(994, 994, 0)), patch.object(W.os, 'getresgid', return_value=(985,) * 3)], 'incomplete'),
                           ([patch.object(W.os, 'getresuid', return_value=(994,) * 3), patch.object(W.os, 'getresgid', return_value=(985,) * 3),
                             patch.object(W.os, 'setuid')], 'reversible')):
            with contextlib.ExitStack() as st, self.subTest(why):
                for p in [patch.object(W.os, n) for n in ('initgroups', 'setresgid', 'setresuid')] + extra:
                    st.enter_context(p)
                with self.assertRaisesRegex(AssertionError, why):
                    W.drop_privileges(self.pw)

    def test_service_identity_is_never_root(self):
        root = type('PW', (), {'pw_name': 'root', 'pw_uid': 0, 'pw_gid': 0})()
        with patch.object(W.pwd, 'getpwnam', return_value=root):
            with self.assertRaisesRegex(AssertionError, 'must not be root'):
                W.service_identity()
        with patch.object(W.pwd, 'getpwnam', return_value=self.pw) as g:
            self.assertIs(W.service_identity(), self.pw); g.assert_called_with('rpcbase')



class FirstBootstrapStateFrontier(Pipeline):
    """r9/r10: the FIRST-BOOTSTRAP harness (a2-v2 + the pinned checkpoint parser) over the pinned-format fake: labels at the snapshot
    head but Finish.partial_state_trie BELOW the anchor N. A2 only authenticates header N (passes); step_plan, which A3 runs FIRST,
    refuses state_below_anchor before any unwind (labels are not state). r9 wrongly expected the refusal at A2 (root run 0648)."""
    def test_first_bootstrap_refuses_a_state_frontier_below_the_anchor(self):
        self.state['finishPartial'] = TA.N - 10; self.write()
        wd = pathlib.Path(self.cfg['workdir']); before = set(wd.glob('run-a3-*.json')) if wd.exists() else set()
        with self.assertRaises(Exception):
            self.launched()                                           # a3 (step_plan) must refuse; nothing unwound
        new = sorted(set(wd.glob('run-a3-*.json')) - before); self.assertTrue(new, 'a3 wrote no run record')
        rec = json.loads(new[0].read_text()); self.assertTrue(str(rec.get('refused')).startswith('state_below_anchor'), rec)
        self.assertFalse(any('unwind' in ' '.join(map(str, c.get('argv', []))) and '--help' not in c.get('argv', []) for c in rec.get('commands', [])),
                         'no unwind ran')


for _n in [n for n in dir(Pipeline) if n.startswith('test_')]:
    setattr(FirstBootstrapStateFrontier, _n, None)

if __name__ == '__main__':
    unittest.main(verbosity=2)
