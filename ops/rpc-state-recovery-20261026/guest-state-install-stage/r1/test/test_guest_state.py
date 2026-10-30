"""guest-state-install-stage/r1 offline tests (python3 -I -m unittest -v test_guest_state, from test/). Non-root, --test-mode.
FIXTURES (labelled): a per-test STUB extractor whose fault mode and log path are BAKED INTO ITS OWN FILE (the production code keeps
its clean extractor environment: r2's root 1438 failures came from injecting STUB_MODE through an environment that srr2 strips), and
a STUB BLAKE3 tool that prints SHA-256 (with a matching --kat-expect, test-mode only). This is NOT a BLAKE3 qualification."""
import hashlib, io, json, os, re, stat, subprocess, sys, tarfile, tempfile, unittest
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__)); STAGE = os.path.dirname(HERE)
TOOL = os.path.join(STAGE, 'guest_state.py')
R2_UNIT = os.path.join(STAGE, '..', '..', 'base-retention-stage', 'activation-r2', 'enclave-base-retention.service')
sha = lambda b: hashlib.sha256(b).hexdigest()
FILES = {'db/database.version': b'2', 'db/lock': b'lock-bytes12', 'db/mdbx.dat': os.urandom(200000), 'db/mdbx.lck': b'L' * 4096}

STUB_BASE = r'''#!/usr/bin/python3 -I
# TEST STUB (labelled): stands in for `base snapshot download --url file://` in test_guest_state.py ONLY. MODE/LOG are baked here.
import json, os, sys, tarfile
MODE, LOG = %r, %r
argv = sys.argv[1:]
json.dump({'argv': argv, 'envKeys': sorted(os.environ)}, open(LOG, 'w'))
if {'--force', '--prune-unlisted'} & set(argv) or argv[:2] != ['snapshot', 'download']:
    sys.exit(97)
d, url = argv[argv.index('--datadir') + 1], argv[argv.index('--url') + 1]
if MODE == 'fail':
    os.makedirs(d + '/db', exist_ok=True); open(d + '/db/mdbx.dat', 'wb').write(b'partial'); sys.exit(1)
with tarfile.open(url[len('file://'):], 'r:zst') as t:
    t.extractall(d, filter='data')
db = d + '/db'
if MODE == 'symlink':
    os.unlink(db + '/mdbx.lck'); os.symlink('/etc/hostname', db + '/mdbx.lck')
elif MODE == 'hardlink':
    os.link(db + '/lock', d + '/lock-twin')
elif MODE == 'fifo':
    os.unlink(db + '/mdbx.lck'); os.mkfifo(db + '/mdbx.lck')
elif MODE == 'extra':
    open(db + '/extra.bin', 'wb').write(b'x')
elif MODE == 'extradir':
    os.mkdir(d + '/static_files')
elif MODE == 'missing':
    os.unlink(db + '/mdbx.lck')
elif MODE == 'wrongsize':
    open(db + '/mdbx.dat', 'ab').write(b'+')
elif MODE == 'setuid':
    os.chmod(db + '/lock', 0o4644)
elif MODE == 'wrongdigest':
    b = bytearray(open(db + '/mdbx.dat', 'rb').read()); b[0] ^= 1; open(db + '/mdbx.dat', 'wb').write(bytes(b))
sys.exit(0)
'''
STUB_B3 = '''#!/usr/bin/python3 -I
# TEST STUB (labelled): prints SHA-256, NOT BLAKE3. test_guest_state.py ONLY.
import hashlib, sys
print(hashlib.sha256(open(sys.argv[-1], 'rb').read()).hexdigest())
'''


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); T = self.t.name
        self.work, self.holder = os.path.join(T, 'work'), os.path.join(T, 'holder'); self.data = os.path.join(self.holder, 'data')
        for d in (self.work, *(os.path.join(self.work, n) for n in ('stage', 'x-home', 'extract-state')), self.holder, self.data, os.path.join(self.data, 'db')):
            os.makedirs(d, mode=0o700, exist_ok=True)
        open(os.path.join(self.data, 'reth.toml'), 'w').write('# kept\n')
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w:zst') as tf:
            for p, b in FILES.items():
                ti = tarfile.TarInfo(p); ti.size = len(b); ti.mode = 0o644; tf.addfile(ti, io.BytesIO(b))
        self.archive = buf.getvalue(); open(os.path.join(self.work, 'state.tar.zst'), 'wb').write(self.archive)
        self.man = os.path.join(T, 'manifest.json')
        m = {'block': 1, 'components': {'state': {'file': '1/state.tar.zst', 'size': len(self.archive), 'decompressed_size': sum(map(len, FILES.values())),
             'output_files': [{'path': p, 'size': len(b), 'blake3': sha(b)} for p, b in FILES.items()]}}}   # labelled: sha256 as the "BLAKE3"
        open(self.man, 'w').write(json.dumps(m)); self.msha = sha(open(self.man, 'rb').read())
        self.prov = os.path.join(T, 'prov.json')
        json.dump({'format': 'enclave-host-archive-provenance/r1', 'manifestSha256': self.msha, 'size': len(self.archive), 'sha256': sha(self.archive)}, open(self.prov, 'w'))
        self.b3 = self.exe('b3sum', STUB_B3); self.log = os.path.join(T, 'stub.log')

    def tearDown(self):
        self.t.cleanup()

    def exe(self, name, text):
        p = os.path.join(self.t.name, name); open(p, 'w').write(text); os.chmod(p, 0o755); return p

    def stub(self, mode=''):
        return self.exe(f'base-{mode or "ok"}', STUB_BASE % (mode, self.log))

    def run_(self, *args, base=None):
        common = ['--manifest', self.man, '--manifest-sha256', self.msha, '--test-mode']
        extra = {'import-verify': ['--work-dir', self.work, '--provenance', self.prov],
                 'extract-stage': ['--work-dir', self.work, '--base-bin', base or self.stub(), '--base-bin-sha256', sha(open(base or self.stub(), 'rb').read())],
                 'install': ['--work-dir', self.work, '--datadir', self.data, '--holder-root', self.holder, '--b3sum', self.b3,
                             '--b3sum-sha256', sha(open(self.b3, 'rb').read()), '--kat-expect', sha(b'')],
                 'guard': ['--datadir', self.data, '--holder-root', self.holder]}[args[0]]
        return subprocess.run([sys.executable, '-I', TOOL, args[0], *common, *extra, *args[1:]], capture_output=True, text=True)

    def tree(self, root):
        return sorted((os.path.relpath(os.path.join(r, n), root), os.lstat(os.path.join(r, n)).st_size, os.lstat(os.path.join(r, n)).st_mtime_ns)
                      for r, ds, fs in os.walk(root) for n in ds + fs)

    def ready(self, mode=''):
        self.assertEqual(self.run_('import-verify').returncode, 0)
        return self.run_('extract-stage', base=self.stub(mode))


