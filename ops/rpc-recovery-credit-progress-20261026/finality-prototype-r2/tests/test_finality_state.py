#!/usr/bin/env python3
"""finality_state.py adversarial tests (PREPARED; NOT run by Claude: root's r2/jobs/root-finality-tests.sh runs them, exact count 27).
Real files in a private temp tree (OWNER = this uid), a fake /proc tree, a fake wrapper (lock + journal), a fake A1 gate (the
pinned gate itself is covered by its own published tests), and - for the e2e cases - the REAL pinned JS core over a loopback
JSON-RPC stub serving a synthetic chain built with the reviewed vendor hashing (tests/helpers/chain.mjs)."""
import datetime, fcntl, hashlib, http.server, json, os, pathlib, shutil, subprocess, sys, tempfile, threading, unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))
import finality_state as FS                                                        # noqa: E402

NODE, DEPS = os.environ['FINALITY_NODE'], os.environ['ANCHOR_DEPS_ROOT']
RUNNER = pathlib.Path(os.environ['FINALITY_A1_RUNNER'])                           # the reviewed live-1958/run.py (bytes copied)
FS.OWNER = os.getuid()
sha = lambda b: hashlib.sha256(b).hexdigest()
N, NP, L1 = 1000, 1137, 26_271_848
NOW = datetime.datetime(2026, 10, 26, 3, 0, 0, tzinfo=datetime.timezone.utc)
GAME0, GAME1 = '0x343b3a99527af07d2cfb2652747b9e37715e21ac', '0x' + 'ab' * 20


def chain(fork_at=None, salt='db'):
    args = [NODE, str(HERE / 'helpers/chain.mjs'), '--json', str(N - 3), str(NP + 40)] + ([str(fork_at), salt] if fork_at else [])
    return json.loads(subprocess.run(args, capture_output=True, text=True, check=True, env={'ANCHOR_DEPS_ROOT': DEPS, 'PATH': '/usr/bin:/bin'}).stdout)


CHAIN = chain()


class Stub:
    """loopback JSON-RPC over a chain dict: explicit numbers only (a label is a test failure)"""
    def __init__(self, c, chain_id='0x2105'):
        stub = self; self.c, self.chain_id, self.labels = c, chain_id, []

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                q = json.loads(self.rfile.read(int(self.headers['content-length'])))
                if q['method'] == 'eth_chainId':
                    res = stub.chain_id
                else:
                    sel = q['params'][0]
                    if not sel.startswith('0x'):
                        stub.labels.append(sel)
                    res = stub.c['headers'].get(str(int(sel, 16)))
                b = json.dumps({'jsonrpc': '2.0', 'id': q['id'], 'result': res}).encode()
                self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b)))
                self.end_headers(); self.wfile.write(b)
        self.srv = http.server.HTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]

    def close(self):
        self.srv.shutdown(); self.srv.server_close()


