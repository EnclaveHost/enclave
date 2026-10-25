"""Mocked-fixture tests of a2a4.py (queue 256; no reth, no datadir, no network). The fake `base` implements the audited
command surface (test/fake_base.py); header hashing and the output-root check use the REAL published anchor module.
a1-a2-integration copy: the A1 fixture is the REAL live initial receipt (live-1958, sha b9a90847...) with only its output root
(-> the synthetic header-N fixture), `at` and L1 timestamp moved; recheck receipts mirror runRecheck's output (cross-checked
against the REAL runRecheck producer in test/a1-gate.test.mjs)."""
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
LIVE_BYTES = (H / 'test/fixtures/initial-a1-evidence-1958.json').read_bytes()
REAL_ROOT = '0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700'
GAME = '0x343b3a99527af07d2cfb2652747b9e37715e21ac'
RECHECK_LABEL = ('A1 original-game recheck: Helios-light-client-relative; pins compared to initial OBSERVATIONS (not approved versions); '
                 'not SNP/attested')
RECHECK_READS = ('portalAsr', 'paused', 'respectedGameType', 'isGameFinalized', 'isGameRespected', 'isGameBlacklisted', 'isGameRetired', 'gameStatus',
                 'gameRootClaim', 'gameL2SequenceNumber', 'gameType', 'gameAnchorStateRegistry', 'latestAnchorRoot', 'latestAnchorGame')
UTC = datetime.timezone.utc
REAL_INITIAL_SHA = A.A1_INITIAL_SHA256             # the production pin (setUp restores it after tests override it)
utcnow = lambda: datetime.datetime.now(UTC)
iso = lambda t: t.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'          # Date.prototype.toISOString shape
sha = lambda b: __import__('hashlib').sha256(b).hexdigest()


def fresh_a1(at=None, root=None):
    """The live initial receipt as if A1 had just run: same reads/pins/candidates; at=now, finalized header 1000 s before."""
    at = at or utcnow(); e = json.loads(LIVE_BYTES)
    e.update(outputRoot=root or FX['outputRoot'], at=iso(at)); e['l1'] = dict(e['l1'], timestamp=int(at.timestamp()) - 1000, ageSec=952)
    return e


def make_recheck(ini, ini_sha, at=None, advanced=True):
    """runRecheck's output shape (+ the CLI's `at`) for initial receipt `ini`, at a finalized block 1000 blocks newer."""
    at = at or utcnow(); addrs = list(ini['pins'])
    la = {'game': '0x' + '99' * 20, 'N': str(int(ini['N']) + 9000), 'outputRoot': '0x' + 'bb' * 32, 'advanced': True} if advanced else \
         {'game': ini['game'], 'N': ini['N'], 'outputRoot': ini['outputRoot'], 'advanced': False}
    return {'verdict': 'A1-original-game-recheck-passed',
            'recheckOf': {'sha256': ini_sha, 'verdict': 'A1-authenticated', 'game': ini['game'], 'N': ini['N'], 'outputRoot': ini['outputRoot'],
                          'asr': ini['asr'], 'l1': {'number': ini['l1']['number'], 'hash': ini['l1']['hash']}},
            'game': ini['game'], 'N': ini['N'], 'outputRoot': ini['outputRoot'], 'asr': ini['asr'], 'respectedGameType': ini['respectedGameType'],
            'l1': {'number': ini['l1']['number'] + 1000, 'hash': '0x' + '5a' * 32, 'stateRoot': '0x' + '5b' * 32, 'timestamp': int(at.timestamp()) - 1000, 'ageSec': 952},
            'latestAnchorObservation': {**la, 'accepted': False, 'note': 'observation only: the bootstrap stays bound to the original game/N; descendants are never accepted here'},
            'pins': {a: {'codeHash': ini['pins'][a]['codeHash'], 'slots': dict(ini['pins'][a]['slots']), 'comparison': 'unchanged-from-initial-observation'} for a in addrs},
            'reads': {**{k: 'helios-call' for k in RECHECK_READS}, **{f'account:{a}': 'mpt-proof' for a in addrs}},
            'label': RECHECK_LABEL, 'at': iso(at)}


def run_record(at, ini_sha):
    return {'startedAt': (at - datetime.timedelta(seconds=40)).isoformat(), 'productionActivated': False, 'inputPins': dict(A.RECHECK_INPUT_PINS),
            'initialSha256': ini_sha, 'heliosStatus': {'status': 'fresh-finalized'}, 'recheckExit': 0, 'processStopped': True,
            'finishedAt': (at + datetime.timedelta(seconds=5)).isoformat()}


