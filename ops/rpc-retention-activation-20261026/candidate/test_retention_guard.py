#!/usr/bin/python3 -I
"""Offline tests of activation-r2/retention_guard.py (PREPARED). Synthetic /proc, systemctl and datadir fixtures (never live); the REAL
pinned v2 preflight copy is exercised, and class RealManifest uses the REAL pinned snapshot manifest (sha 1f0c4e6c verified, read
only) with SPARSE output files at the manifest's exact sizes (first batch -> resume with a partial -> complete). r1's synthetic
manifest selected 18 and hid the bug; synthetic fixtures here mirror the real shape (107 chunks x 500000, 26 selected).
Run: python3 -I test_retention_guard.py   (exact count 15)."""
import hashlib, importlib.util, json, os, pathlib, re, stat, subprocess, tempfile, types, unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('rg', HERE / 'retention_guard.py'); G = importlib.util.module_from_spec(spec); spec.loader.exec_module(G)
WORK = HERE.parents[1]
REAL = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json')
sha = lambda b: hashlib.sha256(b).hexdigest()
GiB = 1 << 30
ORIG = (G.BASE_BIN_SHA256, G.MANIFEST_SHA256)


def synthetic_manifest(chunks=107):
    def comp(name):
        return {'blocks_per_file': 500_000, 'chunk_sizes': [10] * chunks, 'chunk_decompressed_sizes': [20] * chunks,
                'chunk_files': [f'{name}-{i}.tar.zst' for i in range(chunks)],
                'chunk_output_files': [[{'path': f'static_files/{name}_{i}', 'size': 20}] for i in range(chunks)]}
    return {'block': 53_048_526, 'components': {n: comp(n) for n in ('transactions', 'receipts', 'account_changesets', 'storage_changesets', 'headers')}}


class Base(unittest.TestCase):
    manifest_path = None                      # None -> synthetic

    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='retention-r2-'))
        r = self.t / 'srv'; (r / 'data/static_files').mkdir(parents=True); (r / 'snapshot-complete').write_text('')
        (self.t / 'opt').mkdir(); self.bin = self.t / 'opt/base'; self.bin.write_bytes(b'BASE BINARY'); os.chmod(self.bin, 0o755)
        if self.manifest_path is None:
            self.man = self.t / 'opt/manifest.json'; self.man.write_text(json.dumps(synthetic_manifest()))
            G.MANIFEST_SHA256 = sha(self.man.read_bytes())
        else:
            self.man = self.manifest_path; G.MANIFEST_SHA256 = ORIG[1]          # the REAL pin, unpatched
        self.inst = self.t / 'opt/install-manifest.json'; self.inst.write_text(json.dumps({'binaries': {'base': sha(b'BASE BINARY')}}))
        self.proc = self.t / 'proc'; self.proc.mkdir(); (self.t / 'meminfo').write_text(f'MemAvailable: {40 * GiB // 1024} kB\n')
        self.env = dict(G.DEFAULT_ENV, root=str(r), baseBin=str(self.bin), installManifest=str(self.inst), snapshotManifest=str(self.man),
                        proc=str(self.proc), meminfo=str(self.t / 'meminfo'), uid=os.getuid(), preflightExtra=['--free-bytes', str(10 ** 15)])
        G.BASE_BIN_SHA256 = sha(b'BASE BINARY')
        unit = lambda **k: dict(dict(LoadState='loaded', ActiveState='inactive', SubState='dead', Result='success', ExecMainStatus='0', UnitFileState='disabled'), **k)
        self.units = {G.FIRST_UNIT: unit(UnitFileState='enabled'), 'enclave-base-holder.service': unit(), 'enclave-base-holder.path': unit(),
                      G.RETENTION_UNIT: unit(UnitFileState='static')}
        self.pf = G.load_preflight(self.env); self.manifest = json.loads(pathlib.Path(self.man).read_bytes())
        self.sel = self.pf.plan(self.manifest, G.HISTORY_FROM, G.STATE_FROM)['missingArchives']
        self.materialize([a for a in self.sel if a['chunk'] >= G.FIRST_BATCH_FROM_CHUNK])     # the first download's 8 archives

    def tearDown(self):
        G.BASE_BIN_SHA256, G.MANIFEST_SHA256 = ORIG

    def materialize(self, archives, wrong=None):
        """sparse files at the exact manifest sizes (no real disk use); `wrong` = (component, chunk) whose first output is short"""
        for a in archives:
            for i, o in enumerate(a['outputs']):
                p = pathlib.Path(self.env['root'] + '/data') / o['path']; p.parent.mkdir(parents=True, exist_ok=True)
                with open(p, 'wb') as f:
                    f.truncate(o['size'] - 1 if wrong == (a['component'], a['chunk']) and i == 0 else o['size'])

    def run_(self, argv, **kw):
        return types.SimpleNamespace(returncode=0, stdout=''.join(f'{k}={v}\n' for k, v in self.units[argv[-1]].items()))

    def pre(self):
        return G.pre(self.env, self.run_)

    def assertRefused(self, pattern):
        r = self.pre(); self.assertFalse(r['admitted'], r.get('refusals')); self.assertTrue(any(re.search(pattern, x) for x in r['refusals']), r['refusals'])


