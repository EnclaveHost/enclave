#!/usr/bin/python3 -I
"""Offline tests of retention_guard.py (PREPARED). Synthetic /proc, systemctl, manifest and datadir fixtures only (never live); the
REAL pinned v2 preflight copy is exercised. Pins that cannot match synthetic bytes (binary/manifest sha) are patched per test; a
separate test asserts the shipped constants equal their pinned sources. Run: python3 -I test_retention_guard.py (exact count 13)."""
import hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, tempfile, unittest, types

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('rg', HERE / 'retention_guard.py'); G = importlib.util.module_from_spec(spec); spec.loader.exec_module(G)
WORK = HERE.parents[1]
sha = lambda b: hashlib.sha256(b).hexdigest()
GiB = 1 << 30
ORIG = (G.BASE_BIN_SHA256, G.MANIFEST_SHA256)                        # the shipped pins, captured once


def manifest(history_chunks=7, state_chunks=2):
    """18 selected archives by default (7+7 history, 2+2 state), shaped like the real manifest's components"""
    def comp(first, n, bpf=500_000, name='x'):
        total = first + n
        return {'blocks_per_file': bpf, 'chunk_sizes': [10] * total, 'chunk_decompressed_sizes': [20] * total,
                'chunk_files': [f'{name}-{i}.tar.zst' for i in range(total)],
                'chunk_output_files': [[{'path': f'static_files/{name}_{i}', 'size': 20}] for i in range(total)]}
    return {'block': 53_048_526, 'components': {
        'transactions': comp(96, history_chunks, name='transactions'), 'receipts': comp(96, history_chunks, name='receipts'),
        'account_changesets': comp(105, state_chunks, name='account_changesets'), 'storage_changesets': comp(105, state_chunks, name='storage_changesets'),
        'headers': comp(0, 107, name='headers')}}