class FakeW:
    def __init__(self):
        self.events = [('a' * 64, {'event': 'armed', 'seq': 1}), ('b' * 64, {'event': 'consumed', 'seq': 2})]

    def launch_lock(self, d, owner, top):
        fd = os.open(pathlib.Path(d) / 'journal.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd); raise AssertionError('launch lock busy')
        return fd

    def journal_entries(self, jd, owner, lsha, top):
        return list(self.events)


class Base(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='fin-')); t = self.t
        self.release = b'base-release-binary'
        (t / 'data/db').mkdir(parents=True); (t / 'data/db/mdbx.dat').write_bytes(b'db')
        st = os.stat(t / 'data/db/mdbx.dat')
        self.launch = {'format': 'enclave-base-bootstrap-launch/v1', 'anchor': f'{N}:{CHAIN["headers"][str(N)]["hash"]}', 'baseReleaseSha256': sha(self.release),
                       'bindings': {'datadir': str(t / 'data'), 'dbIdentity': {'mdbx': {'dev': st.st_dev, 'ino': st.st_ino, 'size': 2, 'mtimeNs': 0}},
                                    'a1': {'N': str(N), 'outputRoot': CHAIN['outputRoots'][str(N)], 'game': GAME0, 'l1Finalized': L1, 'initialSha256': 'x'}}}
        self.d = t / 'launch'; self.d.mkdir(); (self.d / 'journal').mkdir()
        os.close(os.open(self.d / 'journal.lock', os.O_CREAT | os.O_RDWR, 0o600))
        self.write_launch()
        self.fdir = t / 'finality'; self.fdir.mkdir(); self.work = t / 'work'; self.work.mkdir()
        self.W = FakeW(); self.stub = None
        self.a1 = self.make_a1('a1')
        self.make_proc(port=1, start='111')

    def tearDown(self):
        if self.stub:
            self.stub.close()
        FS.FINALITY_PROTOTYPE_REVIEWED = False
        shutil.rmtree(self.t, ignore_errors=True)

    def write_launch(self, pin=None):
        lb = json.dumps(self.launch, sort_keys=True).encode()
        (self.d / 'launch.json').write_bytes(lb)
        (self.t / 'chain.json').write_text(json.dumps({'baseBootstrap': {'anchorLaunch': {'launchSha256': pin or sha(lb)}}}))

    def make_a1(self, name, n=NP, root=None, game=GAME1, l1=L1 + 100, at=NOW - datetime.timedelta(seconds=120), **rr):
        r = self.t / name; r.mkdir()
        self.run_seq = getattr(self, 'run_seq', 0) + 1                 # r2: every fixture run has its OWN valid run identity
        shutil.copyfile(RUNNER, r / 'run.py')
        ev = json.dumps({'N': str(n), 'tag': name}).encode(); (r / 'a1-evidence.json').write_bytes(ev)
        run = {'startedAt': (at - datetime.timedelta(seconds=60 + self.run_seq)).isoformat(), 'finishedAt': (at + datetime.timedelta(seconds=1)).isoformat(),
               'inputPins': FS.A1_INPUT_PINS, 'heliosStatus': {'verdict': 'fresh-finalized', 'binarySha256': FS.HELIOS_SHA256},
               'a1Exit': 0, 'processStopped': True, 'productionActivated': False, **rr}
        (r / 'run-result.json').write_text(json.dumps(run))
        (r / 'a1-config.json').write_text(json.dumps({'portal': FS.MAINNET['portal'], 'asr': FS.MAINNET['asr'], 'expectedChainId': 1}))
        self.summaries = getattr(self, 'summaries', {})
        self.summaries[sha(ev)] = {'mode': 'fresh-initial', 'initialSha256': sha(ev), 'N': str(n), 'outputRoot': root or CHAIN['outputRoots'][str(n)],
                                   'game': game, 'asr': FS.MAINNET['asr'], 'respectedGameType': 621, 'at': at.isoformat(),
                                   'pins': {a: {'codeHash': c} for a, c in FS.MAINNET['codeHashes'].items()},
                                   'l1': {'number': l1, 'hash': '0x' + 'cd' * 32, 'timestamp': int(at.timestamp()) - 100, 'ageSec': 100}}
        return r

    def gate(self, b):
        return dict(self.summaries[sha(b)])

    def make_proc(self, port, start, exe=None, db=None, listeners=1):
        p = self.t / 'proc'
        shutil.rmtree(p, ignore_errors=True); (p / 'net').mkdir(parents=True)
        rows = ''.join(f'  {i}: 0100007F:{port:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 {900 + i} 1\n' for i in range(listeners))
        (p / 'net/tcp').write_text('  sl local rem st tx rx tr tm retr uid timeout inode\n' + rows)
        for i in range(listeners):
            pd = p / str(4242 + i); (pd / 'fd').mkdir(parents=True)
            os.symlink(f'socket:[{900 + i}]', pd / 'fd/3'); os.symlink(db or (self.t / 'data/db/mdbx.dat'), pd / 'fd/4')
            (pd / 'exe').write_bytes(exe or self.release)
            (pd / 'stat').write_text(f'{4242 + i} (base) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0\n')
        self.proc = str(p)

    def serve(self, c=CHAIN, **kw):
        self.stub = Stub(c, **kw); self.make_proc(port=self.stub.port, start='111')
        return f'http://127.0.0.1:{self.stub.port}/'

    def q(self, a1=None, url='http://127.0.0.1:1/', write=False, now=NOW):
        return FS.qualify(self.d, self.t / 'chain.json', self.fdir, a1 or self.a1, url, W=self.W, gate=self.gate, node=NODE, deps_root=DEPS,
                          workdir=self.work, write=write, now=now, top=self.t, proc=self.proc, chunk=32)

    def refused(self, code, fn, *a, **k):
        with self.assertRaises(FS.Refused) as cm:
            fn(*a, **k)
        self.assertEqual(cm.exception.code, code, str(cm.exception))
        return cm.exception

    def fake_core(self, result=None, exc=None):
        orig = FS.run_core
        def f(launch, a1, prior, *a, **k):
            if exc:
                raise exc
            return result or {'verdict': 'post-anchor-finality-qualified', 'original': {'N': N}, 'fresh': {'N': a1['N'], 'blockHash': CHAIN['headers'][str(a1['N'])]['hash']},
                              'span': a1['N'] - N, 'priorChecked': [e['evidence']['fresh']['N'] for e in prior]}
        FS.run_core = f
        self.addCleanup(setattr, FS, 'run_core', orig)