class Synthetic(Base):
    def test_admitted_with_the_first_batch_present_and_18_missing(self):
        r = self.pre()
        self.assertTrue(r['admitted'], r['refusals']); self.assertEqual((len(self.sel), r['missingArchives'], r['partialExtraction']), (26, 18, []))

    def test_first_download_not_finished_successfully_refuses(self):
        for bad in (dict(ActiveState='activating', SubState='start'), dict(ActiveState='activating', SubState='auto-restart'),
                    dict(ActiveState='failed', SubState='failed', Result='exit-code', ExecMainStatus='1'), dict(LoadState='not-found')):
            self.setUp(); self.units[G.FIRST_UNIT].update(bad); self.assertRefused('first download')
        self.setUp(); os.unlink(self.env['root'] + '/snapshot-complete'); self.assertRefused('snapshot-complete')

    def test_holder_running_or_enabled_refuses(self):
        for unit in ('enclave-base-holder.service', 'enclave-base-holder.path'):
            for bad in (dict(ActiveState='active'), dict(ActiveState='activating'), dict(UnitFileState='enabled')):
                self.setUp(); self.units[unit].update(bad); self.assertRefused(unit)

    def test_any_datadir_user_or_running_base_binary_refuses(self):
        for kind, rel in (('cwd', ''), ('fd', '/db/mdbx.dat'), ('exe', None), ('root', '')):
            self.setUp(); p = self.proc / '4242'; p.mkdir(); (p / 'fd').mkdir()
            target = str(self.bin) if rel is None else self.env['root'] + '/data' + rel
            os.symlink(target, p / 'fd' / '7' if kind == 'fd' else p / kind)
            self.assertRefused('processes use the datadir')

    def test_pins_refuse(self):
        self.bin.write_bytes(b'OTHER'); self.assertRefused('base binary is not')
        self.setUp(); self.inst.write_text(json.dumps({'binaries': {'base': '00' * 32}})); self.assertRefused('install manifest')
        self.setUp(); G.MANIFEST_SHA256 = '11' * 32; self.assertRefused('snapshot manifest is not')

    def test_capacity_refusal_and_policy_drift_refuse(self):
        self.env['preflightExtra'] = ['--free-bytes', '1']; self.assertRefused('capacity preflight refused')
        self.setUp(); self.man.write_text(json.dumps(synthetic_manifest(chunks=108))); G.MANIFEST_SHA256 = sha(self.man.read_bytes())
        self.assertRefused('policy drift: the plan selects 30 archives')

    def test_first_download_archives_absent_refuses(self):
        os.unlink(pathlib.Path(self.env['root'] + '/data/static_files/receipts_105')); self.assertRefused('first download archives absent.*receipts:105')

    def test_memory_floor(self):
        (self.t / 'meminfo').write_text(f'MemAvailable: {(19 * GiB) // 1024} kB\n'); self.assertRefused('MemAvailable')

    def test_partial_and_leftovers_reported_never_deleted(self):
        dd = pathlib.Path(self.env['root'] + '/data'); (dd / 'static_files/transactions_97').write_bytes(b'x' * 5)
        (dd / 'transactions-98.tar.zst').write_bytes(b'.'); r = self.pre()
        self.assertEqual(r['partialExtraction'], [{'component': 'transactions', 'chunk': 97, 'outputs': ['static_files/transactions_97']}])
        self.assertEqual([os.path.basename(x) for x in r['leftovers']], ['transactions-98.tar.zst'])
        self.assertTrue((dd / 'static_files/transactions_97').exists() and (dd / 'transactions-98.tar.zst').exists())

    def test_post_needs_all_26_and_writes_a_read_only_marker_once(self):
        marker = pathlib.Path(self.env['root'] + '/retention-complete')
        self.assertEqual(G.post(self.env)['missingArchives'], 18); self.assertFalse(marker.exists())
        self.materialize(self.sel); r = G.post(self.env)
        self.assertTrue(r['complete']); self.assertEqual(stat.S_IMODE(os.stat(marker).st_mode), 0o444)
        self.assertEqual(json.loads(marker.read_text())['archives'], 26)
        self.assertFalse(G.post(self.env)['complete']); self.assertRefused('already exists')

    def test_unit_file_is_the_reviewed_shape(self):
        u = (HERE / 'enclave-base-retention.service').read_text()
        self.assertEqual(re.search(r'^ExecStart=(.*)$', u, re.M).group(1).split(), G.expected_argv(G.load_preflight(dict(G.DEFAULT_ENV)), dict(G.DEFAULT_ENV)))
        self.assertIn('--download-concurrency 16 ', u)
        for line in ('Restart=no', 'MemoryMax=4G', 'MemorySwapMax=0', 'TasksMax=1024', 'Nice=10', 'NoNewPrivileges=yes', 'ProtectSystem=strict',
                     'ProtectHome=yes', 'PrivateTmp=yes', 'UMask=0027', 'User=rpcbase', 'Conflicts=enclave-base-holder.service',
                     'After=network-online.target enclave-rpc-base-snapshot.service enclave-base-holder.service',
                     'ConditionPathExists=!/srv/enclave-base-holder/retention-complete',
                     'ExecStartPre=+/usr/bin/python3 -I /opt/enclave-rpc/retention/retention_guard.py pre',
                     'ExecStartPost=+/usr/bin/python3 -I /opt/enclave-rpc/retention/retention_guard.py post'):
            self.assertIn('\n' + line + '\n', u, line)
        self.assertNotRegex(u, r'(?m)^\[Install\]\s*$'); self.assertNotIn('--force', u); self.assertNotIn('--prune-unlisted', u)

    def test_shipped_pins_equal_their_sources(self):
        fin = WORK / 'base-finality-proof-stage/r12-final'
        self.assertIn(f"HARNESS_BINARY_SHA256 = '{ORIG[0]}'", (fin / 'producer/base_launch.py').read_text())
        self.assertIn(f"MANIFEST_SHA = '{ORIG[1]}'", (fin / 'harness-first/a2a4.py').read_text())
        self.assertEqual((HERE / 'cached_download_preflight.py').read_bytes(), (WORK / 'base-retention-stage/v2/cached_download_preflight.py').read_bytes())

    def test_activation_script_busy_check_and_conservatism(self):
        s = (HERE / 'retention_activate.sh').read_text()
        self.assertEqual(subprocess.run(['bash', '-n', str(HERE / 'retention_activate.sh')]).returncode, 0)
        self.assertNotIn('is-active --quiet', s)                                   # r1 bug: a running oneshot is 'activating'
        self.assertIn('case "$st" in inactive|failed) ;; *) die', s)
        for bad in (r'\brm\b', r'--force', r'\bmask\b', r'systemctl restart', r'systemctl enable', r'systemctl start[^\n]*holder', r'enclave-rpc-base-snapshot'):
            self.assertIsNone(re.search(bad, s), bad)