V1_GOOD = {'format': 'base-bytecode-check/v1', 'rows': 10, 'tag0': 0, 'tag2': 9, 'tag4': 1, 'nonCanonicalPadding': 0, 'failures': 0,
           'paddingShortDupn': 0, 'firstFailures': {}, 'accountsWithCode': 12, 'missingCode': 0, 'readError': None, 'ok': True}
V2_GOOD = dict(V1_GOOD, format='base-bytecode-check/v2', bytecodesEntries=10, hashedAccountsEntries=40, accountsScanned=40, rowsDigest='ab' * 32,
               codeHashesDigest='cd' * 32, mdbxTxnId=7, checkpoints={k: N for k in ('headers', 'bodies', 'execution', 'merkle-execute', 'finish')})


PRUNE_OK = '[prune.segments]\naccount_history = { before = 52500000 }\nstorage_history = { before = 52500000 }\n'


class Case(unittest.TestCase):
    def setUp(self):
        self.__dict__.pop('write', None)              # a test's instance-level write() override never survives into a re-setUp
        self.receipt = None; self.rk = None; self.keep_rk_sha = False; A.A1_INITIAL_SHA256 = REAL_INITIAL_SHA
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
        self.a1 = fresh_a1()
        self.cfg = {'datadir': str(d / 'datadir'), 'baseBinary': str(fake), 'baseBinarySha256': A.sha256(fake), 'rethConfig': str(d / 'reth.toml'),
                    'workdir': str(d / 'work'), 'a1Evidence': str(d / 'a1.json'), 'a1MaxAgeSec': 600, 'N': N, 'outputRoot': FX['outputRoot'],
                    'game': '0x343b3a99527af07d2cfb2652747b9e37715e21ac', 'downloadReceipt': str(d / 'receipt.json'), 'manifestPath': str(d / 'manifest.json'),
                    'snapshotMarker': str(d / 'snapshot-complete'), 'timeouts': {'unwindChunkSec': 600, 'merkleSec': 3600, 'bytecodeSec': 600}, 'inPlaceReviewed': True,
                    'unwindChunk': 50_000, 'anchorModule': str(ANCHOR), 'depsRoot': str(DEPS), 'node': shutil.which('node'), 'a1GateDir': str(H / 'a1gate')}
        self.write()

    def tearDown(self): self.t.cleanup()

    def write(self):
        (self.d / 'state.json').write_text(json.dumps(self.state)); (self.d / 'a1.json').write_text(json.dumps(self.a1))
        if self.rk is not None:                       # original-game-recheck mode: initial bytes + recheck.json + run-result.json
            (self.d / 'rk').mkdir(exist_ok=True); (self.d / 'initial.json').write_bytes(self.initial)
            b = json.dumps(self.rk).encode(); (self.d / 'rk/recheck.json').write_bytes(b); (self.d / 'rk/run-result.json').write_text(json.dumps(self.run))
            if not self.keep_rk_sha: self.cfg['a1RecheckSha256'] = sha(b)
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
        self.a1['at'] = iso(utcnow() - datetime.timedelta(seconds=601)); self.refused('plan', 'a1_stale')
        self.setUp(); f = '0xdb9091e48b1c42992a1213e6916184f9ebdbfedf'       # even a receipt that RECORDS the foreign ASR as authenticated
        self.a1.update(asr=f, asrCandidates=[{'address': f, 'authenticatedMatch': True}]); self.a1['pins'][f] = self.a1['pins'][A.MAINNET['asr']]
        self.a1['reads'][f'account:{f}'] = 'mpt-proof'; self.refused('plan', 'a1_pins')
        self.setUp(); self.a1['N'] = str(N + 1); rec = self.refused('plan', 'a1_anchor_advanced')   # N+1 is the specific 'advanced' refusal
        self.assertIn(self.a1['game'], rec['refused'], 'the message names the game (f-string, not a literal placeholder)')
        self.setUp(); self.a1['N'] = str(N - 1); self.refused('plan', 'a1_anchor')            # a wrong LOWER N is foreign, not advanced
        self.setUp(); self.a1['outputRoot'] = '0x' + '33' * 32; self.refused('plan', 'a1_anchor')
        self.setUp(); self.cfg['game'] = '0x' + '44' * 20; self.refused('plan', 'a1_anchor')       # receipt game != planned game
        self.setUp(); self.a1['reads']['isGameBlacklisted'] = 'rpc'; rec = self.refused('plan', 'a1_receipt'); self.assertIn('bad_initial', rec['refused'])
        self.setUp(); del self.a1['reads']['isGameRespected']; rec = self.refused('plan', 'a1_receipt'); self.assertIn('unproven_read', rec['refused'])

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
        self.setUp(); self.write(); os.chmod(self.d / 'receipt.json', 0o664); rec = self.refused('plan', 'untrusted_file'); self.assertIn('receipt', rec['refused'])
        self.setUp(); self.write(); os.chmod(self.d / 'manifest.json', 0o666); rec = self.refused('plan', 'untrusted_file'); self.assertIn('manifest', rec['refused'])

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
        good = dict(V1_GOOD)                          # the REAL v1 schema of base-bytecode-check main.rs/lib.rs Report::json()
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
        self.a1['at'] = iso(utcnow() - datetime.timedelta(seconds=900)); self.refused('release', 'a1_stale')

    def test_steps_refuse_out_of_order(self):
        self.refused('a3', 'order'); self.refused('a4', 'order')


