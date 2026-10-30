"""Mocked-fixture tests of a2a4.py (queue 256; no reth, no datadir, no network). The fake `base` implements the audited
command surface (test/fake_base.py); header hashing and the output-root check use the REAL published anchor module."""
import datetime, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, time, unittest
H = pathlib.Path(__file__).resolve().parents[1]; P = pathlib.Path(os.environ.get('A2A4_PROJECT', '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025'))
spec = importlib.util.spec_from_file_location('a2a4', H / 'a2a4.py'); A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
ANCHOR = P / 'source/ops/rpc-backend-bootstrap/2026-10-25/finality-investigation/anchor-bootstrap-review/anchor-bootstrap.mjs'
DEPS = P / 'source'
N = 52_866_960
FX = json.loads(subprocess.run(['node', str(H / 'test/make_fixture.mjs'), str(N)], capture_output=True, text=True, check=True,
                               env=dict(os.environ, A=ANCHOR.as_uri(), D=(DEPS / 'node_modules/@noble/hashes/sha3.js').as_uri())).stdout)
HELP = {'stage unwind': '--datadir --config <to-block|num-blocks> to-block --offline', 'stage run': '--from --to --commit --skip-unwind --checkpoints --config',
        'stage drop': 'merkle hashing --config', 'db get': 'mdbx static-file rocksdb', 'db': 'get settings stage-checkpoints list'}
A.TRUSTED_UID = os.getuid()                     # tests run unprivileged; production requires uid 0
A.ALLOW_INCOMPLETE_PROC_SCAN = True              # unprivileged test runs cannot read other users' fd tables
S = A.SEL
OUT = lambda n: [{'path': f'f{n}', 'size': 1, 'blake3': 'ab' * 32}]
MANIFEST = {'block': 53_048_526, 'chain_id': 8453, 'storage_version': 2, 'components': {
    'state': {'file': 'state.tar.zst', 'size': 1, 'output_files': OUT('s')},
    **{c: {'blocks_per_file': 500000, 'total_blocks': 53_048_527, 'chunk_sizes': [1] * 107, 'chunk_output_files': [OUT(i) for i in range(107)]}
       for c in ('headers', 'transactions', 'receipts', 'transaction_senders', 'account_changesets', 'storage_changesets')}}}
entries = lambda prof: [{'component': c, 'chunk': i} for c, i in sorted(S.derive(MANIFEST, prof), key=lambda k: (k[0], -1 if k[1] is None else k[1]))]
def argv_for(prof, datadir, manifest):
    return [S.BASE_BINARY, 'snapshot', 'download', '--chain', 'base', '--manifest-path', manifest, '--datadir', datadir] + \
        [x for k, v in S.PROFILES[prof]['flags'].items() for x in (k, str(v))] + ['--download-concurrency', '16', '--resumable=true', '-y']
PRUNE_OK = '[prune.segments]\naccount_history = { before = 52500000 }\nstorage_history = { before = 52500000 }\n'