class RealManifest(Base):
    manifest_path = REAL

    def test_real_manifest_is_pinned_and_selects_the_exact_26(self):
        self.assertEqual(sha(REAL.read_bytes()), ORIG[1])
        self.assertTrue(G.selection_is_pinned(self.sel)); self.assertEqual(len(self.sel), G.SELECTED_TOTAL)
        self.assertEqual(sum(1 for a in self.sel if a['chunk'] >= G.FIRST_BATCH_FROM_CHUNK), 8)

    def test_real_first_batch_then_resume_with_partial_then_complete(self):
        r = self.pre()                                                            # after the first download: 18 missing
        self.assertTrue(r['admitted'], r['refusals']); self.assertEqual(r['missingArchives'], 18)
        self.assertEqual((r['preflight']['missing']['compressedBytes'], r['preflight']['missing']['extractedBytes']), (221_616_054_366, 409_990_674_216))
        later = [a for a in self.sel if a['component'] == 'transactions' and a['chunk'] <= 100]   # resume: 5 more done, one partial
        self.materialize(later); self.materialize([a for a in self.sel if (a['component'], a['chunk']) == ('receipts', 96)], wrong=('receipts', 96))
        r = self.pre(); self.assertTrue(r['admitted'], r['refusals']); self.assertEqual(r['missingArchives'], 13)
        self.assertEqual([(p['component'], p['chunk']) for p in r['partialExtraction']], [('receipts', 96)])
        self.assertFalse(G.post(self.env)['complete']); self.assertFalse(os.path.exists(self.env['root'] + '/retention-complete'))
        self.materialize(self.sel)                                                 # complete: all 26 at exact sizes
        r = G.post(self.env); self.assertTrue(r['complete'], r); self.assertEqual(r['record']['archives'], 26)
        self.assertRefused('already exists')


if __name__ == '__main__':
    unittest.main(verbosity=2)
