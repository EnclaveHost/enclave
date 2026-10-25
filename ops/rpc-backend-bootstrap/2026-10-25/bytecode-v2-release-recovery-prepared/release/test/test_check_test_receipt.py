"""Adversarial tests of check_test_receipt.py and of the runner's pins (PREPARED; run by root: python3 -I -B test/test_check_test_receipt.py).
Only READS the recovery stage (control file, job script, product files) and root's REAL failed 2249 receipt kept in
bytecode-v2-recovery/evidence/. The passing transcript is SYNTHETIC, in the exact print format of
bytecode-v2-recovery/jobs/root-build-test-recovery.sh: it shows what the checker accepts, never evidence of a pass."""
import hashlib, importlib.util, os, pathlib, re, runpy, shutil, sys, tempfile, unittest
H = pathlib.Path(__file__).resolve().parents[1]
P = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
STAGE = P / 'finality-stage/bytecode-v2-recovery'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('ctr', H / 'check_test_receipt.py'); C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)
WANT = runpy.run_path(str(STAGE / 'control/disable_check.py'), run_name='t')['CONTROLS']
SHA = 'ab' * 32


def transcript(**o):
    """Lines the recovery job prints on a full pass (header lines abbreviated where the checker does not read them)."""
    L = ['[queue] START available=23070MiB required=18688MiB cap=1792MiB floor=16384MiB concurrentSmall=256MiB',
         '## toolchain rustc 1.96.0 (ac68faa20 2026-05-25) | cargo 1.96.0 (30a34c682 2026-05-25) | jobs=1',
         '== original v2 stage (read-only) and its failure', '[ok] STAGE-SHA256SUMS 051e8fcc',
         '== recovery inputs == original (product unchanged)', '[ok] lib.rs identical', '## recovery precheck rc=0',
         'inserted base-bytecode-check before base-challenger (6 deps)',
         '{"lockSha256": "%s", "closurePackages": 648, "registry": 632, "git": 16} problems=0' % o.get('lock', C.LOCK_SHA),
         '## RECOVERY: reusing a COPY of the ended original target for dependencies only (original untouched); the member test binary must still be REBUILT',
         '## [0] resolution only (no compile): cargo tree --locked', '## compiled graph: 367 packages, all inside the verified closure of 648',
         o.get('label', C.RECOVERY_LABEL), f'## patched test binary sha256 {SHA}']
    L += [f'test tests::{t} ... ok' for t in C.TESTS]
    L += ['test result: ok. 23 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.10s']
    for c in C.CONTROLS:
        L += [f'## [2] CONTROL {c} (one rule disabled)', f'## control {c} rc=101 failing: ' + ' '.join(sorted('tests::' + w for w in WANT[c][2])),
              f'## control {c} failed exactly as expected']
    L += ['## aggregate rc=0', '[memory-guard] exit=0 peakTreeRssMiB=700 minHostAvailableMiB=19000', '[memory-guard] at peak: x:1', '[queue] EXIT 0']
    return L


