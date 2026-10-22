#!/usr/bin/env python3
"""Local checks of the native fixture package (LOCAL ONLY; nothing native, remote or networked runs)."""
import base64, hashlib, importlib.util, json, pathlib, re, subprocess, sys, unittest
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent; S = PKG / 'stage'; W = next(p for p in PKG.parents if p.name == 'work')
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
WRAP = PKG / 'root/native-config-fixture.py'; DRV = PKG / 'native/ConfigNativeFixture.cs'
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


class Package(unittest.TestCase):
    def test_pins(self):
        self.assertEqual(sha(S / 'migrate-local-config.ps1'), sha(W / 'claude-resumed-20261022/config-persistence-r3/root/migrate-local-config.ps1'))
        self.assertEqual(sha(S / 'migrate-local-config.ps1'), 'd2ae8f6965176045186f1da9373778ee3daeb0b6d5144d3c46b2b2c2ad54739f')
        self.assertEqual(sha(PKG / 'native/FixtureJob.cs'), sha(W / 'bootstrap-process-control-20261022/native/FixtureJob.cs'))
        m = json.loads((S / 'fixture-manifest.json').read_text())['files']
        self.assertEqual(m, {p.name: sha(p) for p in S.iterdir() if p.is_file() and p.name != 'fixture-manifest.json'})
        self.assertIn('MigrateSha = "d2ae8f6965176045186f1da9373778ee3daeb0b6d5144d3c46b2b2c2ad54739f"', DRV.read_text())

    def test_wrapper_plan_is_offline_and_execute_needs_the_exact_manifest(self):
        r = subprocess.run(['python3', '-B', str(WRAP)], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr); plan = json.loads(r.stdout)
        self.assertEqual(set(plan['files']), {'FixtureJob.cs', 'ConfigNativeFixture.cs'} | {p.name for p in S.iterdir() if p.is_file()})
        r2 = subprocess.run(['python3', '-B', str(WRAP), '--execute', '0' * 64], capture_output=True, text=True, timeout=60)
        self.assertEqual(r2.returncode, 2); self.assertFalse((PKG / 'root/attempt.json').exists())

    def test_inline_fits_the_reviewed_transport(self):
        t = W / 'nucbox-tls-20261021/root-activate-reviewed.py'
        sp = importlib.util.spec_from_file_location('t', t); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
        wp = importlib.util.spec_from_file_location('w', WRAP); w = importlib.util.module_from_spec(wp); wp.loader.exec_module(w)
        text = w.inline('C:\\ProgramData\\Enclave\\staging\\config-native-fixture-0123456789ab')
        n = len(base64.b64encode((m.HEAD.replace('SECS', '520') + text).encode('utf-16-le')))
        self.assertLess(n, 7900, n)
        for f in ('FixtureJob.cs', 'ConfigNativeFixture.cs', 'fixture-manifest.json'): self.assertIn(f"\\{f}')) -ne '{w.FILES[f]}'", text)

    def test_scope_static(self):
        drv, wrap = DRV.read_text(), WRAP.read_text()
        inline = wrap[wrap.index('INLINE = r"""'):wrap.index('"""\n\n\ndef inline')]
        # a -ExecutionPolicy ARGUMENT (not the read-only Get-ExecutionPolicy cmdlet name)
        for src in (drv, inline): self.assertIsNone(re.search(r'(?<![A-Za-z])-ExecutionPolicy', src))
        for bad in ('Set-ExecutionPolicy', 'PSExecutionPolicyPreference', 'EncodedCommand', 'Bypass', 'AdjustTokenPrivileges', 'SeRestorePrivilege',
                    'schtasks', 'ScheduledTask', 'sc.exe', 'ServiceController'):
            self.assertNotIn(bad, drv, bad)
        # no production path: every ProgramData\Enclave reference is this fixture's own staging pattern
        for src in (drv, wrap):
            for m in re.finditer(r'ProgramData\\+Enclave\\+(\w+)', src): self.assertEqual(m.group(1), 'staging', src[m.start():m.start() + 80])
            refs = set(re.findall(r'staging\\+([a-z-]+)', src)); self.assertEqual(refs, {'config-native-fixture-'}, refs)
        for bad in ('Set-ExecutionPolicy', 'PSExecutionPolicyPreference', 'Bypass', '.ps1'):
            self.assertNotIn(bad, inline, bad)
        # powershell is started only with -File on the staged script, or -Command for the read-only policy list
        starts = re.findall(r'Run\(ps, (.{0,120})', drv)
        self.assertEqual(len(starts), 2, starts)
        self.assertTrue(any(s.startswith('a, PsMs)') for s in starts) and any('Get-ExecutionPolicy -List' in s for s in starts), starts)
        # ... where `a` (Migrate) is the -File invocation of the staged script and nothing else
        self.assertRegex(drv, r'string a = "-NoProfile -NonInteractive -File \\"" \+ Path\.Combine\(stage, "migrate-local-config\.ps1"\)')
        self.assertIn('"-NoProfile -NonInteractive -File \\"" + Path.Combine(stage, "migrate-local-config.ps1")', drv)
        self.assertRegex(drv, r'config-native-fixture-\[0-9a-f\]\{12\}')     # the stage pattern the driver accepts

    def test_compiler_unknown_never_allows_cleanup(self):
        wp = importlib.util.spec_from_file_location('fixture_wrapper', WRAP)
        w = importlib.util.module_from_spec(wp); wp.loader.exec_module(w)
        good = dict(exited=True, timedOut=False, complete=True, code=1)
        self.assertTrue(w.compiler_failed_cleanly(good))
        for changed in [{}, dict(good, exited=False), dict(good, timedOut=True),
                        dict(good, complete=False), dict(good, code=None),
                        dict(good, code=0), dict(good, code='1')]:
            with self.subTest(changed=changed): self.assertFalse(w.compiler_failed_cleanly(changed))

    def test_writers_are_stopped_before_link_cleanup(self):
        text = DRV.read_text()
        cleanup = text[text.index('    finally {', text.index('  public static int Main')):]
        self.assertLess(cleanup.index('job.StopChildren'), cleanup.index('RemoveLinks(links)'))
        self.assertIn('if (jc.ok)', cleanup)
        self.assertNotIn('ReadToEndAsync', text)

    def test_capture_is_bounded_while_draining(self):
        text = DRV.read_text()
        method = text[text.index('  static async Task<string> ReadBounded'):text.index('  class Child')]
        method = method.replace('static async', 'public static async', 1)
        code = ('using System; using System.IO; using System.Text; using System.Threading.Tasks; '
                'public static class CaptureFixture { const int Cap=65536; ' + method + '}')
        ps = '$code=@\'\n' + code + '\n\'@\nAdd-Type -TypeDefinition $code;'
        ps += '$short=[IO.StreamReader]::new([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes("abc")));'
        ps += '$long=[IO.StreamReader]::new([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes(("x"*131072))));'
        ps += '$a=[CaptureFixture]::ReadBounded($short).GetAwaiter().GetResult();'
        ps += '$b=[CaptureFixture]::ReadBounded($long).GetAwaiter().GetResult();'
        ps += '@{short=$a;length=$b.Length;tail=$b.Substring(65536);drained=$long.EndOfStream}|ConvertTo-Json -Compress'
        r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-Command', ps], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        got = json.loads(r.stdout.strip()); self.assertEqual(got['short'], 'abc')
        self.assertEqual(got['tail'], '\n<output truncated>')
        self.assertEqual(got['length'], 65536+len('\n<output truncated>')); self.assertTrue(got['drained'])

    def test_csharp5_check_is_not_vacuous(self):
        r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(PKG / 'tools/csparse.ps1'), str(HERE / 'neg/csharp6.cs')], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 1, r.stdout); self.assertEqual(r.stdout.count('CS8026'), 2, r.stdout)

    def test_csharp5_syntax(self):
        r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(PKG / 'tools/csparse.ps1'), str(DRV), str(PKG / 'native/FixtureJob.cs')], capture_output=True, text=True, timeout=120)
        print(r.stdout); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