class EndToEnd(Base):
    def test_check_qualifies_with_the_real_core_and_writes_nothing(self):
        r = self.q(url=self.serve())
        self.assertIsNone(r['event']); self.assertEqual(r['fresh']['N'], NP); self.assertEqual(r['original']['blockHash'], CHAIN['headers'][str(N)]['hash'])
        self.assertEqual(os.listdir(self.fdir), []); self.assertEqual(self.stub.labels, [])

    def test_record_then_status_current_then_stale_after_restart(self):
        FS.FINALITY_PROTOTYPE_REVIEWED = True
        url = self.serve()
        r = self.q(url=url, write=True)
        self.assertEqual((r['event'], r['seq']), ('qualified', 1))
        s = FS.status(self.d, self.t / 'chain.json', self.fdir, url, W=self.W, top=self.t, proc=self.proc)
        self.assertEqual((s['state'], s['qualified'], s['freshN']), ('qualified', True, NP))
        self.make_proc(port=self.stub.port, start='999')                                  # the node restarted
        s = FS.status(self.d, self.t / 'chain.json', self.fdir, url, W=self.W, top=self.t, proc=self.proc)
        self.assertEqual((s['state'], s['qualified']), ('stale-after-restart', False))

    def test_db_mismatch_another_chain_below_the_fresh_anchor_is_a_recorded_contradiction(self):
        FS.FINALITY_PROTOTYPE_REVIEWED = True
        db = chain(fork_at=N, salt='other-db')                                            # linked N..N', but N is not the launch block
        self.summaries[next(iter(self.summaries))]['outputRoot'] = db['outputRoots'][str(NP)]
        e = self.refused('original_anchor:output_root', self.q, url=self.serve(db), write=True)
        self.assertTrue(e.contradiction)
        self.assertEqual(json.loads((self.fdir / '000001.json').read_text())['event'], 'contradicted')
        self.refused('terminal', self.q, a1=self.make_a1('a1b', n=NP + 1), url=f'http://127.0.0.1:{self.stub.port}/', write=True)