class FreshInitialTrust(Case):
    """a1Mode fresh-initial (the frozen path), tightened: the receipt is a root-owned file read once, through the reviewed
    loadInitialReceipt, never a recheck, with consistent L1 timing."""
    def test_the_real_live_initial_receipt_passes_only_while_fresh(self):
        self.a1 = json.loads(LIVE_BYTES); self.cfg['outputRoot'] = REAL_ROOT
        self.write(); (self.d / 'a1.json').write_bytes(LIVE_BYTES)                 # the EXACT live bytes
        orig = A.now
        try:
            A.now = lambda: datetime.datetime.fromisoformat('2026-10-25T19:59:00+00:00')
            self.write = lambda: (self.d / 'cfg.json').write_text(json.dumps(self.cfg))   # keep the exact bytes on disk
            rc, rec = self.run_step('plan'); self.assertEqual(rc, 0, rec)
            g = rec['result']['gates']['a1']; self.assertEqual((g['mode'], g['N'], g['initialSha256']), ('fresh-initial', str(N), REAL_INITIAL_SHA))
            A.now = lambda: datetime.datetime.fromisoformat('2026-10-25T20:30:00+00:00'); self.refused('plan', 'a1_stale')
        finally:
            A.now = orig

    def test_a1_file_trust(self):
        A.TRUSTED_UID = os.getuid() + 1              # a uid that does NOT own the files (under `unshare -r` the test uid IS 0)
        try:
            rec = self.refused('plan', 'untrusted_file'); self.assertIn('A1 evidence', rec['refused'])
        finally:
            A.TRUSTED_UID = os.getuid()
        self.setUp(); self.write(); os.chmod(self.d / 'a1.json', 0o620); self.refused('plan', 'untrusted_file')
        self.setUp(); self.write(); (self.d / 'real.json').write_text(json.dumps(self.a1)); self.cfg['a1Evidence'] = str(self.d / 'link.json')
        (self.d / 'link.json').symlink_to(self.d / 'real.json'); self.refused('plan', 'untrusted_file')
        self.setUp(); self.cfg['a1Evidence'] = str(self.d / 'none.json'); self.refused('plan', 'no_evidence')
        self.setUp(); self.a1['pad'] = 'x' * (1 << 20); self.refused('plan', 'untrusted_file')

    def test_a_recheck_or_rebound_receipt_is_never_initial_evidence(self):
        rk = make_recheck(self.a1, sha(json.dumps(self.a1).encode()))
        self.a1 = rk; rec = self.refused('plan', 'a1_receipt'); self.assertIn('not_initial_a1', rec['refused'])
        self.setUp(); self.a1['recheckOf'] = {'sha256': REAL_INITIAL_SHA}; rec = self.refused('plan', 'a1_receipt'); self.assertIn('not_initial_a1', rec['refused'])
        self.setUp(); self.a1['asrCandidates'] = [dict(c, authenticatedMatch=False) for c in self.a1['asrCandidates']]
        rec = self.refused('plan', 'a1_receipt'); self.assertIn('bad_initial', rec['refused'])

    def test_l1_timing_is_bounded_and_consistent(self):
        self.a1['l1']['ageSec'] = 1801; self.a1['l1']['timestamp'] = int(utcnow().timestamp()) - 1850; self.refused('plan', 'a1_l1_stale')
        self.setUp(); self.a1['l1']['timestamp'] -= 5000; self.refused('plan', 'a1_l1_stale')        # recorded age 952 s, header far older
        self.setUp(); self.a1['l1']['timestamp'] += 900; self.refused('plan', 'a1_l1_stale')         # header "newer" than its recorded age
        self.setUp(); self.a1['at'] = iso(utcnow() + datetime.timedelta(seconds=30)); self.refused('plan', 'a1_stale')   # future receipt

    def test_config_keys(self):
        for bad in ({'a1Mode': 'latest'}, {'a1GateDir': 'a1gate'}, {'a1RecheckSha256': '0' * 64}, {'a1Mode': 'original-game-recheck'},
                    {'a1Mode': 'original-game-recheck', 'a1InitialEvidence': '/x', 'a1RunResult': '/y', 'a1InitialSha256': 'A' * 64, 'a1RecheckSha256': '0' * 64}):
            self.setUp(); self.cfg.update(bad); self.write()
            with self.assertRaises(A.Refused) as e: A.load_config(str(self.d / 'cfg.json'))
            self.assertTrue(str(e.exception).startswith('bad_config'), (bad, e.exception))

    def test_gate_and_recheck_pins_match_the_files(self):
        for name, want in A.A1_GATE_PINS.items():
            self.assertEqual(A.sha256(H / 'a1gate' / name), want, name)
        self.assertEqual(sha(LIVE_BYTES), A.A1_INITIAL_SHA256)
        src = P / 'finality-stage/a1-original-game'
        if src.exists():                               # the frozen producer: what run-recheck.py records as inputPins
            for name, want in A.RECHECK_INPUT_PINS.items():
                self.assertEqual(A.sha256(src / name), want, name)
            self.assertEqual(A.RECHECK_INPUT_PINS['a1-recheck.mjs'], A.A1_GATE_PINS['a1-recheck.mjs'])
            self.assertEqual(A.RECHECK_INPUT_PINS['a1-anchor.mjs'], A.A1_GATE_PINS['a1-anchor.mjs'])
        d = self.d / 'gate'; shutil.copytree(H / 'a1gate', d); (d / 'a1-recheck.mjs').write_bytes((d / 'a1-recheck.mjs').read_bytes() + b'\n')
        self.cfg['a1GateDir'] = str(d); self.refused('plan', 'a1_gate_pin')


