#!/usr/bin/env python3
"""copy-artifacts.py regression (r12; PREPARED; run by the r12 runner's phase A, exact count 12, no skips). Synthetic forge-shaped
trees in a temp dir (nothing committed). Demonstrates r11's ACTUAL line-123 command flattening the first artifact directory into
out/ with exit status 0, then the helper's exact shape and every refusal."""
import hashlib, os, pathlib, shutil, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
TOOL = HERE / 'copy-artifacts.py'
RUNNER = HERE.parent / 'jobs' / 'r12-build-validate.sh'
ARTS = {'out/EnclaveRegistry.sol/EnclaveRegistry.json': b'{"bytecode":{"object":"0x60"}}\n',
        'out/PaymentRouter.sol/IERC20.json': b'{"bytecode":{"object":"0x"}}\n',
        'out/PaymentRouter.sol/IERC20Permit.json': b'{"bytecode":{"object":"0x"}}\n',
        'out/PaymentRouter.sol/PaymentRouter.json': b'{"bytecode":{"object":"0x6080"}}\n'}


class Case(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='copyart-'))
        self.src = self.t / 'src/contracts/foundry'; self.dst = self.t / 'dst/contracts/foundry'
        for rel, b in ARTS.items():
            (self.src / rel).parent.mkdir(parents=True, exist_ok=True); (self.src / rel).write_bytes(b)
        (self.src / 'out/build-info').mkdir(); (self.src / 'out/build-info/0123abcd.json').write_text('{"id":"0123abcd"}')
        self.dst.mkdir(parents=True)
        self.man = self.t / 'ARTIFACTS-first.sha256'; self.write_manifest()

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def write_manifest(self, rows=None):
        rows = rows if rows is not None else [(hashlib.sha256((self.src / r).read_bytes()).hexdigest(), r) for r in sorted(ARTS, key=str.encode)]
        self.man.write_text(''.join(f'{h}  {r}\n' for h, r in rows))

    def run_tool(self):
        return subprocess.run([sys.executable, '-I', '-B', str(TOOL), str(self.src), str(self.dst), str(self.man)], capture_output=True, text=True)

    def dst_set(self):
        return sorted(str(p.relative_to(self.dst)) for p in (self.dst / 'out').rglob('*') if p.is_file())

    def refused(self, needle):
        r = self.run_tool()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertIn('REFUSED', r.stdout); self.assertIn(needle, r.stdout)


class R11Shape(Case):
    def test_r11_line_123_flattens_the_first_directory_and_still_exits_zero(self):
        cmd = f'(cd {self.src} && find out -mindepth 1 -maxdepth 1 -not -name build-info -exec cp -a {{}} {self.dst}/out/ \\; ) 2>/dev/null'
        r = subprocess.run(['bash', '-c', cmd])
        self.assertEqual(r.returncode, 0, 'the failure was masked: r11 never ran its mkdir fallback')
        got = self.dst_set()
        self.assertNotEqual(got, sorted(ARTS))
        self.assertTrue(any(g.count('/') == 1 for g in got), f'an artifact landed directly under out/: {got}')


class Helper(Case):
    def test_the_helper_copies_the_exact_reviewed_shape_and_bytes(self):
        r = self.run_tool(); self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(self.dst_set(), sorted(ARTS))
        for rel, b in ARTS.items():
            self.assertEqual((self.dst / rel).read_bytes(), b)
        self.assertFalse((self.dst / 'out/build-info').exists(), 'bookkeeping is not copied')

    def test_an_existing_destination_out_is_never_merged(self):
        (self.dst / 'out').mkdir(); self.refused('already exists')

    def test_a_manifest_path_outside_the_grammar_refuses(self):
        h = hashlib.sha256(b'x').hexdigest()
        for bad in ('out/../evil.json', '/etc/passwd', 'out/build-info/0123abcd.json', 'out/a.sol/b.txt'):
            self.write_manifest([(h, bad)]); self.refused('')
            self.assertFalse((self.dst / 'out').exists(), f'nothing created for {bad}')

    def test_a_source_byte_mismatch_refuses(self):
        (self.src / 'out/PaymentRouter.sol/PaymentRouter.json').write_bytes(b'{"tampered":1}'); self.refused('differ from the manifest')

    def test_extra_or_missing_source_files_refuse(self):
        (self.src / 'out/PaymentRouter.sol/Extra.json').write_text('{}'); self.refused('other files than its manifest')
        os.unlink(self.src / 'out/PaymentRouter.sol/Extra.json'); os.unlink(self.src / 'out/EnclaveRegistry.sol/EnclaveRegistry.json')
        self.refused('other files than its manifest')

    def test_a_symlinked_source_refuses(self):
        p = self.src / 'out/PaymentRouter.sol/IERC20.json'; os.unlink(p); os.symlink('/etc/hostname', p); self.refused('symlink')

    def test_a_malformed_empty_or_unsorted_manifest_refuses(self):
        self.man.write_text(''); self.refused('empty')
        self.man.write_text('nothex  out/a.sol/a.json\n'); self.refused('lines')
        rows = [(hashlib.sha256((self.src / r).read_bytes()).hexdigest(), r) for r in sorted(ARTS, key=str.encode)]
        self.write_manifest(list(reversed(rows))); self.refused('sorted')

    def test_a_symlinked_destination_refuses(self):
        real = self.t / 'elsewhere'; real.mkdir(); shutil.rmtree(self.dst); os.symlink(real, self.dst)
        self.refused('not a real directory'); self.assertEqual(os.listdir(real), [])

    def test_usage(self):
        r = subprocess.run([sys.executable, '-I', '-B', str(TOOL)], capture_output=True, text=True); self.assertEqual(r.returncode, 2)


class Runner(unittest.TestCase):
    def test_the_r12_runner_uses_the_helper_and_never_masks_copy_or_manifest_errors(self):
        s = RUNNER.read_text()
        self.assertIn('tools/copy-artifacts.py', s)
        self.assertNotIn("-exec cp -a {} $T/contracts/foundry/out/", s)
        b2 = s[s.index('== B2.'):s.index('== B3.')]
        self.assertNotIn('2>/dev/null', b2, 'no error suppression in the artifact fixture phase')
        self.assertIn('[FAIL] manifest', s); self.assertIn('BUILDINFO-', s)

    def test_the_r12_runner_checks_the_remaining_copies(self):
        s = RUNNER.read_text()
        self.assertIn('cp $R4/stack-tests/*.mjs $F/test/ || {', s)
        self.assertIn('cp $X/receipts/$key.out $log || {', s); self.assertIn('cp $log $X/receipts/$key.out || {', s)


if __name__ == '__main__':
    unittest.main()