class Guard(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='retention-'))
        r = self.t / 'srv'; (r / 'data/static_files').mkdir(parents=True); (r / 'snapshot-complete').write_text('')
        (self.t / 'opt').mkdir(); self.bin = self.t / 'opt/base'; self.bin.write_bytes(b'BASE BINARY'); os.chmod(self.bin, 0o755)
        self.man = self.t / 'opt/manifest.json'; self.man.write_text(json.dumps(manifest()))
        self.inst = self.t / 'opt/install-manifest.json'; self.inst.write_text(json.dumps({'binaries': {'base': sha(b'BASE BINARY')}}))
        self.proc = self.t / 'proc'; self.proc.mkdir(); (self.t / 'meminfo').write_text(f'MemTotal: {64 * GiB // 1024} kB\nMemAvailable: {40 * GiB // 1024} kB\n')
        self.env = {'root': str(r), 'baseBin': str(self.bin), 'installManifest': str(self.inst), 'snapshotManifest': str(self.man),
                    'proc': str(self.proc), 'meminfo': str(self.t / 'meminfo'), 'uid': os.getuid(), 'preflightExtra': ['--free-bytes', str(10 ** 15)]}
        self.env = dict(G.DEFAULT_ENV, **self.env)
        G.BASE_BIN_SHA256, G.MANIFEST_SHA256 = sha(b'BASE BINARY'), sha(self.man.read_bytes())
        self.units = {G.FIRST_UNIT: dict(LoadState='loaded', ActiveState='inactive', SubState='dead', Result='success', ExecMainStatus='0', UnitFileState='enabled'),
                      'enclave-base-holder.service': dict(LoadState='loaded', ActiveState='inactive', SubState='dead', Result='success', ExecMainStatus='0', UnitFileState='disabled'),
                      'enclave-base-holder.path': dict(LoadState='loaded', ActiveState='inactive', SubState='dead', Result='success', ExecMainStatus='0', UnitFileState='disabled'),
                      G.RETENTION_UNIT: dict(LoadState='loaded', ActiveState='inactive', SubState='dead', Result='success', ExecMainStatus='0', UnitFileState='static')}

    def tearDown(self):
        G.BASE_BIN_SHA256, G.MANIFEST_SHA256 = ORIG

    def run_(self, argv, **kw):
        unit = argv[-1]
        return types.SimpleNamespace(returncode=0, stdout=''.join(f'{k}={v}\n' for k, v in self.units[unit].items()))

    def pre(self):
        return G.pre(self.env, self.run_)

    def assertRefused(self, pattern):
        r = self.pre(); self.assertFalse(r['admitted'], r); self.assertTrue(any(re.search(pattern, x) for x in r['refusals']), r['refusals'])

    def test_admitted_when_every_precondition_holds(self):
        r = self.pre()
        self.assertTrue(r['admitted'], r['refusals']); self.assertEqual((r['missingArchives'], r['partialExtraction'], r['leftovers']), (18, [], []))
        self.assertEqual(r['preflight']['command'], G.expected_argv(G.load_preflight(self.env), self.env))

    def test_first_download_not_finished_successfully_refuses(self):
        for bad in (dict(ActiveState='active', SubState='start'), dict(ActiveState='activating', SubState='auto-restart'),
                    dict(ActiveState='failed', SubState='failed', Result='exit-code', ExecMainStatus='1'), dict(Result='exit-code'), dict(LoadState='not-found')):
            self.setUp(); self.units[G.FIRST_UNIT].update(bad); self.assertRefused('first download')
        self.setUp(); os.unlink(self.env['root'] + '/snapshot-complete'); self.assertRefused('snapshot-complete')
        self.setUp(); os.unlink(self.env['root'] + '/snapshot-complete'); os.symlink('/dev/null', self.env['root'] + '/snapshot-complete'); self.assertRefused('snapshot-complete')

    def test_holder_running_or_enabled_refuses_disabled_or_masked_admits(self):
        for unit in ('enclave-base-holder.service', 'enclave-base-holder.path'):
            for bad in (dict(ActiveState='active'), dict(ActiveState='activating'), dict(UnitFileState='enabled'), dict(UnitFileState='enabled-runtime')):
                self.setUp(); self.units[unit].update(bad); self.assertRefused(unit)
        for ok in ('masked', 'masked-runtime'):
            self.setUp(); self.units['enclave-base-holder.service']['UnitFileState'] = ok; self.assertTrue(self.pre()['admitted'])

    def test_any_datadir_user_or_running_base_binary_refuses(self):
        for kind, rel in (('cwd', ''), ('fd', '/db/mdbx.dat'), ('exe', None), ('root', '')):
            self.setUp(); p = self.proc / '4242'; p.mkdir(); (p / 'fd').mkdir()
            target = str(self.bin) if rel is None else self.env['root'] + '/data' + rel      # paths of THIS setUp's tree
            os.symlink(target, p / 'fd' / '7' if kind == 'fd' else p / kind)
            self.assertRefused('processes use the datadir')
        self.setUp(); p = self.proc / '4243'; p.mkdir(); os.symlink('/usr', p / 'cwd'); self.assertTrue(self.pre()['admitted'])

    def test_binary_install_manifest_snapshot_manifest_pins_refuse(self):
        self.bin.write_bytes(b'OTHER'); self.inst.write_text(json.dumps({'binaries': {'base': sha(b'OTHER')}})); self.assertRefused('base binary is not')
        self.setUp(); self.inst.write_text(json.dumps({'binaries': {'base': '00' * 32}})); self.assertRefused('install manifest')
        self.setUp(); G.MANIFEST_SHA256 = '11' * 32; self.assertRefused('snapshot manifest is not')
        self.setUp(); os.chmod(self.inst, 0o666); self.assertRefused('group/other write')

    def test_capacity_refusal_and_policy_drift_refuse(self):
        self.env['preflightExtra'] = ['--free-bytes', '1']; self.assertRefused('capacity preflight refused')
        self.setUp(); self.man.write_text(json.dumps(manifest(history_chunks=8))); G.MANIFEST_SHA256 = sha(self.man.read_bytes())
        self.assertRefused('policy drift: 20 archives')

    def test_memory_below_the_16gib_floor_plus_unit_max_refuses(self):
        (self.t / 'meminfo').write_text(f'MemAvailable: {(19 * GiB) // 1024} kB\n'); self.assertRefused('MemAvailable')
        self.setUp(); (self.t / 'meminfo').write_text(f'MemAvailable: {(20 * GiB) // 1024} kB\n'); self.assertTrue(self.pre()['admitted'])

    def test_completed_retention_is_never_rerun_or_overwritten(self):
        m = pathlib.Path(self.env['root'] + '/retention-complete'); m.write_text('{"done": 1}\n')
        self.assertRefused('already exists')
        self.fill_all(); r = G.post(self.env); self.assertFalse(r['complete']); self.assertEqual(m.read_text(), '{"done": 1}\n')

    def fill_all(self, size=20):
        for comp in manifest()['components'].values():
            for outs in comp['chunk_output_files']:
                for o in outs:
                    p = pathlib.Path(self.env['root'] + '/data') / o['path']; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b'x' * size)

    def test_partial_extraction_and_download_leftovers_are_reported_never_deleted(self):
        dd = pathlib.Path(self.env['root'] + '/data')
        (dd / 'static_files/transactions_97').write_bytes(b'x' * 5)          # interrupted extraction (wrong size)
        (dd / 'transactions-98.tar.zst').write_bytes(b'partial archive')        # leftover archive (manifest file name)
        (dd / 'static_files/receipts_99.part').write_bytes(b'..')
        r = self.pre()
        self.assertEqual(r['partialExtraction'], [{'component': 'transactions', 'chunk': 97, 'outputs': ['static_files/transactions_97']}])
        self.assertEqual([os.path.basename(x) for x in r['leftovers']], ['receipts_99.part', 'transactions-98.tar.zst'])
        s = G.status(self.env, self.run_); self.assertEqual(s['missingArchives'], 18)
        for f in ('static_files/transactions_97', 'transactions-98.tar.zst', 'static_files/receipts_99.part'): self.assertTrue((dd / f).exists(), f)

    def test_post_writes_the_distinct_marker_only_when_every_selected_output_is_present(self):
        marker = pathlib.Path(self.env['root'] + '/retention-complete')
        r = G.post(self.env); self.assertFalse(r['complete']); self.assertEqual(r['missingArchives'], 18); self.assertFalse(marker.exists())
        self.fill_all(size=19); self.assertFalse(G.post(self.env)['complete']); self.assertFalse(marker.exists())
        self.fill_all(); r = G.post(self.env)
        self.assertTrue(r['complete']); rec = json.loads(marker.read_text())
        self.assertEqual((rec['format'], rec['archives'], rec['historyFrom'], rec['stateHistoryFrom']), ('enclave-base-retention-complete/v1', 18, 48_000_000, 52_500_000))
        self.assertTrue(pathlib.Path(self.env['root'] + '/snapshot-complete').exists(), 'the first marker is untouched')
        self.assertFalse(list(pathlib.Path(self.env['root']).glob('retention-complete.tmp-*')))

    def test_unit_file_is_the_reviewed_shape(self):
        u = (HERE / 'enclave-base-retention.service').read_text()
        execstart = re.search(r'^ExecStart=(.*)$', u, re.M).group(1)
        self.assertEqual(execstart.split(), G.expected_argv(G.load_preflight(dict(G.DEFAULT_ENV)), dict(G.DEFAULT_ENV)))
        for line in ('Type=oneshot', 'User=rpcbase', 'Group=rpcbase', 'Environment=HOME=/srv/enclave-base-holder/data TMPDIR=/srv/enclave-base-holder/tmp',
                     'Restart=no', 'MemoryMax=4G', 'MemorySwapMax=0', 'TasksMax=1024', 'Nice=10', 'NoNewPrivileges=yes', 'ProtectSystem=strict',
                     'ProtectHome=yes', 'PrivateTmp=yes', 'UMask=0027', 'ReadWritePaths=/srv/enclave-base-holder/data /srv/enclave-base-holder/tmp',
                     'Conflicts=enclave-base-holder.service', 'ConditionPathExists=/srv/enclave-base-holder/snapshot-complete',
                     'ConditionPathExists=!/srv/enclave-base-holder/retention-complete',
                     'ExecStartPre=+/usr/bin/python3 -I /opt/enclave-rpc/retention/retention_guard.py pre',
                     'ExecStartPost=+/usr/bin/python3 -I /opt/enclave-rpc/retention/retention_guard.py post'):
            self.assertIn('\n' + line + '\n', u, line)
        self.assertNotRegex(u, r'(?m)^\[Install\]\s*$'); self.assertNotRegex(u, r'(?m)^(WantedBy|RequiredBy|Alias)=')
        self.assertNotIn('--force', u); self.assertNotIn('--prune-unlisted', u)
        self.assertNotRegex(u, r'(?m)^Conflicts=.*enclave-rpc-base-snapshot'), self.assertNotIn('Restart=on-failure', u)

    def test_shipped_pins_equal_their_sources(self):
        G.BASE_BIN_SHA256, G.MANIFEST_SHA256 = ORIG
        fin = WORK / 'base-finality-proof-stage/r12-final'
        self.assertIn(f"HARNESS_BINARY_SHA256 = '{G.BASE_BIN_SHA256}'", (fin / 'producer/base_launch.py').read_text())
        self.assertIn(f"MANIFEST_SHA = '{G.MANIFEST_SHA256}'", (fin / 'harness-first/a2a4.py').read_text())
        self.assertEqual((HERE / 'cached_download_preflight.py').read_bytes(), (WORK / 'base-retention-stage/v2/cached_download_preflight.py').read_bytes())
        self.assertEqual(sha((HERE / 'cached_download_preflight.py').read_bytes()), G.PREFLIGHT_SHA256)

    def test_activation_script_is_conservative(self):
        s = (HERE / 'retention_activate.sh').read_text()
        self.assertEqual(subprocess.run(['bash', '-n', str(HERE / 'retention_activate.sh')]).returncode, 0)
        for bad in (r'\brm\b', r'--force', r'\bmask\b', r'systemctl (re)?start enclave-rpc-base-snapshot', r'systemctl restart', r'systemctl enable',
                    r'systemctl start[^\n]*holder', r'--prune-unlisted'):
            self.assertIsNone(re.search(bad, s), bad)
        self.assertIn('cp -p --no-clobber', s); self.assertIn('retention_guard.py pre || die', s)


if __name__ == '__main__':
    unittest.main(verbosity=2)