class Recheck(Case):
    """a1Mode original-game-recheck: the pinned INITIAL receipt + a root-reviewed recheck of it + its run record."""
    def use_recheck(self, initial=None, advanced=True):
        ini = fresh_a1(utcnow() - datetime.timedelta(hours=6)) if initial is None else initial
        self.initial = json.dumps(ini).encode() if isinstance(ini, dict) else ini
        ini = json.loads(self.initial); A.A1_INITIAL_SHA256 = sha(self.initial); at = utcnow()
        self.ini, self.rk, self.run = ini, make_recheck(ini, A.A1_INITIAL_SHA256, at, advanced), run_record(at, A.A1_INITIAL_SHA256)
        self.cfg.update(a1Mode='original-game-recheck', a1Evidence=str(self.d / 'rk/recheck.json'), a1RunResult=str(self.d / 'rk/run-result.json'),
                        a1InitialEvidence=str(self.d / 'initial.json'), a1InitialSha256=A.A1_INITIAL_SHA256)

    def test_the_original_game_passes_after_the_latest_anchor_advanced_and_n_never_moves(self):
        self.a1['N'] = str(N + 9000); self.refused('plan', 'a1_anchor_advanced')       # frozen behaviour (fresh-initial) kept
        self.setUp(); self.use_recheck(); rc, rec = self.run_step('plan'); self.assertEqual(rc, 0, rec)
        g = rec['result']['gates']['a1']
        self.assertEqual((g['mode'], g['N'], g['outputRoot'], g['game'], g['initialSha256']), ('original-game-recheck', str(N), FX['outputRoot'], GAME, A.A1_INITIAL_SHA256))
        self.assertEqual(g['latestAnchorObservation'], {'game': '0x' + '99' * 20, 'N': str(N + 9000), 'outputRoot': '0x' + 'bb' * 32, 'advanced': True, 'accepted': False})
        self.assertEqual(g['l1Finalized'], self.ini['l1']['number'] + 1000)
        self.setUp(); self.use_recheck(advanced=False); rc, rec = self.run_step('plan'); self.assertEqual(rc, 0, rec)
        self.assertEqual(list((self.d / 'work').glob('a1gate-*')), [], 'the private module copy is removed after use')

    def test_production_pins_with_the_real_live_initial_receipt(self):
        self.use_recheck(initial=LIVE_BYTES); self.cfg['outputRoot'] = REAL_ROOT
        self.assertEqual(A.A1_INITIAL_SHA256, REAL_INITIAL_SHA)
        rc, rec = self.run_step('plan'); self.assertEqual(rc, 0, rec); self.assertEqual(rec['result']['gates']['a1']['N'], '52866960')

    def test_full_flow_binds_release_to_the_a2_receipt(self):
        self.use_recheck()
        for st in ('a2', 'a3', 'a4'): rc, rec = self.run_step(st); self.assertEqual(rc, 0, (st, rec))
        a2 = json.loads((self.d / 'work/a2-authenticated.json').read_text())['a1Gate']
        self.assertEqual((a2['mode'], a2['initialSha256'], a2['N']), ('original-game-recheck', A.A1_INITIAL_SHA256, str(N)))
        self.refused('release', 'bytecode_receipt')                                 # the A1 gate and binding passed
        self.rk['l1'].update(number=a2['l1Finalized'] - 1); self.refused('release', 'a1_binding')   # older than A2's block
        at = utcnow(); other = fresh_a1(at)                                           # a DIFFERENT (fresh) initial receipt, same N/root/game
        self.rk = None; self.a1 = other
        for k in A.A1_RECHECK_KEYS: self.cfg.pop(k)
        self.cfg.update(a1Mode='fresh-initial', a1Evidence=str(self.d / 'a1.json')); rec = self.refused('release', 'a1_binding')
        self.assertIn('initialSha256', rec['refused'])

    def rk_refused(self, mutate, sub, code='a1_receipt'):
        self.setUp(); self.use_recheck(); mutate(self); rec = self.refused('plan', code); self.assertIn(sub, rec['refused']); return rec

    def test_recheck_receipt_binding_and_content(self):
        nx = '0x' + '99' * 20
        cases = [
            (lambda t: t.rk['recheckOf'].update(sha256='0' * 64), 'recheck_binding'),
            (lambda t: (t.rk.update(N=str(N + 9000)), t.rk['recheckOf'].update(N=str(N + 9000))), 'recheck_binding'),   # latest N as N
            (lambda t: t.rk.update(N=str(N + 9000)), 'recheck_binding'),
            (lambda t: t.rk.update(game=nx), 'recheck_binding'),                                                      # a descendant game
            (lambda t: t.rk.update(outputRoot='0x' + 'bb' * 32), 'recheck_binding'),
            (lambda t: t.rk.update(asr='0x' + '12' * 20), 'recheck_binding'),
            (lambda t: t.rk.update(respectedGameType=622), 'recheck_binding'),
            (lambda t: t.rk['recheckOf']['l1'].update(number=1), 'recheck_binding'),
            (lambda t: t.rk['recheckOf'].update(verdict='A1-original-game-recheck-passed'), 'recheck_binding'),
            (lambda t: t.rk['recheckOf'].update(extra=1), 'recheck_binding'),
            (lambda t: t.rk.update(verdict='A1-authenticated'), 'not_recheck'),
            (lambda t: setattr(t, 'rk', {'verdict': 'refused', 'code': 'game_blacklisted', 'message': 'x'}), 'not_recheck'),   # a CLI refusal
            (lambda t: setattr(t, 'rk', json.loads(t.initial)), 'not_recheck'),                                     # the initial as recheck
            (lambda t: t.rk.update(accepted=True), 'bad_recheck'),
            (lambda t: t.rk.update(label='A1 read: Helios-light-client-relative; not SNP/attested'), 'bad_recheck'),
            (lambda t: t.rk.pop('at'), 'bad_recheck'),
            (lambda t: t.rk['latestAnchorObservation'].update(accepted=True), 'recheck_latest'),
            (lambda t: t.rk['latestAnchorObservation'].update(accepted='false'), 'recheck_latest'),
            (lambda t: t.rk['latestAnchorObservation'].update(N=str(N - 1)), 'recheck_latest'),
            (lambda t: t.rk['latestAnchorObservation'].update(game=GAME, advanced=False, N=str(N), outputRoot='0x' + 'cd' * 32), 'recheck_latest'),
            (lambda t: t.rk['latestAnchorObservation'].update(advanced=False), 'recheck_latest'),
            (lambda t: t.rk['l1'].update(number=t.ini['l1']['number']), 'not_fresh'),
            (lambda t: t.rk['l1'].update(hash=t.ini['l1']['hash']), 'not_fresh'),
            (lambda t: t.rk['l1'].update(ageSec=1801, timestamp=t.rk['l1']['timestamp'] - 849), 'finalized_stale'),
            (lambda t: t.rk['l1'].update(number=str(t.rk['l1']['number'])), 'bad_recheck'),
        ]
        A_ = A.MAINNET['asr']; impl = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
        cases += [
            (lambda t: t.rk['pins'][A_].update(codeHash='0x' + '00' * 32), 'recheck_pins'),
            (lambda t: t.rk['pins'][A_]['slots'].update({impl: '0x' + '00' * 31 + '01'}), 'recheck_pins'),
            (lambda t: t.rk['pins'][A_]['slots'].pop(impl), 'recheck_pins'),
            (lambda t: t.rk['pins'][A_]['slots'].update({'0x' + '00' * 32: '0x' + '00' * 32}), 'recheck_pins'),
            (lambda t: t.rk['pins'].pop(GAME), 'recheck_pins'),
            (lambda t: t.rk['pins'].update({nx: t.rk['pins'][GAME]}), 'recheck_pins'),
            (lambda t: t.rk['pins'][GAME].update(comparison='changed'), 'recheck_pins'),
            (lambda t: t.rk['reads'].pop('gameRootClaim'), 'unproven_read'),
            (lambda t: t.rk['reads'].update(extra='helios-call'), 'unproven_read'),
            (lambda t: t.rk['reads'].update(isGameBlacklisted='plain-rpc'), 'unproven_read'),
            (lambda t: t.rk['reads'].update(gameStatus='mpt-proof'), 'unproven_read'),
            (lambda t: t.rk['reads'].update({f'account:{GAME}': 'helios-call'}), 'unproven_read'),
        ]
        for mutate, sub in cases:
            with self.subTest(sub=sub):
                self.rk_refused(mutate, sub)

    def test_initial_receipt_pin_and_file_trust(self):
        self.rk_refused(lambda t: t.cfg.update(a1InitialSha256='1' * 64), 'pinned initial', 'a1_initial_pin')
        self.rk_refused(lambda t: setattr(A, 'A1_INITIAL_SHA256', '2' * 64), 'pinned initial', 'a1_initial_pin')
        self.rk_refused(lambda t: setattr(t, 'initial', t.initial.replace(b'"N": "52866960"', b'"N": "52866961"')), 'initial_sha')
        self.rk_refused(lambda t: setattr(t, 'keep_rk_sha', True) or t.cfg.update(a1RecheckSha256='3' * 64), 'root reviewed', 'a1_recheck_sha')
        for f in ('rk/recheck.json', 'initial.json', 'rk/run-result.json'):
            self.setUp(); self.use_recheck(); self.write(); os.chmod(self.d / f, 0o660); self.refused('plan', 'untrusted_file')
        self.setUp(); self.use_recheck(); self.write(); (self.d / 'initial.json').rename(self.d / 'initial-real.json')
        (self.d / 'initial.json').symlink_to(self.d / 'initial-real.json'); self.write = lambda: None; self.refused('plan', 'untrusted_file')
        self.setUp(); self.use_recheck(); A.TRUSTED_UID = os.getuid() + 1   # not the files' owner (see test_a1_file_trust)
        try:
            self.refused('plan', 'untrusted_file')
        finally:
            A.TRUSTED_UID = os.getuid()

    def test_run_record_provenance(self):
        for mutate in (lambda t: t.run['inputPins'].update({'a1-recheck.mjs': '0' * 64}), lambda t: t.run['inputPins'].pop('a1-read.mjs'),
                       lambda t: t.run.update(recheckExit=3), lambda t: t.run.update(recheckExit=False), lambda t: t.run.update(recheckExit='0'),
                       lambda t: t.run.update(processStopped=False), lambda t: t.run.update(productionActivated=True), lambda t: t.run.update(error='x'),
                       lambda t: t.run.update(initialSha256='4' * 64), lambda t: t.run.update(startedAt=t.run['finishedAt']),
                       lambda t: t.run.update(finishedAt=t.run['startedAt'])):
            with self.subTest():
                self.rk_refused(mutate, '', 'a1_provenance')
        self.setUp(); self.use_recheck(); self.write(); (self.d / 'other').mkdir(); shutil.copy(self.d / 'rk/run-result.json', self.d / 'other/run-result.json')
        self.cfg['a1RunResult'] = str(self.d / 'other/run-result.json'); self.refused('plan', 'a1_provenance')
        self.setUp(); self.use_recheck(); self.write(); shutil.copy(self.d / 'rk/recheck.json', self.d / 'rk/r2.json')
        self.cfg['a1Evidence'] = str(self.d / 'rk/r2.json'); self.keep_rk_sha = True; self.refused('plan', 'a1_provenance')

    def test_freshness_planned_anchor_and_mainnet_pins(self):
        def old(t):
            at = utcnow() - datetime.timedelta(seconds=700); t.rk = make_recheck(t.ini, A.A1_INITIAL_SHA256, at); t.run = run_record(at, A.A1_INITIAL_SHA256)
        self.rk_refused(old, 'old', 'a1_stale')
        self.rk_refused(lambda t: t.rk['l1'].update(timestamp=t.rk['l1']['timestamp'] - 5000), 'inconsistent', 'a1_l1_stale')
        self.rk_refused(lambda t: t.cfg.update(N=N + 1), 'differs from the planned', 'a1_anchor')   # never a1_anchor_advanced
        self.rk_refused(lambda t: t.cfg.update(game='0x' + '44' * 20), 'differs from the planned', 'a1_anchor')
        self.rk_refused(lambda t: t.cfg.update(outputRoot='0x' + '33' * 32), 'differs from the planned', 'a1_anchor')
        ini = fresh_a1(utcnow() - datetime.timedelta(hours=6)); ini['pins'][A.MAINNET['asr']]['codeHash'] = '0x' + '77' * 32
        self.setUp(); self.use_recheck(initial=ini); rec = self.refused('plan', 'a1_pins'); self.assertIn(A.MAINNET['asr'], rec['refused'])