class Case(unittest.TestCase):
    def setUp(self):
        self.receipt = None
        self.t = tempfile.TemporaryDirectory(); d = pathlib.Path(self.t.name); self.d = d
        (d / 'datadir').mkdir(); (d / 'bin').mkdir()
        fake = d / 'bin/base'; fake.write_text(f'#!/bin/sh\nexec {sys.executable} {H / "test/fake_base.py"} "$@"\n'); fake.chmod(0o755)
        sysd = d / 'bin/systemctl'
        sysd.write_text('#!/bin/sh\ncase "$4" in Result) echo "${FAKE_RESULT:-success}";; ExecMainStatus) echo "${FAKE_EXIT:-0}";; '
                        '*) if [ "$2" = "${FAKE_ACTIVE_UNIT:-none}" ]; then echo active; else echo "${FAKE_UNIT_STATE:-inactive}"; fi;; esac\n'); sysd.chmod(0o755)
        for k in ('FAKE_RESULT', 'FAKE_EXIT', 'FAKE_SLEEP', 'FAKE_SPAM', 'FAKE_ACTIVE_UNIT', 'FAKE_BIG', 'FAKE_ORPHAN', 'FAKE_UNIT_STATE'): os.environ.pop(k, None)
        os.environ['PATH'] = f'{d / "bin"}:{os.environ["PATH"]}'; os.environ.pop('FAKE_UNIT_STATE', None)
        os.environ['FAKE_STATE'] = str(d / 'state.json'); os.environ['FAKE_LOG'] = str(d / 'argv.log')
        headers = {str(N): FX['header']}
        self.state = {'v2': True, 'help': dict(HELP), 'cp': {'headers': 53_048_526, 'bodies': 53_048_526, 'execution': 53_048_526,
                      'merkle-execute': 53_048_526, 'finish': 53_048_526}, 'headersTip': 53_048_526, 'headers': headers,
                      'labels': {'LastFinalizedBlock': 53_048_000, 'LastSafeBlock': 53_048_400}, 'rebuiltRoot': FX['header']['stateRoot']}
        (d / 'reth.toml').write_text(PRUNE_OK); (d / 'snapshot-complete').write_text('')
        (d / 'manifest.json').write_text(json.dumps(MANIFEST)); A.MANIFEST_SHA = A.sha256(d / 'manifest.json')
        dd = os.stat(d / 'datadir')
        self.receipt = {'format': 'base-snapshot-completion-receipt/v1', 'manifestSha256': A.MANIFEST_SHA, 'block': 53_048_526, 'chainId': 8453,
                        'storageVersion': 2, 'unit': A.SNAPSHOT_UNIT, 'unitResult': 'success', 'execMainStatus': 0, 'datadir': str(d / 'datadir'),
                        'profile': S.FINAL_PROFILE, 'baseBinarySha256': S.BASE_BINARY_SHA256, 'downloadArgv': argv_for(S.FINAL_PROFILE, str(d / 'datadir'), str(d / 'manifest.json')),
                        'selectedArchives': entries(S.FINAL_PROFILE), 'datadirIdentity': {'dev': dd.st_dev, 'ino': dd.st_ino}}
        self.a1 = {'verdict': 'A1-authenticated', 'N': str(N), 'outputRoot': FX['outputRoot'], 'game': '0x343b3a99527af07d2cfb2652747b9e37715e21ac',
                   'asr': A.MAINNET['asr'], 'respectedGameType': 621, 'pins': {a: {'codeHash': h} for a, h in A.MAINNET['codeHashes'].items()},
                   'reads': {k: 'helios-call' for k in ('anchorRoot', 'anchorGame', 'isGameFinalized', 'isGameBlacklisted', 'isGameRetired', 'gameStatus', 'gameRootClaim')},
                   'l1': {'number': 26271848, 'ageSec': 952}, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        self.cfg = {'datadir': str(d / 'datadir'), 'baseBinary': str(fake), 'baseBinarySha256': A.sha256(fake), 'rethConfig': str(d / 'reth.toml'),
                    'workdir': str(d / 'work'), 'a1Evidence': str(d / 'a1.json'), 'a1MaxAgeSec': 600, 'N': N, 'outputRoot': FX['outputRoot'],
                    'game': '0x343b3a99527af07d2cfb2652747b9e37715e21ac', 'downloadReceipt': str(d / 'receipt.json'), 'manifestPath': str(d / 'manifest.json'),
                    'snapshotMarker': str(d / 'snapshot-complete'), 'timeouts': {'unwindChunkSec': 600, 'merkleSec': 3600, 'bytecodeSec': 600}, 'inPlaceReviewed': True,
                    'unwindChunk': 50_000, 'anchorModule': str(ANCHOR), 'depsRoot': str(DEPS), 'node': shutil.which('node')}
        self.write()

    def tearDown(self): self.t.cleanup()

    def write(self):
        (self.d / 'state.json').write_text(json.dumps(self.state)); (self.d / 'a1.json').write_text(json.dumps(self.a1))
        if self.receipt is not None: (self.d / 'receipt.json').write_text(json.dumps(self.receipt))
        elif (self.d / 'receipt.json').exists(): (self.d / 'receipt.json').unlink()
        (self.d / 'cfg.json').write_text(json.dumps(self.cfg))

    def run_step(self, step):
        self.write(); code = A.main(['a2a4.py', step, str(self.d / 'cfg.json')])
        self.state = self.st()                        # carry the RUNTIME DB (what the step did) into the next step, never the setUp fixture
        recs = sorted((self.d / 'work').glob(f'run-{step}-*.json')); return code, json.loads(recs[-1].read_text())

    def refused(self, step, code):
        rc, rec = self.run_step(step); self.assertEqual(rc, 1, rec); self.assertTrue(rec['refused'].startswith(code + ':'), rec['refused']); return rec

    def argv(self): return [m for m in (json.loads(l) for l in (self.d / 'argv.log').read_text().splitlines()) if '--help' not in m]

    def st(self): return json.loads((self.d / 'state.json').read_text())

    def checker(self, receipt):
        p = self.d / 'bin/checker'; p.write_text(f'#!/bin/sh\necho {json.dumps(json.dumps(receipt))}\n'); p.chmod(0o755)
        self.cfg['bytecodeChecker'] = str(p); self.cfg['bytecodeCheckerSha256'] = A.sha256(p)
        (self.d / 'datadir/db').mkdir(exist_ok=True); (self.d / 'datadir/db/mdbx.dat').write_bytes(b'x')


class Gates(Case):
    def test_plan_ok_lists_chunked_unwind_to_exactly_n_and_full_merkle_from_zero(self):
        rc, rec = self.run_step('plan'); self.assertEqual(rc, 0, rec); p = rec['result']
        targets = [int(c[-1]) for c in p['a3']]
        self.assertEqual(targets[-1], N); self.assertEqual(targets, sorted(targets, reverse=True)); self.assertEqual(len(targets), 4)
        self.assertIn(['--from', '0', '--to', str(N)], [c[6:10] for c in p['a4']])
        self.assertTrue(all('--config' in c for c in p['a3'] + p['a4']))
        self.assertFalse(any(m for m in self.argv() if m[1:3] in (['stage', 'unwind'], ['stage', 'run'], ['stage', 'drop'])), 'plan never mutates')

    def test_stale_or_foreign_a1_is_refused(self):
        self.a1['at'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=601)).isoformat(); self.refused('plan', 'a1_stale')
        self.setUp(); self.a1['asr'] = '0xdb9091e48b1c42992a1213e6916184f9ebdbfedf'; self.refused('plan', 'a1_pins')
        self.setUp(); self.a1['N'] = str(N + 1); rec = self.refused('plan', 'a1_anchor_advanced')   # N+1 is the specific 'advanced' refusal
        self.assertIn(self.a1['game'], rec['refused'], 'the message names the game (f-string, not a literal placeholder)')
        self.setUp(); self.a1['N'] = str(N - 1); self.refused('plan', 'a1_anchor')            # a wrong LOWER N is foreign, not advanced
        self.setUp(); self.a1['outputRoot'] = '0x' + '33' * 32; self.refused('plan', 'a1_anchor')
        self.setUp(); self.a1['game'] = '0x' + '44' * 20; self.refused('plan', 'a1_anchor')
        self.setUp(); self.a1['reads']['isGameBlacklisted'] = 'rpc'; self.refused('plan', 'a1_unproven')

    def test_prerequisites_fail_closed(self):
        (self.d / 'reth.toml').write_text('[prune.segments]\naccount_history = { distance = 140000 }\nstorage_history = { before = 52500000 }\n'); self.refused('plan', 'prune_config')
        self.setUp(); (self.d / 'datadir/proofs').mkdir(); self.refused('plan', 'proofs_store')
        self.setUp(); self.receipt = None; self.refused('plan', 'no_receipt')
        self.setUp(); os.environ['FAKE_UNIT_STATE'] = 'active'; self.refused('plan', 'service_running')
        self.setUp(); self.state['help']['stage run'] = '--from --to --commit'; self.refused('plan', 'capability')
        self.setUp(); self.cfg['baseBinarySha256'] = '0' * 64; self.refused('plan', 'binary_pin')
        self.setUp(); self.cfg['backup'] = '/x'; self.refused('plan', 'backup_unsupported')
        self.setUp(); self.state['v2'] = False; self.refused('plan', 'v1_layout')
        self.setUp(); self.cfg['minFreeBytes'] = 10**18; self.refused('plan', 'capacity')

    def test_download_receipt_binds_manifest_unit_marker_and_datadir(self):
        rc, rec = self.run_step('plan'); self.assertEqual(rc, 0, rec); self.assertEqual(rec['result']['gates']['download']['archives'], 134)
        self.setUp(); (self.d / 'snapshot-complete').write_text('complete'); self.refused('plan', 'marker')
        self.setUp(); self.receipt['manifestSha256'] = '0' * 64; self.refused('plan', 'receipt_fields')
        self.setUp(); self.receipt['baseBinarySha256'] = '0' * 64; self.refused('plan', 'receipt_fields')
        self.setUp(); m = json.loads((self.d / 'manifest.json').read_text()); m['components']['storage_changesets']['chunk_output_files'][105] = []
        (self.d / 'manifest.json').write_text(json.dumps(m)); A.MANIFEST_SHA = A.sha256(self.d / 'manifest.json'); self.receipt['manifestSha256'] = A.MANIFEST_SHA
        self.refused('plan', 'unverified_archive')
        self.setUp(); os.environ['FAKE_RESULT'] = 'exit-code'; self.refused('plan', 'download_unit')
        self.setUp(); self.receipt['datadirIdentity'] = {'dev': 1, 'ino': 2}; self.refused('plan', 'receipt_datadir')
        self.setUp(); A.TRUSTED_UID = 0; self.refused('plan', 'untrusted_file'); A.TRUSTED_UID = os.getuid()

    def test_selection_is_exactly_the_pinned_manifest_and_final_profile(self):
        self.assertEqual(len(entries('first-pass-distance-140000')), 116, 'reproduces root measurement of the first pass')
        self.assertEqual(len(entries(S.FINAL_PROFILE)), 134)
        self.receipt.update(profile='first-pass-distance-140000', selectedArchives=entries('first-pass-distance-140000'),
                            downloadArgv=argv_for('first-pass-distance-140000', str(self.d / 'datadir'), str(self.d / 'manifest.json')))
        self.refused('plan', 'first_pass_only')                           # distinguishable, never final readiness
        for bad in ([{'component': 'headers', 'chunk': -1}], [{'component': 'headers', 'chunk': True}], [{'component': 'state', 'chunk': 0}],
                    [{'component': 'headers', 'chunk': 107}], [{'component': 'headers', 'chunk': 1, 'x': 1}], [{'component': 'nope', 'chunk': 1}]):
            self.setUp(); self.receipt['selectedArchives'] = entries(S.FINAL_PROFILE) + bad; self.refused('plan', 'manifest_selection')
        self.setUp(); self.receipt['selectedArchives'] = entries(S.FINAL_PROFILE) + [entries(S.FINAL_PROFILE)[0]]; self.refused('plan', 'manifest_selection')
        self.setUp(); self.receipt['selectedArchives'] = entries(S.FINAL_PROFILE)[:-1]; self.refused('plan', 'manifest_selection')
        self.setUp(); self.receipt['selectedArchives'] = entries(S.FINAL_PROFILE) + [{'component': 'transaction_senders', 'chunk': 106}]; self.refused('plan', 'manifest_selection')
        for argv_bad in (lambda a: a + ['--with-senders'], lambda a: a + ['--prune-unlisted'], lambda a: [x if x != '48000000' else '47000000' for x in a],
                         lambda a: [x if not x.endswith('manifest.json') else '/tmp/other.json' for x in a], lambda a: a + ['--unknown-flag', '1'],
                         lambda a: a + ['--datadir', a[a.index('--datadir') + 1]], lambda a: a + ['--chain', 'base'], lambda a: a + ['-y'],
                         lambda a: a[:-1], lambda a: a[:3] + ['--chain'], lambda a: a[:2], lambda a: ['/usr/local/bin/base'] + a[1:],
                         lambda a: [x if x != '16' else '64' for x in a], lambda a: a + ['extra']):
            self.setUp(); self.receipt['downloadArgv'] = argv_bad(self.receipt['downloadArgv']); self.refused('plan', 'manifest_selection')

    def test_exact_argv_accepts_the_observed_real_first_pass_invocation(self):
        real = ('/opt/enclave-rpc/bin/base snapshot download --chain base --with-txs-distance 140000 --with-receipts-distance 140000 '
                '--with-state-history-distance 140000 --manifest-path /opt/enclave-rpc/snapshots/base-1792886410-manifest.json '
                '--datadir /srv/enclave-base-holder/data --download-concurrency 16 --resumable=true -y').split()
        mp, dd = '/opt/enclave-rpc/snapshots/base-1792886410-manifest.json', '/srv/enclave-base-holder/data'
        S.check_argv(real, 'first-pass-distance-140000', dd, mp)
        with self.assertRaises(S.SelectionError):
            S.check_argv(real, S.FINAL_PROFILE, dd, mp)
        for bad in (None, [], 'x', [1, 2, 3], real + [None], real[:4]):
            with self.assertRaises(S.SelectionError):
                S.check_argv(bad, 'first-pass-distance-140000', dd, mp)

    def test_units_and_openers_are_checked_before_any_db_access(self):
        for u in A.REQUIRED_UNITS:
            self.setUp(); os.environ['FAKE_ACTIVE_UNIT'] = u; self.refused('plan', 'service_running')
            self.assertFalse((self.d / 'argv.log').exists() and any(m[1:2] == ['db'] for m in self.argv()), f'{u}: no DB opened')
        self.setUp(); self.cfg['serviceUnits'] = ['bad unit']; self.write()
        with self.assertRaises(A.Refused): A.load_config(str(self.d / 'cfg.json'))
        self.setUp(); (self.d / 'datadir/held').write_text('x')
        holder = subprocess.Popen(['sleep', '30'], stdin=open(self.d / 'datadir/held'))
        try:
            self.refused('plan', 'datadir_open')
        finally:
            holder.kill(); holder.wait()
        self.setUp(); self.state['v2'] = False; self.refused('a2', 'v1_layout')       # enforced at the generic static gate
        self.assertEqual([m[1:2] + m[-2:] for m in self.argv() if m[1:2] == ['db']], [['db', 'settings', 'get']], 'v1: no header read')

    def db_reads(self): return [m for m in self.argv() if m[1:2] in (['db'], ['stage'])] if (self.d / 'argv.log').exists() else []

    def test_every_db_step_gates_before_any_db_access_even_without_plan(self):
        bad = {'binary_pin': lambda: self.cfg.update(baseBinarySha256='0' * 64), 'no_receipt': lambda: setattr(self, 'receipt', None),
               'first_pass_only': lambda: self.receipt.update(profile='first-pass-distance-140000', selectedArchives=entries('first-pass-distance-140000'),
                                                              downloadArgv=argv_for('first-pass-distance-140000', str(self.d / 'datadir'), str(self.d / 'manifest.json'))),
               'marker': lambda: (self.d / 'snapshot-complete').write_text('partial'), 'service_running': lambda: os.environ.update(FAKE_UNIT_STATE='active'),
               'prune_config': lambda: (self.d / 'reth.toml').write_text('[prune.segments]\naccount_history = { distance = 140000 }\n'),
               'download_unit': lambda: os.environ.update(FAKE_RESULT='exit-code')}
        for step in ('a2', 'a3', 'a4', 'bytecodes', 'release'):
            for code, breakit in bad.items():
                self.setUp()
                if step != 'a2':                             # give the step its prerequisite records WITHOUT a plan run
                    w = self.d / 'work'; w.mkdir(mode=0o700); A.save(w, 'a2-authenticated.json', {'anchor': {'blockHash': FX['blockHash'], 'stateRoot': FX['header']['stateRoot']}})
                    A.save(w, 'a3-unwound.json', {}); A.save(w, 'a4-rebuilt.json', {'blockHash': FX['blockHash']})
                    self.checker({'format': 'base-bytecode-check/v1', 'ok': True, 'rows': 1, 'failures': 0, 'missingCode': 0})
                breakit(); self.refused(step, code)
                self.assertEqual(self.db_reads(), [], f'{step}/{code}: no DB/stage command reached the binary')
            self.setUp(); self.state['v2'] = False
            if step != 'a2':
                w = self.d / 'work'; w.mkdir(mode=0o700); A.save(w, 'a2-authenticated.json', {'anchor': {'blockHash': FX['blockHash'], 'stateRoot': FX['header']['stateRoot']}})
                A.save(w, 'a3-unwound.json', {}); A.save(w, 'a4-rebuilt.json', {'blockHash': FX['blockHash']})
                self.checker({'format': 'base-bytecode-check/v1', 'ok': True, 'rows': 1, 'failures': 0, 'missingCode': 0})
            self.refused(step, 'v1_layout')
            self.assertEqual([m[-2:] for m in self.db_reads()], [['settings', 'get']], f'{step}/v1: only the layout probe touched the DB')
        self.setUp(); b = A.Base(A.load_config(str(self.d / 'cfg.json')), [], self.d / 'work')
        with self.assertRaises(A.Refused) as e: b.db('stage-checkpoints', 'get')
        self.assertTrue(str(e.exception).startswith('ungated_db_access'), e.exception)
        self.assertFalse((self.d / 'argv.log').exists(), 'the runner itself refuses a DB call no gate_static passed')

    def test_post_exit_size_orphans_and_mutation_stdout(self):
        lim = dict(A.LIMITS); A.LIMITS['read'] = (30, 1 << 20)
        try:
            os.environ['FAKE_BIG'] = 'settings get'; self.refused('plan', 'bounded')         # oversize after a quick exit
            self.setUp(); os.environ['FAKE_ORPHAN'] = 'settings get'; self.refused('plan', 'bounded')
            orphan = int((self.d / 'argv.log.orphan').read_text())
            time.sleep(0.3)
            with self.assertRaises(ProcessLookupError): os.kill(orphan, 0)
        finally:
            A.LIMITS.clear(); A.LIMITS.update(lim)
        self.setUp(); self.write(); b = A.Base(A.load_config(str(self.d / 'cfg.json')), [], self.d / 'work')
        (self.d / 'work').mkdir(mode=0o700, exist_ok=True)
        b.db_allowed = True                           # runner-only check of mutation stdout handling (gating is tested separately)
        r = b.run('stage', 'unwind', '--datadir', self.cfg['datadir'], '--config', self.cfg['rethConfig'], 'to-block', str(53_048_526), cls='unwind')
        self.assertEqual(r.stdout, '', 'mutation stdout stays on disk')

    def test_commands_are_bounded_and_only_our_process_group_is_stopped(self):
        lim = dict(A.LIMITS); A.LIMITS['read'] = (1, 1 << 20)
        try:
            os.environ['FAKE_SLEEP'] = 'settings get'; rec = self.refused('plan', 'bounded')
            pid = int((self.d / 'argv.log.pid').read_text())
            with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
            self.setUp(); os.environ['FAKE_SPAM'] = 'settings get'; A.LIMITS['read'] = (30, 1 << 20); self.refused('plan', 'bounded')
        finally:
            A.LIMITS.clear(); A.LIMITS.update(lim)

    def test_an_interrupted_mutation_blocks_every_later_step(self):
        self.run_step('a2'); old = A.Base.limits; A.Base.limits = lambda self, cls: (1, 1 << 20) if cls == 'unwind' else old(self, cls)
        try:
            os.environ['FAKE_SLEEP'] = 'stage unwind'; self.refused('a3', 'bounded')
            j = A.journal(self.d / 'work'); self.assertEqual([r['state'] for r in j], ['started', 'interrupted'])
            self.assertEqual(j[0]['argv'][2:4], ['stage', 'unwind'], 'the journal records the REAL mutation argv')
            self.assertEqual(j[1]['seq'], j[0]['seq']); self.assertTrue(j[1]['why'])
            self.assertEqual([m[1:3] for m in self.argv() if m[1:3] == ['stage', 'unwind']], [['stage', 'unwind']], 'the bound fired IN the unwind')
            self.assertEqual(self.st()['cp']['execution'], 53_048_526, 'the fake was killed before it could apply the unwind')
            os.environ.pop('FAKE_SLEEP'); self.refused('a3', 'interrupted_mutation'); self.refused('plan', 'interrupted_mutation')
        finally:
            A.Base.limits = old

    def test_an_advanced_anchor_refuses_release_with_the_documented_code(self):
        self.a1['N'] = str(N + 3600); self.refused('plan', 'a1_anchor_advanced')

    def test_bad_config(self):
        self.cfg['N'] = 52_400_000; self.write()
        with self.assertRaises(A.Refused): A.load_config(str(self.d / 'cfg.json'))


