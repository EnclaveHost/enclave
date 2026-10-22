"""Tests for make-upgrade-bundle.py: exact replace/add/unchanged derivation, byte-exact pin-only config rewrite, and every
refusal (removed file, changed stop/start/health/common, changed data or supervisor template, foreign or duplicated pin).
Also: run against the REAL installed r3 stage as both old and new stage -> an empty upgrade (nothing to replace).
  python3 -m unittest test_make_upgrade_bundle.py"""
import hashlib, importlib.util, json, os, pathlib, shutil, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mub', HERE / 'make-upgrade-bundle.py'); mub = importlib.util.module_from_spec(spec); spec.loader.exec_module(mub)
R3 = HERE.parent.parent / 'hosted-services-activation/final-r3/stage-r2/enclave-host-services-hs2-windows'
sha = lambda b: hashlib.sha256(b).hexdigest()

def stage(root, files):
    root.mkdir(parents=True)
    lines = []
    for rel, data in sorted(files.items()):
        p = root / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data); lines.append(f'{sha(data)}  {rel}')
    (root / 'STAGE-SHA256SUMS').write_text('\n'.join(lines) + '\n')
    return root

BASE = {'bin/host-services-runner.mjs': b'runner v1', 'bin/stage-tool.mjs': b'tool v1', 'bin/hostsvc-supervisor.exe': b'exe',
        'packages/directory-replica.mjs': b'dir v1', 'packages/directory-replica.package.json': b'{"dir":1}',
        'packages/bootstrap-replica.mjs': b'boot v1', 'packages/bootstrap-replica.package.json': b'{"boot":1}',
        'windows/common.ps1': b'common', 'windows/stop.ps1': b'stop', 'windows/start.ps1': b'start', 'windows/health.ps1': b'health',
        'windows/install.ps1': b'install', 'ACTIVATION-WINDOWS.txt': b'act v1', 'data/bootstrap-manifest.json': b'{"m":1}',
        'config/supervisor.template.json': b'{"s":1}', 'config/spec.windows.json': b'{"spec":1}'}

def config_for(files):
    cfg = {'format': 'enclave-host-services/v1', 'host': {'endpoint': 'https://api.enclave.host/t/x'}, 'platformHostPolicy': 'production',
           'packagesDir': 'C:\\Program Files\\Enclave\\host-services\\hs2\\packages', 'stateRoot': 'C:\\ProgramData\\Enclave\\host-services\\hs2\\state',
           'services': [{'role': r, 'package': 'sha256:' + sha(files[f'packages/{r}.package.json']), 'heapMiB': 128, 'config': {'port': 1, 'note': 'ünïcode'}}
                        for r in ('directory-replica', 'bootstrap-replica')]}
    return (json.dumps(cfg, indent=2, ensure_ascii=False) + '\n').encode('utf-8')