class BytecodeGate(Case):
    """a2-bytecode-integration: the bytecode gap closes ONLY for a v2 receipt of the SOURCE-pinned checker bound to this DB."""
    def ready(self, receipt, rc=0):
        for st in ('a2', 'a3', 'a4'):
            r, rec = self.run_step(st); self.assertEqual(r, 0, (st, rec))
        self.state = self.st(); self.checker(dict(receipt, datadir=self.cfg['datadir']) if receipt.get('format', '').endswith('/v2') else receipt)
        if rc:
            p = pathlib.Path(self.cfg['bytecodeChecker']); p.write_text(p.read_text() + f'exit {rc}\n'); self.cfg['bytecodeCheckerSha256'] = A.sha256(p)

    def setUp(self):
        super().setUp(); A.BYTECODE_CHECKER_V2_SHA256 = None          # every (re-)setUp starts from today's source pin: None

    def tearDown(self):
        A.BYTECODE_CHECKER_V2_SHA256 = None; super().tearDown()

    def test_v2_receipt_of_the_source_pinned_checker_closes_the_gap_for_this_db(self):
        self.ready(V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        rc, rec = self.run_step('bytecodes'); self.assertEqual(rc, 0, rec); self.assertEqual(rec['result']['receiptVersion'], 'v2')
        rc, rec = self.run_step('release'); self.assertEqual(rc, 0, rec)
        m = json.loads((self.d / 'work/m10-launch.json').read_text()); self.assertEqual(m['bytecodes']['receiptVersion'], 'v2')
        bv = json.loads((self.d / 'work/bytecodes-verified.json').read_text()); self.assertEqual((bv['env'], bv['argv'][1]), ({}, self.cfg['datadir']))

    def test_the_gap_stays_open_without_a_v2_receipt_of_the_source_pinned_checker(self):
        self.ready(V1_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']     # even if v1 bytes were pinned
        self.assertEqual(self.run_step('bytecodes')[0], 0); self.refused('release', 'open_gaps')
        self.setUp(); self.ready(V2_GOOD); self.assertEqual(self.run_step('bytecodes')[0], 0)
        self.refused('release', 'open_gaps')                                                  # source pin None (today)
        A.BYTECODE_CHECKER_V2_SHA256 = '0' * 64; self.refused('release', 'open_gaps')          # config-pinned != source-pinned
        self.assertFalse((self.d / 'work/m10-launch.json').exists())

    def test_missing_malformed_empty_or_unscanned_results_refuse(self):
        cases = [(dict(V2_GOOD, missingCode=1), 'bytecodes_failed'), (dict(V2_GOOD, rows=0, tag2=0, tag4=0, bytecodesEntries=0), 'bytecodes_failed'),
                 (dict(V2_GOOD, ok=False), 'bytecodes_failed'), (dict(V2_GOOD, firstFailures={'00': 'E_HASH'}), 'bytecodes_failed'),
                 (dict(V2_GOOD, readError='Bytecodes: io'), 'bytecodes_failed'), (dict(V2_GOOD, paddingShortDupn=1), 'bytecodes_failed'),
                 (dict(V2_GOOD, tag2=8), 'checker_receipt'), (dict(V2_GOOD, rows=True, tag0=0, tag2=0, tag4=1, bytecodesEntries=1), 'checker_receipt'),
                 (dict(V2_GOOD, nonCanonicalPadding=10), 'checker_receipt'), (dict(V2_GOOD, accountsWithCode=0), 'checker_receipt'),
                 (dict(V2_GOOD, bytecodesEntries=11), 'checker_receipt'), (dict(V2_GOOD, accountsScanned=39), 'checker_receipt'),
                 (dict(V2_GOOD, accountsWithCode=41), 'checker_receipt'), (dict(V2_GOOD, rowsDigest=''), 'checker_receipt'),
                 (dict(V2_GOOD, mdbxTxnId=0), 'checker_receipt'), (dict(V2_GOOD, checkpoints=dict(V2_GOOD['checkpoints'], execution=N + 1)), 'checker_receipt'),
                 (dict(V2_GOOD, checkpoints={'execution': N}), 'checker_receipt'), (dict(V2_GOOD, extra=1), 'checker_receipt'),
                 ({k: v for k, v in V1_GOOD.items() if k != 'readError'}, 'checker_receipt'), (dict(V2_GOOD, format='base-bytecode-check/v3'), 'checker_receipt')]
        for receipt, code in cases:
            with self.subTest(code=code, receipt={k: receipt[k] for k in receipt if receipt.get(k) != V2_GOOD.get(k)}):
                self.setUp(); self.ready(receipt); self.refused('bytecodes', code)
                self.assertFalse((self.d / 'work/bytecodes-verified.json').exists(), 'a refused check binds nothing')
        self.setUp(); self.ready(V2_GOOD, rc=1); self.refused('bytecodes', 'bytecodes_failed')        # exit 1 with an "ok" JSON

    def test_another_datadir_in_the_receipt_refuses(self):
        for st in ('a2', 'a3', 'a4'): self.assertEqual(self.run_step(st)[0], 0)
        self.state = self.st(); self.checker(dict(V2_GOOD, datadir='/srv/other')); self.refused('bytecodes', 'checker_receipt')

    def test_wrong_binary_and_untrusted_binary_refuse_before_any_scan(self):
        self.ready(V2_GOOD); self.cfg['bytecodeCheckerSha256'] = '0' * 64; self.refused('bytecodes', 'checker_pin')
        self.setUp(); self.ready(V2_GOOD); os.chmod(self.cfg['bytecodeChecker'], 0o775); self.refused('bytecodes', 'untrusted_file')
        self.assertFalse(list((self.d / 'work/cmd').glob('bytecodes-*.json')), 'no checker ran')

    def test_step_order_and_a_db_mutated_after_a4_or_after_the_scan(self):
        self.refused('bytecodes', 'order')                                                     # no A4 result
        self.setUp(); self.ready(V2_GOOD)
        A.journal_append(self.d / 'work', {'seq': 99, 'state': 'started', 'argv': ['b', 'reth', 'stage', 'unwind', 'to-block', str(N)]})
        A.journal_append(self.d / 'work', {'seq': 99, 'state': 'finished', 'rc': 0, 'argv': ['b', 'reth', 'stage', 'unwind', 'to-block', str(N)]})
        self.refused('bytecodes', 'bytecode_order')                                            # a mutation after A4's rebuild
        self.setUp(); self.ready(V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
        self.assertEqual(self.run_step('bytecodes')[0], 0)
        A.journal_append(self.d / 'work', {'seq': 99, 'state': 'finished', 'rc': 0, 'argv': ['b', 'reth', 'stage', 'run', 'merkle']})
        self.refused('release', 'bytecode_receipt_stale')                                      # journal changed after the scan

    def test_stale_db_download_receipt_or_stored_receipt_refuse_release(self):
        def bound():
            self.setUp(); self.ready(V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']
            self.assertEqual(self.run_step('bytecodes')[0], 0)
        bound(); (self.d / 'datadir/db/mdbx.dat').write_bytes(b'changed'); self.refused('release', 'bytecode_receipt_stale')
        bound(); self.state['cp']['finish'] = N + 1; self.refused('release', 'bytecode_receipt_stale')
        bound(); self.receipt['note'] = 'rewritten'; self.refused('release', 'bytecode_receipt_stale')   # passes gate_download, other bytes
        bound(); f = next((self.d / 'work/cmd').glob('bytecodes-*.json')); f.write_text(json.dumps(dict(V2_GOOD, datadir=self.cfg['datadir'], rows=10)) + ' ')
        self.refused('release', 'bytecode_receipt_stale')
        bound(); v = json.loads((self.d / 'work/bytecodes-verified.json').read_text()); v['receiptVersion'] = 'v1'
        (self.d / 'work/bytecodes-verified.json').write_text(json.dumps(v)); self.refused('release', 'bytecode_receipt_stale')


if __name__ == '__main__':
    unittest.main(verbosity=2)
