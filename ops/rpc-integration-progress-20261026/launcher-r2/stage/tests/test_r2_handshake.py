"""Offline tests of the r2 ONE-SHOT launch handshake: the r2 wrapper's REAL run('base') call path (every existing gate, faked
only at the system/RPC boundary exactly as the existing wrapper suite does; os.execve replaced by a fake executor), over
launch records produced and armed by the r2 producer from workdirs of the REAL A2-A4 harness (a2-v2-release-bound a2a4.main
over that stage's own fake-base fixture; no reth, no network). Crashes are REAL: forked children SIGKILL themselves at the
named point. Concurrency is REAL: two forked processes race for the same flock. Root runs these; Claude did not.
Test-only substitutions: the fake checker's sha as the source v2 pin (as the harness's own BytecodeGate tests do), a fake
release binary + its sha, a test-owned trusted top/uid, LAUNCH_PRODUCER_REVIEWED=True inside the wrapper module, and the
privilege drop (recorded, not performed: the namespace has no rpcbase account) - drop_privileges itself is unit-tested."""
import contextlib, datetime, hashlib, json, os, pathlib, signal, sys, time, unittest
from unittest.mock import call, patch

HERE = pathlib.Path(__file__).resolve().parent
R2 = HERE.parent
WORK = pathlib.Path(os.environ.get('PRODUCER_WORK', '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025'))
STAGE = WORK / 'source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage'
sys.path.insert(0, str(STAGE / 'test')); sys.path.insert(0, str(R2 / 'producer')); sys.path.insert(0, str(R2 / 'wrapper'))
import test_a2a4 as TA                               # the harness's own fixtures (loads ./a2a4.py of that stage)
import test_chain_service as T                       # the EXISTING wrapper suite's fixtures; it loads r2/wrapper/chain_service.py
import base_launch as P
A = TA.A; W = T.c
sha = lambda b: hashlib.sha256(b).hexdigest()
FAKE_RELEASE = b'#!/bin/false\nfake M7+M10 release (tests)\n'
assert pathlib.Path(W.__file__).resolve() == (R2 / 'wrapper/chain_service.py').resolve(), 'the r2 wrapper is under test'


def kill_self(*_a, **_k):
    os.kill(os.getpid(), signal.SIGKILL)