class Import(Base):
    def test_import_verify_identity_and_refusals(self):
        r = self.run_('import-verify'); self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(open(os.path.join(self.work, 'state.tar.zst'), 'rb').read(), self.archive)
        json.dump({**json.load(open(self.prov)), 'sha256': '00' * 32}, open(self.prov, 'w'))
        self.assertEqual(self.run_('import-verify').returncode, 10)
        json.dump({**json.load(open(self.prov)), 'format': 'x'}, open(self.prov, 'w'))
        self.assertEqual(self.run_('import-verify').returncode, 2)
        open(os.path.join(self.work, 'state.tar.zst'), 'ab').write(b'+')
        self.assertEqual(self.run_('import-verify').returncode, 2)


class Extract(Base):
    def test_staged_extraction_clean_env_exact_set_data_untouched(self):
        before = self.tree(self.data); r = self.ready(); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        log = json.load(open(self.log))
        self.assertEqual(log['argv'][:6], ['snapshot', 'download', '--chain', 'base', '--datadir', os.path.join(self.work, 'stage')])
        self.assertEqual(log['envKeys'], ['HOME', 'LC_ALL', 'PATH', 'TMPDIR'])           # the production env stays clean
        self.assertEqual(self.tree(self.data), before)
        self.assertTrue(os.path.exists(os.path.join(self.work, 'extract-state', 'staged.json')))

    def test_hostile_or_wrong_staging_is_refused_and_installs_nothing(self):
        for mode in ('symlink', 'hardlink', 'fifo', 'extra', 'extradir', 'missing', 'wrongsize', 'setuid'):
            self.tearDown(); self.setUp(); before = self.tree(self.data)
            r = self.ready(mode); self.assertEqual(r.returncode, 8, mode + r.stdout)
            self.assertEqual(self.run_('install').returncode, 2, mode)                      # no staged.json -> nothing to install
            self.assertEqual(self.tree(self.data), before, mode)

    def test_extractor_failure_then_clean_retry(self):
        r = self.ready('fail'); self.assertEqual(r.returncode, 9, r.stdout)
        r = self.run_('extract-stage'); self.assertEqual(r.returncode, 0, r.stdout)           # the stale partial staging is emptied first
        self.assertEqual(sorted(os.listdir(os.path.join(self.work, 'stage', 'db'))), sorted(os.path.basename(p) for p in FILES))

    def test_archive_change_or_unpinned_binary_refuses(self):
        self.assertEqual(self.run_('import-verify').returncode, 0)
        b = self.stub(); r = subprocess.run([sys.executable, '-I', TOOL, 'extract-stage', '--manifest', self.man, '--manifest-sha256', self.msha, '--test-mode',
                                             '--work-dir', self.work, '--base-bin', b, '--base-bin-sha256', '00' * 32], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        os.utime(os.path.join(self.work, 'state.tar.zst'), ns=(1, 1))
        self.assertEqual(self.run_('extract-stage').returncode, 2)


class Install(Base):
    def test_install_verifies_then_renames_records_and_keeps_the_archive(self):
        self.assertEqual(self.ready().returncode, 0)
        r = self.run_('install'); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for p, b in FILES.items():
            self.assertEqual(open(os.path.join(self.data, p), 'rb').read(), b)
        rec = json.load(open(os.path.join(self.holder, 'state-installed.json')))
        self.assertEqual(set(rec['files']), set(FILES)); self.assertEqual(rec['archiveSha256'], sha(self.archive))
        self.assertEqual(open(os.path.join(self.work, 'state.tar.zst'), 'rb').read(), self.archive)
        self.assertEqual(open(os.path.join(self.data, 'reth.toml')).read(), '# kept\n')
        self.assertEqual(self.run_('install').returncode, 2)                                 # never re-installed over a DB

    def test_wrong_digest_db_not_empty_or_missing_installs_nothing(self):
        self.assertEqual(self.ready('wrongdigest').returncode, 0)
        r = self.run_('install'); self.assertEqual(r.returncode, 10, r.stdout); self.assertEqual(os.listdir(os.path.join(self.data, 'db')), [])
        self.tearDown(); self.setUp(); self.assertEqual(self.ready().returncode, 0)
        open(os.path.join(self.data, 'db', 'old'), 'w').write('x')
        self.assertEqual(self.run_('install').returncode, 2)
        os.unlink(os.path.join(self.data, 'db', 'old')); os.rmdir(os.path.join(self.data, 'db'))
        self.assertEqual(self.run_('install').returncode, 2)

    def test_staged_change_after_extract_and_tool_pins_refuse(self):
        self.assertEqual(self.ready().returncode, 0)
        os.utime(os.path.join(self.work, 'stage', 'db', 'mdbx.dat'), ns=(5, 5))
        self.assertEqual(self.run_('install').returncode, 8)
        self.tearDown(); self.setUp(); self.assertEqual(self.ready().returncode, 0)
        r = subprocess.run([sys.executable, '-I', TOOL, 'install', '--manifest', self.man, '--manifest-sha256', self.msha, '--test-mode', '--work-dir', self.work,
                            '--datadir', self.data, '--holder-root', self.holder, '--b3sum', self.b3, '--b3sum-sha256', '11' * 32, '--kat-expect', sha(b'')], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        r = subprocess.run([sys.executable, '-I', TOOL, 'install', '--manifest', self.man, '--manifest-sha256', self.msha, '--test-mode', '--work-dir', self.work,
                            '--datadir', self.data, '--holder-root', self.holder, '--b3sum', self.b3, '--b3sum-sha256', sha(open(self.b3, 'rb').read())], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2, 'the real BLAKE3 known answer is required: a SHA-256 stub fails it')
        r = subprocess.run([sys.executable, '-I', TOOL, 'install', '--manifest', self.man, '--manifest-sha256', self.msha, '--work-dir', self.work,
                            '--datadir', self.data, '--holder-root', self.holder, '--b3sum', self.b3, '--b3sum-sha256', 'aa' * 32, '--kat-expect', sha(b'')], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn('needs', r.stderr)             # --kat-expect only with --test-mode

    def test_crash_between_renames_resumes_exactly(self):
        for n in (1, 2, 3):
            self.tearDown(); self.setUp(); self.assertEqual(self.ready().returncode, 0)
            self.assertEqual(self.run_('install', '--test-crash-after', str(n)).returncode, 77)
            self.assertFalse(os.path.exists(os.path.join(self.holder, 'state-installed.json')))
            r = self.run_('install'); self.assertEqual(r.returncode, 0, r.stdout)
            for p, b in FILES.items():
                self.assertEqual(open(os.path.join(self.data, p), 'rb').read(), b, n)


class Guard(Base):
    def test_guard_allows_only_the_unmodified_installed_state(self):
        self.assertEqual(self.run_('guard').returncode, 2)                                    # nothing installed
        self.assertEqual(self.ready().returncode, 0); self.assertEqual(self.run_('install').returncode, 0)
        self.assertEqual(self.run_('guard').returncode, 0)
        os.utime(os.path.join(self.data, 'db', 'mdbx.dat'), ns=(9, 9))                        # e.g. finalize's init_db
        self.assertEqual(self.run_('guard').returncode, 2)

    def test_guard_refuses_finalized_extra_or_foreign_record(self):
        self.assertEqual(self.ready().returncode, 0); self.assertEqual(self.run_('install').returncode, 0)
        open(os.path.join(self.holder, 'retention-complete'), 'w').write('{}')
        self.assertEqual(self.run_('guard').returncode, 2); os.unlink(os.path.join(self.holder, 'retention-complete'))
        open(os.path.join(self.data, 'db', 'x'), 'w').write('x'); self.assertEqual(self.run_('guard').returncode, 2); os.unlink(os.path.join(self.data, 'db', 'x'))
        rp = os.path.join(self.holder, 'state-installed.json'); rec = json.load(open(rp)); rec['manifestSha256'] = '00' * 32; json.dump(rec, open(rp, 'w'))
        self.assertEqual(self.run_('guard').returncode, 2)


class Units(unittest.TestCase):
    def kv(self, path):
        out = {}
        for l in open(path).read().splitlines():
            if '=' in l and not l.startswith('#'):
                k, v = l.split('=', 1); out.setdefault(k, []).append(v)
        return out

    def test_extract_is_confined_and_install_never_extracts(self):
        x = self.kv(os.path.join(STAGE, 'units', 'enclave-base-state-extract-gsi.service'))
        W = '/srv/enclave-base-holder/tmp/state-gsi'
        self.assertEqual(x['ReadWritePaths'], [f'{W}/stage {W}/x-home {W}/extract-state'])
        for k, v in (('PrivateNetwork', 'yes'), ('CapabilityBoundingSet', ''), ('NoNewPrivileges', 'yes'), ('ProtectSystem', 'strict'),
                     ('RestrictAddressFamilies', 'AF_UNIX'), ('IPAddressDeny', 'any'), ('MemorySwapMax', '0'), ('Restart', 'no')):
            self.assertEqual(x[k], [v], k)
        self.assertNotIn('Conflicts', x)
        i = self.kv(os.path.join(STAGE, 'units', 'enclave-base-state-install-gsi.service'))
        self.assertIn(' install ', i['ExecStart'][0]); self.assertNotIn('--base-bin', i['ExecStart'][0]); self.assertEqual(i['PrivateNetwork'], ['yes'])
        self.assertNotIn('Conflicts', i)
        for u in (x, i):
            self.assertIn('!/srv/enclave-base-holder/retention-complete', u['ConditionPathExists'])

    def test_guard_drop_in_runs_after_the_units_pre_and_before_reth(self):
        unit = open(R2_UNIT).read().splitlines()
        drop = open(os.path.join(STAGE, 'units', 'enclave-base-retention.service.d', '60-state-install-guard.conf')).read().splitlines()
        merged = [l for l in unit if l.startswith(('ExecStartPre=', 'ExecStart='))] + [l for l in drop if l.startswith('ExecStartPre=')]
        order = [l.split('=', 1)[0] for l in merged]
        pres = [l for l in merged if l.startswith('ExecStartPre=')]
        self.assertTrue(pres[-1].startswith('ExecStartPre=+/usr/bin/python3 -I /opt/enclave-rpc/state-install-r1/guest_state.py guard '))
        self.assertIn('retention_guard.py pre', ' '.join(pres[:-1]))
        self.assertEqual(order.count('ExecStart'), 1)                     # systemd runs every ExecStartPre (unit + drop-in) before ExecStart


if __name__ == '__main__':
    unittest.main()