class Receipt(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = pathlib.Path(self.t.name)

    def tearDown(self):
        self.t.cleanup()

    def run_check(self, lines, rc='0\n', guard='[memory-guard] exit=0 peakTreeRssMiB=700 minHostAvailableMiB=19000\n', stage=STAGE):
        (self.d / 'o').write_text('\n'.join(lines) + '\n'); (self.d / 'r').write_text(rc)
        if guard is not None:
            (self.d / 'g').write_text(guard)
        elif (self.d / 'g').exists():
            (self.d / 'g').unlink()                                     # "missing guard" really is missing
        try:
            return C.check(str(self.d / 'o'), str(self.d / 'r'), str(self.d / 'g'), str(stage))
        except (OSError, KeyError, ValueError, IndexError) as e:     # the CLI maps these to a refusal
            return {'ok': False, 'failures': [repr(e)]}

    def refused(self, lines, why, **kw):
        r = self.run_check(lines, **kw)
        self.assertFalse(r['ok'], f'{why}: accepted')
        return r

    def test_a_full_pass_is_accepted_and_reports_the_test_binary(self):
        r = self.run_check(transcript()); self.assertTrue(r['ok'], r['failures']); self.assertEqual(r['patchedTestBinarySha256'], SHA)

    def test_the_real_original_oom_attempt_is_never_substituted(self):
        ev = STAGE / 'evidence'
        r = C.check(str(ev / 'root-bytecode-v2-native-2249.out'), str(ev / 'root-bytecode-v2-native-2249.rc'), str(ev / 'root-oom-scope-lines.txt'), str(STAGE))
        self.assertFalse(r['ok']); self.assertTrue(any('ORIGINAL failed attempt' in f for f in r['failures']), r['failures'])
        self.refused(transcript(label='## [1] patched: build + run all tests'), 'the original (non-recovery) job label')

    def test_outer_rc_guard_and_queue_records(self):
        for rc in ('143\n', '1\n', '', '98\n'):
            self.refused(transcript(), f'outer rc {rc!r}', rc=rc)
        for g in ('[memory-guard] exit=-15 peakTreeRssMiB=1700\n', '', 'no guard line\n'):
            self.refused(transcript(), f'guard {g!r}', guard=g)
        self.refused(transcript(), 'missing guard file', guard=None)
        L = transcript(); self.refused([l for l in L if not l.startswith('[queue] EXIT')], 'still running (no EXIT)')
        self.refused([l if l != '[queue] EXIT 0' else '[queue] EXIT -15' for l in L], 'killed by the queue')
        self.refused(L + ['[queue] EXIT 0'], 'two EXIT records')

    def test_aggregate_and_bad_markers(self):
        L = transcript()
        self.refused([l if l != '## aggregate rc=0' else '## aggregate rc=1' for l in L], 'aggregate rc=1')
        self.refused([l for l in L if l != '## aggregate rc=0'], 'no aggregate')
        i = L.index('## aggregate rc=0')
        self.refused(L[:i] + ['## aggregate rc=0'] + L[i:], 'two aggregates')
        self.refused(L[:i + 1] + ['## INVALID: cargo changed Cargo.lock', '## aggregate rc=1'] + L[i + 1:], 'INVALID after the aggregate')
        for bad in ('## test missing or not ok: raw_tag0_rows_follow_new_raw', '## patched FAILED (rc=101)', '[REFUSE] original evidence differs',
                    '## control padding: abnormal output'):
            self.refused(L[:i] + [bad] + L[i:], bad)

    def test_precheck_and_recovery_identity(self):
        L = transcript()
        self.refused([l if l != '## recovery precheck rc=0' else '## recovery precheck rc=1' for l in L], 'precheck rc=1')
        self.refused([l for l in L if l != '== recovery inputs == original (product unchanged)'], 'precheck section missing')
        self.refused([l for l in L if l != C.RECOVERY_LABEL], 'recovery label missing')

    def test_every_test_name_and_the_summary(self):
        L = transcript()
        for t in (C.TESTS[0], 'v2_scan_leaves_every_byte_of_mdbx_dat_unchanged', C.TESTS[-1]):
            self.refused([l for l in L if l != f'test tests::{t} ... ok'], f'{t} missing')
            self.refused([l if l != f'test tests::{t} ... ok' else f'test tests::{t} ... FAILED' for l in L], f'{t} FAILED')
            j = L.index(f'test tests::{t} ... ok'); self.refused(L[:j] + [L[j]] + L[j:], f'{t} twice')
        self.refused([re.sub(r'^test result: ok\. 23 passed', 'test result: ok. 22 passed', l) for l in L], '22 passed')
        self.refused([re.sub(r'^test result: ok\. 23 passed; 0 failed', 'test result: FAILED. 22 passed; 1 failed', l) for l in L], 'one failed')
        j = next(k for k, l in enumerate(L) if l.startswith('test result:')); self.refused(L[:j] + [L[j]] + L[j:], 'two summaries')
        self.refused(L[:j] + ['test tests::v2_extra_unpinned_test ... ignored'] + L[j:], 'an extra non-ok test line')

    def test_every_control_must_fail_exactly_its_pinned_set(self):
        for c in ('completeness', 'checkpoints', 'scanned', 'framing'):
            line = next(l for l in transcript() if l.startswith(f'## control {c} rc='))
            names = line.split('failing: ')[1].split()
            for bad in (line.replace('rc=101', 'rc=0'), line.rsplit(' ', 1)[0] if len(names) > 1 else line + ' tests::raw_tag0_rows_follow_new_raw',
                        line + ' tests::size_key_and_length_guards', f'## control {c} rc=101 failing: '):
                self.refused([bad if l == line else l for l in transcript()], f'{c}: {bad[-60:]}')
            self.refused([l for l in transcript() if l != f'## control {c} failed exactly as expected'], f'{c} not confirmed')
            self.refused([l for l in transcript() if not l.startswith(f'## control {c} ')], f'{c} absent')
            L = transcript(); j = L.index(line); self.refused(L[:j] + [line] + L[j:], f'{c} twice')

    def test_lock_closure_and_binary_lines(self):
        self.refused(transcript(lock='0' * 64), 'another lock')
        self.refused([l.replace('problems=0', 'problems=3') for l in transcript()], 'closure problems')
        self.refused([l for l in transcript() if not l.startswith('## compiled graph:')], 'no graph-inside-closure line')
        self.refused([l for l in transcript() if not l.startswith('## patched test binary sha256')], 'no patched test binary sha')

    def test_the_pinned_lists_must_equal_the_stage_job_and_control_file(self):
        s = self.d / 'stage'; (s / 'control').mkdir(parents=True); (s / 'jobs').mkdir()
        shutil.copy(STAGE / 'control/disable_check.py', s / 'control/'); job = (STAGE / C.JOB).read_text()
        for a, b, why in (('raw_tag0_rows_follow_new_raw ', '', 'job TESTS lacks a test'), ('for c in jumpbit padding', 'for c in padding jumpbit', 'control order differs')):
            self.assertEqual(job.count(a), 1, a); (s / C.JOB).write_text(job.replace(a, b)); self.refused(transcript(), why, stage=s)
        (s / C.JOB).write_text(job); self.assertTrue(self.run_check(transcript(), stage=s)['ok'], 'the unmodified copy is accepted')


class RunnerPins(unittest.TestCase):
    """The runner's pins are the reviewed recovery stage's files, and it never names the original stage/attempt as its input."""
    def test_runner_constants_equal_the_recovery_stage_files(self):
        sh = (H / 'root-release.sh').read_text()
        pin = lambda k: re.search(rf'^{k}=([0-9a-f]{{64}})', sh, re.M).group(1)
        sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
        self.assertEqual(pin('STAGE_SUMS_SHA'), sha(STAGE / 'inputs/STAGE-SHA256SUMS'))
        for k, f in (('LIB_SHA', 'crate/src/lib.rs'), ('MAIN_SHA', 'crate/src/main.rs'), ('CARGO_TOML_SHA', 'crate/Cargo.toml'),
                     ('CONTROL_SHA', 'control/disable_check.py'), ('TESTS_SHA', 'crate/src/tests.rs'), ('JOB_SHA', C.JOB), ('CLOSURE_SHA', 'inputs/closure-manifest.json')):
            self.assertEqual(pin(k), sha(STAGE / f), k)
        orig = P / 'finality-stage/bytecode-v2-validation'
        for k, f in (('LIB_SHA', 'crate/src/lib.rs'), ('MAIN_SHA', 'crate/src/main.rs'), ('CARGO_TOML_SHA', 'crate/Cargo.toml'), ('CONTROL_SHA', 'control/disable_check.py')):
            self.assertEqual(pin(k), sha(orig / f), f'{k}: the product is identical to the original v2 stage')
        self.assertIn('TEST_RUN=$P/logs/root-bytecode-v2-recovery-2259 ', sh)
        self.assertIn('. "$P/finality-stage/bytecode-v2-recovery/jobs/env.sh"', sh)
        self.assertNotRegex(sh, r'(?m)^[^#]*bytecode-v2-validation')

    def test_release_stage_pins_cover_runner_checker_and_tests(self):
        sums = (H / 'inputs/RELEASE-STAGE-SHA256SUMS').read_text().split('\n')
        names = sorted(l.split('  ', 1)[1] for l in sums if l)
        self.assertEqual(names, ['README.md', 'check_test_receipt.py', 'root-release.sh', 'test/test_check_test_receipt.py'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