class Steps(Case):
    def test_a2_authenticates_the_real_header_and_refuses_forgery_or_missing(self):
        rc, rec = self.run_step('a2'); self.assertEqual(rc, 0, rec); self.assertEqual(rec['result']['blockHash'], FX['blockHash'])
        self.setUp(); self.state['headers'][str(N)] = dict(FX['header'], stateRoot='0x' + '11' * 32); self.refused('a2', 'a2_mismatch')
        self.setUp(); self.state['headers'] = {}; self.refused('a2', 'empty_read')
        self.setUp(); h = dict(FX['header']); h.pop('requestsHash'); self.state['headers'][str(N)] = h; self.refused('a2', 'header_format')

    def test_a3_requires_review_unwinds_in_chunks_to_exactly_n_and_lowers_labels(self):
        self.run_step('a2'); self.cfg['inPlaceReviewed'] = False; self.refused('a3', 'not_reviewed')
        self.cfg['inPlaceReviewed'] = True; rc, rec = self.run_step('a3'); self.assertEqual(rc, 0, rec)
        unwinds = [int(m[-1]) for m in self.argv() if m[1:3] == ['stage', 'unwind']]
        self.assertEqual(unwinds[-1], N); self.assertEqual(self.st()['cp']['execution'], N)
        self.assertLessEqual(max(self.st()['labels'].values()), N)

    def test_a3_refuses_a_short_unwind_and_surviving_headers(self):
        self.run_step('a2'); self.state['unwindStopsAt'] = N + 10; self.refused('a3', 'unwind_short')
        self.setUp(); self.run_step('a2'); self.state['keepHeadersAbove'] = True; self.state['headers'][str(N + 1)] = FX['header']
        self.state['headersTip'] = 53_048_526; self.refused('a3', 'headers_above_n')

    def test_a4_full_rebuild_matches_and_a_mismatch_refuses(self):
        self.run_step('a2'); self.run_step('a3'); rc, rec = self.run_step('a4'); self.assertEqual(rc, 0, rec)
        runs = [m for m in self.argv() if m[1:3] == ['stage', 'run']]
        self.assertTrue(runs and all(m[m.index('--from') + 1] == '0' and '--checkpoints' in m for m in runs), 'full range, checkpoints saved')
        self.assertFalse(self.st().get('canonicalStateDestroyed'), 'no hashing/execution drop on v2')
        self.setUp(); self.run_step('a2'); self.run_step('a3'); self.state = self.st(); self.state['rebuiltRoot'] = '0x' + '22' * 32
        self.refused('a4', 'reth_failed'); self.refused('release', 'interrupted_mutation')   # a failed mutation blocks everything after
        self.setUp(); self.run_step('a2'); self.run_step('a3'); self.assertEqual(self.state['cp']['execution'], N)
        self.state['cp'].update(execution=53_048_526, finish=53_048_526); self.refused('a4', 'not_unwound')   # DB moved after A3
        self.assertFalse([m for m in self.argv() if m[1:3] in (['stage', 'drop'], ['stage', 'run'])], 'no drop/rebuild on a DB that is not at N')

    def test_bytecode_step_binds_this_db_and_release_still_refuses_while_the_gap_is_open(self):
        for st in ('a2', 'a3', 'a4'): rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        self.state = self.st()                        # keep the RUNTIME post-unwind/post-rebuild DB, never the setUp fixture
        self.assertEqual((self.state['cp']['execution'], self.state['cp']['merkle-execute']), (N, N))
        self.refused('release', 'bytecode_receipt'); self.refused('bytecodes', 'no_checker')
        good = {'format': 'base-bytecode-check/v1', 'rows': 10, 'tag0': 0, 'tag2': 9, 'tag4': 1, 'nonCanonicalPadding': 0, 'failures': 0,
                'missingCode': 0, 'accountsWithCode': 12, 'ok': True}
        self.checker(dict(good, failures=1, ok=False)); rec = self.refused('bytecodes', 'bytecodes_failed'); self.assertIn('failures=1 ', rec['refused'])
        self.checker(dict(good, missingCode=2, ok=False)); rec = self.refused('bytecodes', 'bytecodes_failed'); self.assertIn('missingCode=2', rec['refused'])
        self.checker(dict(good, failures=1)); rec = self.refused('bytecodes', 'bytecodes_failed'); self.assertIn('failures=1 ', rec['refused'])   # ok=true is not trusted alone
        self.assertFalse((self.d / 'work/bytecodes-verified.json').exists(), 'a failed check binds nothing')
        self.refused('release', 'bytecode_receipt')
        self.checker(good); rc, rec = self.run_step('bytecodes'); self.assertEqual(rc, 0, rec)
        self.assertEqual(rec['result']['rows'], 10)
        self.refused('release', 'open_gaps'); self.assertFalse((self.d / 'work/m10-launch.json').exists())   # prepared code is not a gate
        self.state['cp']['finish'] = N + 5; self.refused('release', 'bytecode_receipt_stale')          # other checkpoints -> another DB state
        self.state['cp']['finish'] = N; self.refused('release', 'open_gaps')
        (self.d / 'datadir/db/mdbx.dat').write_bytes(b'changed'); self.refused('release', 'bytecode_receipt_stale')

    def test_release_stays_blocked_on_the_open_bytecode_gap_and_needs_fresh_a1(self):
        self.run_step('a2'); self.run_step('a3'); self.run_step('a4')
        self.refused('release', 'bytecode_receipt'); self.assertFalse((self.d / 'work/m10-launch.json').exists())
        self.a1['at'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=900)).isoformat(); self.refused('release', 'a1_stale')

    def test_steps_refuse_out_of_order(self):
        self.refused('a3', 'order'); self.refused('a4', 'order')


if __name__ == '__main__':
    unittest.main(verbosity=2)