class Gates(Base):
    def test_record_holds_while_the_prototype_is_unreviewed(self):
        self.fake_core()
        self.refused('hold_prototype', self.q, write=True)
        self.assertEqual(os.listdir(self.fdir), [])

    def test_no_proof_status_is_none_and_a_missing_a1_dir_refuses(self):
        self.assertEqual(FS.status(self.d, self.t / 'chain.json', self.fdir, 'http://127.0.0.1:1/', W=self.W, top=self.t, proc=self.proc)['state'], 'none')
        self.refused('path', self.q, a1=self.t / 'absent')
        self.refused('path', FS.status, self.d, self.t / 'chain.json', self.t / 'no-finality-dir', 'http://127.0.0.1:1/', W=self.W, top=self.t, proc=self.proc)

    def test_launch_pin_absent_or_different_refuses(self):
        self.write_launch(pin='0' * 64); self.refused('launch_pin', self.q)
        (self.t / 'chain.json').write_text('{}'); self.refused('no_launch_pin', self.q)

    def test_launch_not_started_or_rolled_back_refuses(self):
        self.W.events = self.W.events[:1]; self.refused('not_started', self.q)
        self.W.events = [('a' * 64, {'event': 'rolled-back', 'seq': 3})]; self.refused('rolled_back', self.q)

    def test_lock_busy_refuses_nothing_written(self):
        self.fake_core(); FS.FINALITY_PROTOTYPE_REVIEWED = True
        fd = os.open(self.d / 'journal.lock', os.O_RDWR); fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            self.refused('lock', self.q, write=True)
        finally:
            os.close(fd)
        self.assertEqual(os.listdir(self.fdir), [])

    def test_stale_receipt_refuses(self):
        self.fake_core(); self.refused('a1_stale', self.q, now=NOW + datetime.timedelta(seconds=FS.A1_MAX_RECEIPT_AGE_SEC + 1))

    def test_not_post_anchor_same_game_or_older_l1_refuses(self):
        self.fake_core()
        self.refused('not_post_anchor', self.q, a1=self.make_a1('eq', n=N))
        self.refused('same_game', self.q, a1=self.make_a1('g', game=GAME0))
        self.refused('stale_l1', self.q, a1=self.make_a1('l1', l1=L1))

    def test_replayed_or_not_newer_receipt_refuses(self):
        self.fake_core(); FS.FINALITY_PROTOTYPE_REVIEWED = True
        self.q(write=True)
        self.refused('replayed', self.q, write=True)
        self.refused('not_newer', self.q, a1=self.make_a1('older', n=NP - 1), write=True)
        self.refused('not_newer', self.q, a1=self.make_a1('samel1', n=NP + 1, l1=L1 + 100), write=True)
        r = self.q(a1=self.make_a1('newer', n=NP + 1, l1=L1 + 200), write=True)
        self.assertEqual((r['seq'], r['priorChecked']), (2, [NP]))

    def test_runner_provenance_failures_refuse(self):
        self.fake_core()
        for name, kw in [('h', {'heliosStatus': {'verdict': 'fresh-finalized', 'binarySha256': '0' * 64}}), ('x', {'a1Exit': 1}),
                         ('s', {'processStopped': False}), ('p', {'inputPins': {}}), ('e', {'error': 'boom'})]:
            self.refused('a1_provenance', self.q, a1=self.make_a1(name, **kw))
        r = self.make_a1('runpy'); (r / 'run.py').write_text('print(1)'); self.refused('a1_provenance', self.q, a1=r)
        r = self.make_a1('cfg'); (r / 'a1-config.json').write_text(json.dumps({'portal': '0x' + '00' * 20, 'asr': FS.MAINNET['asr'], 'expectedChainId': 1}))
        self.refused('a1_provenance', self.q, a1=r)

    def test_receipt_outside_its_run_window_refuses(self):
        self.fake_core(); r = self.make_a1('w')
        rr = json.loads((r / 'run-result.json').read_text()); rr['finishedAt'] = (NOW - datetime.timedelta(seconds=600)).isoformat()
        (r / 'run-result.json').write_text(json.dumps(rr)); self.refused('a1_provenance', self.q, a1=r)

    def test_wrong_asr_type_or_code_hash_refuses(self):
        self.fake_core()
        k = next(iter(self.summaries)); self.summaries[k]['respectedGameType'] = 1; self.refused('a1_pins', self.q)
        self.summaries[k]['respectedGameType'] = 621; self.summaries[k]['pins'] = {}; self.refused('a1_pins', self.q)

    def test_untrusted_files_symlink_or_writable_refuse(self):
        self.fake_core()
        r = self.make_a1('sym'); (r / 'a1-evidence.json').unlink(); os.symlink(self.a1 / 'a1-evidence.json', r / 'a1-evidence.json')
        self.refused('untrusted_file', self.q, a1=r)
        r = self.make_a1('gw'); os.chmod(r / 'run-result.json', 0o666); self.refused('untrusted_file', self.q, a1=r)

    def test_process_binding_refusals(self):
        self.fake_core()
        self.make_proc(port=1, start='1', exe=b'other-binary'); self.refused('process_binary', self.q)
        other = self.t / 'other.mdbx'; other.write_bytes(b'x')
        self.make_proc(port=1, start='1', db=other); self.refused('process_db', self.q)
        self.make_proc(port=1, start='1', listeners=2); self.refused('process_binding', self.q)
        self.make_proc(port=1, start='1'); self.refused('rpc_url', self.q, url='http://10.0.0.1:1/')
        self.refused('process_binding', self.q, url='http://127.0.0.1:2/')

    def test_process_changed_during_the_proof_refuses_and_writes_nothing(self):
        FS.FINALITY_PROTOTYPE_REVIEWED = True
        def restart(*a, **k):
            self.make_proc(port=1, start='222')
            return {'verdict': 'post-anchor-finality-qualified', 'original': {}, 'fresh': {'N': NP, 'blockHash': '0x' + '00' * 32}, 'span': 1, 'priorChecked': []}
        orig = FS.run_core; FS.run_core = restart; self.addCleanup(setattr, FS, 'run_core', orig)
        self.refused('process_changed', self.q, write=True); self.assertEqual(os.listdir(self.fdir), [])

    def test_contradiction_is_terminal_and_only_recorded_for_the_same_process(self):
        FS.FINALITY_PROTOTYPE_REVIEWED = True
        orig = FS.run_core; self.addCleanup(setattr, FS, 'run_core', orig)
        def moved(*a, **k):
            self.make_proc(port=1, start='333'); raise FS.Refused('ancestry:unlinked', 'x', contradiction=True)
        FS.run_core = moved
        self.refused('ancestry:unlinked', self.q, write=True); self.assertEqual(os.listdir(self.fdir), [])   # process changed: not recorded
        self.make_proc(port=1, start='111')
        FS.run_core = lambda *a, **k: (_ for _ in ()).throw(FS.Refused('fresh_anchor:output_root', 'y', contradiction=True))
        self.refused('fresh_anchor:output_root', self.q, write=True)
        self.assertEqual(json.loads((self.fdir / '000001.json').read_text())['event'], 'contradicted')
        self.refused('terminal', self.q, a1=self.make_a1('after', n=NP + 1, l1=L1 + 300), write=True)
        self.refused('transition', FS.revoke, self.d, self.t / 'chain.json', self.fdir, 'r', W=self.W, now=NOW, top=self.t)

    def test_refusal_from_the_core_is_never_recorded(self):
        FS.FINALITY_PROTOTYPE_REVIEWED = True
        self.fake_core(exc=FS.Refused('not_synced', 'node behind'))
        self.refused('not_synced', self.q, write=True); self.assertEqual(os.listdir(self.fdir), [])

    def test_revoke_is_terminal(self):
        self.fake_core(); FS.FINALITY_PROTOTYPE_REVIEWED = True
        self.q(write=True)
        FS.revoke(self.d, self.t / 'chain.json', self.fdir, 'launch rolled back', W=self.W, now=NOW, top=self.t)
        self.refused('terminal', self.q, a1=self.make_a1('n2', n=NP + 2, l1=L1 + 400), write=True)
        s = FS.status(self.d, self.t / 'chain.json', self.fdir, 'http://127.0.0.1:1/', W=self.W, top=self.t, proc=self.proc)
        self.assertEqual((s['state'], s['qualified']), ('revoked', False))

    def test_status_stale_after_rearm_and_unbound_process(self):
        self.fake_core(); FS.FINALITY_PROTOTYPE_REVIEWED = True
        self.q(write=True)
        self.W.events = self.W.events + [('c' * 64, {'event': 'rearmed', 'seq': 3}), ('d' * 64, {'event': 'consumed', 'seq': 4})]
        s = FS.status(self.d, self.t / 'chain.json', self.fdir, 'http://127.0.0.1:1/', W=self.W, top=self.t, proc=self.proc)
        self.assertEqual(s['state'], 'stale-launch-changed')
        self.make_proc(port=1, start='111', exe=b'other')
        self.assertEqual(FS.status(self.d, self.t / 'chain.json', self.fdir, 'http://127.0.0.1:1/', W=self.W, top=self.t, proc=self.proc)['state'], 'unbound')

    def test_tampered_or_foreign_finality_journal_refuses(self):
        self.fake_core(); FS.FINALITY_PROTOTYPE_REVIEWED = True
        self.q(write=True)
        e = json.loads((self.fdir / '000001.json').read_text()); e['launchSha256'] = '0' * 64
        (self.fdir / '000001.json').write_text(json.dumps(e)); self.refused('finality_journal', self.q, a1=self.make_a1('t', n=NP + 3, l1=L1 + 500), write=True)
        (self.fdir / '000001.json').unlink(); (self.fdir / '000002.json').write_text('{}')
        self.refused('finality_journal', self.q, a1=self.make_a1('t2', n=NP + 4, l1=L1 + 600))

    def test_interrupted_append_leaves_the_old_state(self):
        self.fake_core(); FS.FINALITY_PROTOTYPE_REVIEWED = True
        (self.fdir / '.partial-99').write_text('garbage')
        r = self.q(write=True); self.assertEqual(r['seq'], 1); self.assertEqual(sorted(os.listdir(self.fdir)), ['000001.json'])

    def test_evidence_binds_launch_head_process_receipt_and_code(self):
        self.fake_core(); FS.FINALITY_PROTOTYPE_REVIEWED = True
        r = self.q(write=True)
        self.assertEqual(r['launchJournal'], {'seq': 2, 'entrySha256': 'b' * 64})
        self.assertEqual((r['process']['pid'], r['process']['startTime'], r['process']['exeSha256']), (4242, '111', sha(self.release)))
        self.assertEqual(r['a1']['receiptSha256'], next(iter(self.summaries)))
        self.assertEqual(r['code']['vendor/anchor-bootstrap.mjs'], FS.CORE_PINS['vendor/anchor-bootstrap.mjs'])

    def test_core_pin_is_enforced(self):
        orig = dict(FS.CORE_PINS); FS.CORE_PINS['vendor/anchor-bootstrap.mjs'] = '0' * 64
        self.addCleanup(FS.CORE_PINS.update, orig)
        self.refused('core_pin', self.q, url=self.serve())

    def test_wrong_chain_id_from_the_bound_node_refuses(self):
        self.refused('wrong_chain', self.q, url=self.serve(chain_id='0x1'))
        self.assertEqual(os.listdir(self.fdir), [])

    def test_node_behind_the_fresh_anchor_refuses_not_synced(self):
        short = {'headers': {k: v for k, v in CHAIN['headers'].items() if int(k) < NP}, 'outputRoots': CHAIN['outputRoots']}
        self.refused('not_synced', self.q, url=self.serve(short))


if __name__ == '__main__':
    unittest.main()