class T(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='mub-')); self.addCleanup(shutil.rmtree, self.d)
    def run_build(self, new_files, old_files=BASE, cfg_bytes=None):
        old = stage(self.d / 'old', old_files); new = stage(self.d / 'new', new_files)
        cb = cfg_bytes if cfg_bytes is not None else config_for(old_files)
        c = self.d / 'host-services.json'; c.write_bytes(cb)
        return mub.build(str(old), str(new), str(c), sha(cb), 'ab' * 32, str(self.d / 'bundle')), cb

    def test_exact_lists_and_pin_only_config(self):
        new = {**BASE, 'bin/host-services-runner.mjs': b'runner v2', 'packages/directory-replica.mjs': b'dir v2',
               'packages/directory-replica.package.json': b'{"dir":2}', 'packages/service-tls.mjs': b'tls', 'packages/service-tls.package.json': b'{"tls":1}'}
        (m, msha), old_cfg = self.run_build(new)
        self.assertEqual([e['path'] for e in m['replace']], ['STAGE-SHA256SUMS', 'bin/host-services-runner.mjs', 'packages/directory-replica.mjs', 'packages/directory-replica.package.json'])
        self.assertEqual([e['path'] for e in m['add']], ['packages/service-tls.mjs', 'packages/service-tls.package.json'])
        self.assertIn({'path': 'bin/hostsvc-supervisor.exe', 'sha': sha(b'exe')}, m['unchanged'])
        self.assertEqual(set(m['scripts']), {'windows/stop.ps1', 'windows/start.ps1', 'windows/health.ps1', 'windows/common.ps1'})
        new_cfg = (self.d / 'bundle/config/host-services.json').read_bytes()
        self.assertEqual(m['config']['new'], sha(new_cfg))
        diff = [(a, b) for a, b in zip(old_cfg.decode().splitlines(), new_cfg.decode().splitlines()) if a != b]
        self.assertEqual(len(diff), 1, 'exactly one line (the directory-replica pin) differs')
        self.assertIn(sha(b'{"dir":2}'), diff[0][1])
        self.assertEqual(len(old_cfg.decode().splitlines()), len(new_cfg.decode().splitlines()))
        self.assertEqual(msha, sha((self.d / 'bundle/upgrade-manifest.json').read_bytes()))
        for e in m['replace'] + m['add']: self.assertEqual(sha((self.d / 'bundle/files' / e['path']).read_bytes()), e['new'])

    def test_refusals(self):
        cases = {
            'removed': {k: v for k, v in BASE.items() if k != 'bin/stage-tool.mjs'},
            'stop changed': {**BASE, 'windows/stop.ps1': b'stop v2'},
            'common changed': {**BASE, 'windows/common.ps1': b'common v2'},
            'data changed': {**BASE, 'data/bootstrap-manifest.json': b'{"m":2}'},
            'supervisor changed': {**BASE, 'config/supervisor.template.json': b'{"s":2}'},
        }
        for name, files in cases.items():
            with self.subTest(name):
                shutil.rmtree(self.d); self.d.mkdir()
                with self.assertRaises(mub.Refused): self.run_build(files)
        shutil.rmtree(self.d); self.d.mkdir()
        foreign = json.loads(config_for(BASE)); foreign['services'][0]['package'] = 'sha256:' + 'f' * 64
        with self.assertRaisesRegex(mub.Refused, 'not the old stage package'): self.run_build({**BASE, 'packages/directory-replica.package.json': b'{"dir":2}'}, cfg_bytes=(json.dumps(foreign, indent=2) + '\n').encode())
        shutil.rmtree(self.d); self.d.mkdir()
        twice = config_for(BASE).replace(b'"note"', b'"package": "sha256:' + sha(BASE['packages/directory-replica.package.json']).encode() + b'", "note"', 1)
        with self.assertRaisesRegex(mub.Refused, 'exactly once'): self.run_build({**BASE, 'packages/directory-replica.package.json': b'{"dir":2}'}, cfg_bytes=twice)

    def test_real_r3_stage_against_itself_is_an_empty_upgrade(self):
        if not R3.exists(): self.skipTest('r3 stage not present')
        pins = {}
        for f in R3.glob('packages/*.package.json'): pins[f.name[:-len('.package.json')]] = 'sha256:' + sha(f.read_bytes())
        cfg = (json.dumps({'format': 'enclave-host-services/v1', 'services': [{'role': r, 'package': p} for r, p in sorted(pins.items())]}, indent=2) + '\n').encode()
        c = self.d / 'cfg.json'; c.write_bytes(cfg)
        m, _ = mub.build(str(R3), str(R3), str(c), sha(cfg), 'cd' * 32, str(self.d / 'b'))
        self.assertEqual(m['replace'], []); self.assertEqual(m['add'], [])
        self.assertEqual(m['scripts']['windows/stop.ps1'], '4efd8647e134b6663681bf274be8b39056b725798aba673f6608882446f9376e', 'the live r3 stop.ps1 pin')
        self.assertEqual(m['config']['new'], m['config']['old'])

if __name__ == '__main__': unittest.main()

class Contract(unittest.TestCase):
    """No PowerShell here: check statically that the generator, the helper and the fixture agree on the manifest."""
    def test_helper_required_fields_are_generated_and_fixture_uses_them(self):
        helper = (HERE / 'hs2-upgrade.ps1').read_text(); fixture = (HERE / 'upgrade-fixture.ps1').read_text()
        import re
        req = re.search(r"foreach \(\$k in ('[^)]+')\) \{ if \(\$M\.PSObject", helper).group(1)
        fields = re.findall(r"'([a-z]+)'", req)
        self.assertEqual(fields, ['format', 'label', 'id', 'scripts', 'replace', 'add', 'unchanged', 'config', 'receipt'])
        d = pathlib.Path(tempfile.mkdtemp(prefix='mub-c-')); self.addCleanup(shutil.rmtree, d)
        old = stage(d / 'old', BASE); new = stage(d / 'new', {**BASE, 'bin/stage-tool.mjs': b'tool v2'})
        c = d / 'c.json'; c.write_bytes(config_for(BASE))
        m, _ = mub.build(str(old), str(new), str(c), sha(config_for(BASE)), 'ab' * 32, str(d / 'b'))
        for f in fields: self.assertIn(f, m)
        self.assertEqual(m['format'], 'enclave-hs2-upgrade/v1'); self.assertEqual(m['label'], 'hs2')
        for k in ('windows/stop.ps1', 'windows/start.ps1', 'windows/health.ps1'): self.assertIn(k, m['scripts'])
        self.assertTrue(all(set(e) == {'path', 'old', 'new'} for e in m['replace']))
        self.assertTrue({'old', 'new'} <= set(m['config'])); self.assertIn('old', m['receipt'])
        for f in fields: self.assertRegex(fixture, rf"\b{f} = ", f'the fixture manifest sets {f}')
        # the helper never writes state or data: no Put-File / WriteAtomicText / Copy-Item / Remove-Item targets them
        for line in helper.splitlines():
            if re.search(r'(Put-File|WriteAtomicText|Copy-Item|Remove-Item|Move|Replace\()', line):
                self.assertNotRegex(line, r'\$(StateDir|DataDir)\b', line)