class Handshake(TA.Case):
    def setUp(self):
        super().setUp(); A.BYTECODE_CHECKER_V2_SHA256 = TA.REAL_V2_PIN
        self.uid = os.getuid(); self.top = self.d; self.events = []
        self.rel = self.d / 'opt/enclave-rpc/releases/base-m7m10-test/base'; self.rel.parent.mkdir(parents=True)
        self.rel.write_bytes(FAKE_RELEASE); self.rel.chmod(0o555); self.rel_sha = sha(FAKE_RELEASE)
        for q in [self.d / 'opt', self.d / 'opt/enclave-rpc', self.d / 'opt/enclave-rpc/releases', self.rel.parent]: q.chmod(0o755)
        (self.d / 'etc').mkdir(mode=0o755); self.out = self.d / 'etc/base-bootstrap'
        self.cov = {'evidence': {'receiptSha256': 'aa' * 32, 'verdictSha256': 'bb' * 32, 'originSha256': 'cc' * 32, 'snapshotManifestSha256': A.MANIFEST_SHA}}

    def tearDown(self):
        A.BYTECODE_CHECKER_V2_SHA256 = TA.REAL_V2_PIN; os.environ.pop('FAKE_ACTIVE_UNIT', None); super().tearDown()

    # ---- the real pipeline -> produce -> arm ----------------------------------------------------------------------------
    def launched(self):
        TA.BytecodeGate.ready(self, TA.V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        for st in ('bytecodes', 'release'):
            rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        r = P.produce(self.d / 'cfg.json', self.out, A=A, coverage=self.cov, release_path=self.rel, release_sha=self.rel_sha,
                      harness_binary_sha=self.cfg['baseBinarySha256'], owner=self.uid, top=self.top)
        self.lsha = r['launchSha256']; self.launch = json.loads((self.out / 'launch.json').read_bytes())
        self.assertEqual(self.arm()['event'], 'armed')

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
        return [json.loads(b)['event'] for n, b in self.journal() if W.JOURNAL_ENTRY.fullmatch(n)]

    # ---- the REAL wrapper call path, faked only at the system/RPC boundary --------------------------------------------
    def boundary(self, reviewed=True, now=None, l1=None, drop=None, env=True, manifest=None):
        beacon = {'/eth/v2/beacon/blocks/2': {'message': {'body': {'blob_kzg_commitments': ['x']}}}, '/eth/v1/beacon/blobs/2': ['x']}
        man = manifest or {'mounts': T.manifest['mounts'], 'binaries': {'base': self.rel_sha},
                           'baseRelease': {'path': str(self.rel), 'sha256': self.rel_sha}}
        cfg = {'baseBootstrap': {'coverageVerified': True, 'l1Block': 1, 'blobSlot': 2, 'anchorLaunch': {'launchSha256': self.lsha}},
               'baseRetention': {'historyFromBlock': T.HISTORY_FROM, 'stateHistoryFromBlock': T.STATE_FROM}}
        envp = {W.HANDSHAKE_ENV: '1'} if env else {}
        ps = [patch.object(W, 'mount', return_value='/srv/enclave-base-holder'), patch.object(pathlib.Path, 'is_file', return_value=True),
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
              patch.dict(os.environ, envp)]
        if not env:
            ps.append(patch.dict(os.environ, {}, clear=False)); os.environ.pop(W.HANDSHAKE_ENV, None)
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

    # ---- 1. one shot on the real path; restarts refuse ----------------------------------------------------------------
    def test_one_shot_consumes_durably_before_exec_and_restarts_refuse(self):
        self.launched()
        self.assertEqual(self.start(), 'exec')
        (kind, path, argv, env, at_exec), = self.execs()
        self.assertEqual((path, argv[0]), (str(self.rel), str(self.rel)))
        self.assertEqual(argv[-2:], ['--bootstrap.anchor', self.launch['anchor']])
        self.assertEqual(env['BASE_NODE_L1_TRUST_RPC'], 'false')
        self.assertEqual(at_exec, ['armed', 'consumed'], 'the consumed entry is on disk BEFORE exec')
        drops = [e for e in self.events if e[0] == 'drop']
        self.assertEqual([(d[1], d[2]) for d in drops], [('rpcbase-account', ['armed', 'consumed'])])
        self.assertLess(self.events.index(drops[0]), self.events.index(self.execs()[0]), 'privileges drop before exec, after consume')
        consumed = json.loads(self.journal()[-1][1])
        self.assertEqual((consumed['seq'], consumed['launchSha256'], consumed['evidence']['anchor']), (2, self.lsha, self.launch['anchor']))
        before = self.journal()
        for _ in range(3):                                         # systemd Restart=on-failure, manual restarts
            self.assertRegex(self.start(), 'already consumed')
        self.assertEqual(self.journal(), before); self.assertEqual(len(self.execs()), 1, 'exactly one launch')

    # ---- 2. crash AFTER consume, before the exec: refuse until a real unchanged-DB rearm ---------------------------------
    def test_crash_after_consume_refuses_until_rearm_with_the_unchanged_db(self):
        self.launched()
        status, out = self.reap(*self.fork_start(drop=kill_self))  # SIGKILL between the durable consume and the exec
        self.assertTrue(os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL, (status, out))
        self.assertEqual(out, '', 'the killed child never exec\'d')
        self.assertEqual(self.states(), ['armed', 'consumed'])
        self.assertRegex(self.start(), 'already consumed')         # never inferred from the (dead) PID in the entry
        self.refused(lambda: self.arm(), 'armed')                  # cannot re-genesis the journal
        self.assertEqual(self.rearm()['event'], 'rearmed')         # the harness's own stopped-DB proof, DB identity unchanged
        self.assertEqual(self.start(), 'exec'); self.assertRegex(self.start(), 'already consumed')
        self.assertEqual(self.states(), ['armed', 'consumed', 'rearmed', 'consumed']); self.assertEqual(len(self.execs()), 1)
        with patch.object(W.os, 'execve', side_effect=OSError(2, 'exec failed')):  # an exec that fails after consume
            self.rearm()
            with contextlib.ExitStack() as st:
                for p in self.boundary():
                    st.enter_context(p)
                with self.assertRaises(OSError):
                    W.run('base')
        self.assertEqual(self.states()[-1], 'consumed'); self.assertRegex(self.start(), 'already consumed')

    # ---- 3. crash BEFORE consume: the launch stays pending, nothing was launched ----------------------------------------
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

    # ---- 4. two concurrent attempts: exactly one launch; root ops refuse while a start holds the lock ------------------
    def test_two_concurrent_starts_launch_exactly_once(self):
        self.launched()
        go_r, go_w = os.pipe(); held_r, held_w = os.pipe()

        def slow():
            os.write(held_w, b'L'); time.sleep(1.5); return {'l1Finalized': 30000}
        kids = [self.fork_start(go=go_r, l1=slow) for _ in range(2)]
        os.write(go_w, b'GG')
        self.assertEqual(os.read(held_r, 1), b'L')                 # one child holds the lock inside its gates
        self.refused(self.rollback, 'lock'); self.refused(self.rearm, 'lock')
        self.assertRegex(self.start(), 'launch lock busy')
        res = [self.reap(*k) for k in kids]
        outs = sorted(o for _, o in res)
        self.assertEqual(len([o for o in outs if o.startswith('exec ')]), 1, outs)
        self.assertEqual(json.loads(next(o for o in outs if o.startswith('exec '))[5:]), ['--bootstrap.anchor', self.launch['anchor']])
        self.assertRegex(next(o for o in outs if not o.startswith('exec ')), 'refused: (launch lock busy|bootstrap anchor already consumed)')
        self.assertEqual(self.states(), ['armed', 'consumed'])
        res = [self.reap(*self.fork_start()) for _ in range(2)]   # a later parallel pair: both refuse
        self.assertTrue(all(o.startswith('refused: ') for _, o in res), res); self.assertEqual(self.states(), ['armed', 'consumed'])

    # ---- 5. expired start: refused, nothing consumed --------------------------------------------------------------------
    def test_expired_start_refuses_without_consuming(self):
        self.launched(); before = self.journal()
        na = datetime.datetime.fromisoformat(self.launch['notAfter']).timestamp()
        self.assertRegex(self.start(now=na + 1), 'expired')
        self.assertEqual(self.journal(), before); self.assertEqual(self.execs(), [])
        self.assertEqual(self.start(now=na), 'exec')               # <= notAfter
        late = datetime.datetime.fromisoformat(self.launch['notAfter']) + datetime.timedelta(seconds=1)
        self.refused(lambda: self.rearm(now=late), 'stale_launch')
        self.setUp(); TA.BytecodeGate.ready(self, TA.V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        for st in ('bytecodes', 'release'):
            self.run_step(st)
        P.produce(self.d / 'cfg.json', self.out, A=A, coverage=self.cov, release_path=self.rel, release_sha=self.rel_sha,
                  harness_binary_sha=self.cfg['baseBinarySha256'], owner=self.uid, top=self.top)
        late = datetime.datetime.fromisoformat(json.loads((self.out / 'launch.json').read_bytes())['notAfter']) + datetime.timedelta(seconds=1)
        self.refused(lambda: self.arm(now=late), 'stale_launch')
        self.assertFalse((self.out / 'journal').exists())

    # ---- 6. rearm refuses when the DB advanced / changed / the unit runs ------------------------------------------------
    def test_rearm_refuses_unless_the_stopped_db_is_unchanged_at_n(self):
        self.launched(); self.assertEqual(self.start(), 'exec'); before = self.journal()
        self.refused(self.rollback.__self__.arm, 'armed')
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
        self.setUp(); TA.BytecodeGate.ready(self, TA.V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        for st in ('bytecodes', 'release'):
            self.run_step(st)
        P.produce(self.d / 'cfg.json', self.out, A=A, coverage=self.cov, release_path=self.rel, release_sha=self.rel_sha,
                  harness_binary_sha=self.cfg['baseBinarySha256'], owner=self.uid, top=self.top)
        self.lsha = sha((self.out / 'launch.json').read_bytes())
        self.assertRegex(self.start(), 'launch lock .* unavailable')  # produced but never armed: no start
        self.state['cp']['finish'] = TA.N + 1; self.write()
        self.refused(self.arm, 'head_advanced')
        self.assertFalse(any(W.JOURNAL_ENTRY.fullmatch(n) for n in os.listdir(self.out / 'journal')) if (self.out / 'journal').exists() else False)
        self.state['cp']['finish'] = TA.N; self.write(); self.assertEqual(self.arm()['event'], 'armed')   # an interrupted arm may be repeated
        self.refused(self.arm, 'armed')

    # ---- 7. rollback is terminal ----------------------------------------------------------------------------------------
    def test_rollback_is_terminal(self):
        self.launched(); self.assertEqual(self.rollback()['event'], 'rolled-back')
        self.assertRegex(self.start(), 'rolled back')
        self.refused(self.rearm, 'rolled_back'); self.refused(self.rollback, 'rolled_back'); self.refused(self.arm, 'armed')
        self.assertEqual(self.states(), ['armed', 'rolled-back']); self.assertEqual(self.execs(), [])

    # ---- 8. HOLD flags, no finality, and the source pins -----------------------------------------------------------------
    def test_source_holds_refuse_before_consuming_and_no_finality_is_accepted(self):
        self.assertIs(W.LAUNCH_PRODUCER_REVIEWED, False); self.assertIs(P.FINALITY_PROOF_REVIEWED, False)
        self.assertEqual((W.BASE_SERVICE_USER, W.TRUSTED_TOP, W.ROOT_UID), ('rpcbase', pathlib.Path('/'), 0))
        self.assertEqual(W.BASE_RELEASE_SHA256, '4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f')
        self.launched(); before = self.journal()
        self.assertRegex(self.start(reviewed=False), 'HOLD')
        self.assertEqual(self.journal(), before); self.assertEqual(self.execs(), [])
        self.refused(lambda: P.record_bootstrapped(self.out, {'number': TA.N + 100}), 'hold_finality')
        last_sha, last = W.journal_entries(self.out / 'journal', self.uid, self.lsha, self.top)[-1]
        forged = {**last, 'seq': 2, 'prevSha256': last_sha, 'event': 'bootstrapped', 'evidence': {'number': TA.N + 100}}
        (self.out / 'journal/000002.json').write_bytes(json.dumps(forged).encode())
        self.assertRegex(self.start(), "'armed' -> 'bootstrapped' is not allowed")
        self.assertEqual(self.execs(), [])

    # ---- 9. root start + unit marker; legacy unchanged -----------------------------------------------------------------
    def test_release_mode_needs_the_root_handshake_and_legacy_is_unchanged(self):
        self.launched(); before = self.journal()
        with patch.object(W, 'mount') as m:
            self.assertRegex(self.start(env=False), 'root one-shot launch handshake'); m.assert_not_called()
        with patch.object(W.os, 'geteuid', return_value=self.uid + 1):
            self.assertRegex(self.start(), 'root one-shot launch handshake')
        self.assertEqual(self.journal(), before)
        legacy = {'mounts': T.manifest['mounts'], 'binaries': {}}
        self.assertRegex(self.start(manifest=legacy), 'legacy bin/base under the root release-mode unit drop-in')
        self.assertEqual(self.start(manifest=legacy, env=False), 'exec')
        (_, path, argv, env, _), = self.execs()
        self.assertEqual(path, '/opt/enclave-rpc/bin/base'); self.assertNotIn('--bootstrap.anchor', argv)
        self.assertEqual(env['BASE_NODE_L1_TRUST_RPC'], 'false')
        self.assertFalse([e for e in self.events if e[0] == 'drop'], 'legacy mode never touches identities')
        self.assertEqual(self.journal(), before)

    # ---- 10. lock/journal ownership, symlinks, chain ---------------------------------------------------------------------
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
        (jd / '000002.json').unlink(); (jd / '000001.json').unlink()
        self.assertRegex(self.start(), 'no launch journal')       # a removed journal never silently re-arms
        self.assertEqual(len(self.execs()), 1)

    def test_launch_pin_is_the_immutable_record_only(self):
        self.launched()
        self.lsha = '00' * 32; self.assertRegex(self.start(), 'differ from the operator pin')
        self.lsha = sha((self.out / 'launch.json').read_bytes())
        with patch.object(W, 'CONFIG', {}):
            pass
        ps = self.boundary(); ps[5] = patch.object(W, 'CONFIG', {'baseBootstrap': {'coverageVerified': True, 'l1Block': 1, 'blobSlot': 2,
            'anchorLaunch': {'launchSha256': self.lsha, 'lifecycleSha256': '00' * 32}}, 'baseRetention': {'historyFromBlock': T.HISTORY_FROM, 'stateHistoryFromBlock': T.STATE_FROM}})
        with contextlib.ExitStack() as st:
            for p in ps:
                st.enter_context(p)
            with self.assertRaisesRegex(AssertionError, r'anchorLaunch \{launchSha256\}'):
                W.run('base')
        self.assertEqual(self.states(), ['armed'])


class DropPrivileges(unittest.TestCase):
    pw = type('PW', (), {'pw_name': 'rpcbase', 'pw_uid': 977, 'pw_gid': 977})()

    def test_drop_order_ids_and_irreversibility(self):
        calls = []
        with patch.object(W.os, 'initgroups', side_effect=lambda *a: calls.append(('initgroups',) + a)), \
                patch.object(W.os, 'setresgid', side_effect=lambda *a: calls.append(('setresgid',) + a)), \
                patch.object(W.os, 'setresuid', side_effect=lambda *a: calls.append(('setresuid',) + a)), \
                patch.object(W.os, 'getresuid', return_value=(977,) * 3), patch.object(W.os, 'getresgid', return_value=(977,) * 3), \
                patch.object(W.os, 'setuid', side_effect=PermissionError) as su:
            W.drop_privileges(self.pw)
        self.assertEqual(calls, [('initgroups', 'rpcbase', 977), ('setresgid', 977, 977, 977), ('setresuid', 977, 977, 977)])
        self.assertEqual(su.call_args, call(0))

    def test_incomplete_or_reversible_drop_refuses(self):
        base = [patch.object(W.os, n) for n in ('initgroups', 'setresgid', 'setresuid')]
        for ps, why in (([patch.object(W.os, 'getresuid', return_value=(977, 977, 0)), patch.object(W.os, 'getresgid', return_value=(977,) * 3)], 'incomplete'),
                        ([patch.object(W.os, 'getresuid', return_value=(977,) * 3), patch.object(W.os, 'getresgid', return_value=(977,) * 3),
                          patch.object(W.os, 'setuid')], 'reversible')):
            with contextlib.ExitStack() as st, self.subTest(why):
                for p in base + ps:
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
