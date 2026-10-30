#!/usr/bin/env python3
"""post-run-audit.py tests (PREPARED; NOT run by Claude: jobs/root-post-run-audit.sh runs them, exact count 13, no skips).
A small synthetic run (a real git tree with base + regenerated commit, ignored forge artifacts, network runtime, a stack-test
copy, three node_modules closures checked by r12's REAL deps-identity.py) - nothing committed, nothing copied from the run."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
TOOL = HERE.parent / 'tools/post-run-audit.py'
R12 = pathlib.Path(os.environ['R12_STAGE'])                      # the frozen r12 stage (its deps-identity.py and line 191, read only)
sha = lambda b: hashlib.sha256(b).hexdigest()
GIT = ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
ARTS = {'out/A.sol/A.json': b'{"a":1}', 'out/B.sol/B.json': b'{"b":1}', 'out/B.sol/IB.json': b'{"ib":1}'}


class Case(unittest.TestCase):
    def setUp(self):
        self.t = t = pathlib.Path(tempfile.mkdtemp(prefix='pra-'))
        self.r12 = t / 'r12'; (self.r12 / 'tools').mkdir(parents=True); (self.r12 / 'stack-tests').mkdir()
        shutil.copyfile(R12 / 'tools/deps-identity.py', self.r12 / 'tools/deps-identity.py')
        (self.r12 / 'GENERATED.txt').write_text('# EXACT tracked paths a regeneration may change\ngen/bundle.mjs\n')
        (self.r12 / 'stack-tests/stack-a.test.mjs').write_text('// stack test\n')
        self.run_dir = t / 'run'; F = self.F = self.run_dir / 'trees/final'; F.mkdir(parents=True)
        g = lambda *a: subprocess.run(GIT + ['-C', str(F), *a], check=True, capture_output=True)
        g('init', '-q')
        (F / '.gitignore').write_text('node_modules/\ncontracts/foundry/out/\ncontracts/foundry/cache/\nrelay/network-runtime.bundle.mjs\nrelay/network-runtime.bundle.mjs.manifest.json\n')
        for d in ('', 'network/', 'relay/'):
            (F / d).mkdir(parents=True, exist_ok=True); (F / f'{d}package-lock.json').write_text('{"packages": {"": {}}}')
            (F / f'{d}node_modules').mkdir(); (F / f'{d}node_modules/.package-lock.json').write_text('{"packages": {}}')
        (F / 'src').mkdir(); (F / 'src/app.js').write_text('app\n'); (F / 'gen').mkdir(); (F / 'gen/bundle.mjs').write_text('v1\n')
        g('add', '-A'); g('commit', '-qm', 'base'); self.base = self.head()
        (F / 'gen/bundle.mjs').write_text('v2\n'); g('add', '-A'); g('commit', '-qm', 'regenerated'); self.cand = self.head()
        for rel, b in ARTS.items():
            p = F / 'contracts/foundry' / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b)
        man = ''.join(f'{sha(ARTS[r])}  {r}\n' for r in sorted(ARTS, key=str.encode))
        for n in ('ARTIFACTS-final.sha256', 'ARTIFACTS-consumers.sha256'):
            (self.run_dir / n).write_text(man)
        (self.run_dir / 'BUILDINFO-consumers.sha256').write_text(f'{sha(b"bi")}  out/build-info/0001.json\n')
        (self.run_dir / 'ARTIFACT-REUSE.txt').write_text('final copied from consumers (no build-info)\n')
        (F / 'relay/network-runtime.bundle.mjs').write_text('nr\n'); (F / 'relay/network-runtime.bundle.mjs.manifest.json').write_text('{}\n')
        (self.run_dir / 'gen-pass-2.ignored.sha256').write_text(f'{sha(b"nr" + bytes([10]))}\n{sha(b"{}" + bytes([10]))}\n')
        (F / 'test').mkdir(); shutil.copyfile(self.r12 / 'stack-tests/stack-a.test.mjs', F / 'test/stack-a.test.mjs')
        deps = []
        for d in ('.', 'network', 'relay'):
            nm = F / 'node_modules' if d == '.' else F / d / 'node_modules'
            r = subprocess.run([sys.executable, '-I', '-B', str(self.r12 / 'tools/deps-identity.py'), str(F / '.git'), self.base, d, str(nm)], capture_output=True, text=True, check=True)
            deps.append(f'{d} {json.loads(r.stdout)["treehash"]}')
        (self.r12 / 'DEPS.txt').write_text('\n'.join(deps) + '\n')
        self.log = t / 'job.out'; self.rc = t / 'job.rc'
        self.write_log([f'contracts/foundry/{r}' for r in sorted(ARTS)])
        (self.run_dir / 'RESULTS.tsv').write_text('consumers\ttest/x.test.mjs\tcomponent: 0 pass=3 fail=0 skip=0 todo=0 cancelled=0\tfinal: 0 pass=3 fail=0 skip=0 todo=0 cancelled=0\tok\n'
                                                  'STACK\ttest/stack-a.test.mjs\tfinal: 0 pass=2 fail=0 skip=0 todo=0 cancelled=0\n')
        (self.run_dir / 'receipts').mkdir(); (self.run_dir / 'receipts/k1.out').write_text('tap\n'); (self.run_dir / 'receipts/k1.rc').write_text('0\n')
        (self.run_dir / 'receipts/RECEIPTS.tsv').write_text(f'k1\tfinal\ttest/x.test.mjs\t{"0" * 64}\t{sha(b"tap" + bytes([10]))}\n')

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def head(self):
        return subprocess.run(['git', '-C', str(self.F), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()

    def write_log(self, flagged, extra_fail=None, finished=True):
        lines = ['== D. generated bundles in dependency order', '[FAIL] regeneration touched non-generated files: ' + flagged[0], *flagged[1:],
                 '[ok] regenerated candidate x'] + ([extra_fail] if extra_fail else []) + (['## summary: x', 'RESULT: FAIL'] if finished else [])
        self.log.write_text('\n'.join(lines) + '\n')
        if finished:
            self.rc.write_text('1\n')

    def call(self, mode='audit', cand=None):
        args = [sys.executable, '-I', '-B', str(TOOL), mode, str(self.run_dir), str(self.r12), str(self.F / '.git'), self.base, cand or self.cand, str(self.log)] + ([str(self.rc)] if mode == 'combine' else [])
        r = subprocess.run(args, capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout)

    def fails_with(self, needle, mode='audit', **kw):
        rc, j = self.call(mode, **kw)
        self.assertEqual(rc, 1, j); self.assertIn(needle, json.dumps(j))
        return j


class Audit(Case):
    def test_r12_line_191_rule_flags_every_listed_artifact_file(self):
        line = [l for l in (R12 / 'jobs/r12-build-validate.sh').read_text().splitlines() if l.startswith('bad=$(git -C $F status')][0]
        self.assertIn('contracts/foundry/out/ contracts/foundry/cache/', line)          # directory names only: the genuine bug
        cmd = (f"cd {self.F} && git status --porcelain=v1 --untracked-files=all --ignored -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules' "
               f"| sed 's/^...//' | grep -vxF -f <(grep -v '^#' {self.r12}/GENERATED.txt; printf '%s\\n' relay/network-runtime.bundle.mjs relay/network-runtime.bundle.mjs.manifest.json "
               f"contracts/foundry/out/ contracts/foundry/cache/ test/stack-a.test.mjs) || true")
        out = subprocess.run(['bash', '-c', cmd], capture_output=True, text=True).stdout.split()
        self.assertEqual(sorted(out), sorted(f'contracts/foundry/{r}' for r in ARTS))

    def test_the_corrected_audit_passes_the_exact_bound_state(self):
        rc, j = self.call(); self.assertEqual(rc, 0, j)
        self.assertEqual((j['listing']['artifact'], j['listing']['network-runtime'], j['listing']['stack-test']), (3, 2, 1))
        self.assertEqual(j['closure']['builtBy'], 'consumers'); self.assertIn('exactly the 3 bound artifacts', j['dTime']['dLine'])

    def test_an_extra_unexpected_file_fails(self):
        p = self.F / 'contracts/foundry/out/C.sol/C.json'; p.parent.mkdir(); p.write_text('{}'); self.fails_with('artifact: contracts/foundry/out/C.sol/C.json')
        p.unlink(); (self.F / 'notes.txt').write_text('x'); self.fails_with('unexpected: notes.txt')

    def test_a_tampered_or_missing_artifact_fails(self):
        (self.F / 'contracts/foundry/out/B.sol/B.json').write_bytes(b'{"b":2}'); self.fails_with('artifact: contracts/foundry/out/B.sol/B.json')
        (self.F / 'contracts/foundry/out/B.sol/B.json').unlink(); self.fails_with('bound fixtures missing')

    def test_cache_or_build_info_only_with_an_exact_record(self):
        c = self.F / 'contracts/foundry/cache/solidity-files-cache.json'; c.parent.mkdir(); c.write_text('{"c":1}')
        self.fails_with('cache: contracts/foundry/cache/solidity-files-cache.json')
        (self.run_dir / 'CACHE-final.sha256').write_text(f'{sha(c.read_bytes())}  cache/solidity-files-cache.json\n'); self.assertEqual(self.call()[0], 0)
        b = self.F / 'contracts/foundry/out/build-info/1.json'; b.parent.mkdir(); b.write_text('{"id":1}'); self.fails_with('buildinfo:')

    def test_an_arbitrary_source_change_fails(self):
        (self.F / 'src/app.js').write_text('changed\n'); self.fails_with('tracked change')
        g = lambda *a: subprocess.run(GIT + ['-C', str(self.F), *a], check=True, capture_output=True)
        g('checkout', '-q', '--', 'src/app.js'); g('checkout', '-q', '--detach', self.base)        # a "regeneration" on the base that ALSO
        (self.F / 'gen/bundle.mjs').write_text('v3\n'); (self.F / 'src/app.js').write_text('changed\n')   # changes a source file
        g('commit', '-qam', 'sneak'); self.fails_with('changes non-generated paths', cand=self.head())

    def test_symlinks_and_escapes_fail(self):
        outside = self.t / 'outside'; outside.mkdir(); shutil.copyfile(self.F / 'contracts/foundry/out/A.sol/A.json', outside / 'A.json')
        a = self.F / 'contracts/foundry/out/A.sol/A.json'; a.unlink(); os.symlink(outside / 'A.json', a); self.fails_with('symlink')
        a.unlink(); a.parent.rmdir(); os.symlink(outside, self.F / 'contracts/foundry/out/A.sol'); self.fails_with('symlink')

    def test_network_runtime_and_stack_copies_must_be_their_recorded_bytes(self):
        (self.F / 'relay/network-runtime.bundle.mjs').write_text('evil\n'); self.fails_with('network-runtime: relay/network-runtime.bundle.mjs')
        (self.F / 'relay/network-runtime.bundle.mjs').write_text('nr\n'); (self.F / 'test/stack-a.test.mjs').write_text('// changed\n')
        self.fails_with('stack-test: test/stack-a.test.mjs')

    def test_a_dependency_closure_change_fails(self):
        (self.F / 'relay/node_modules/injected.js').write_text('x'); self.fails_with('relay closure differs from DEPS.txt')

    def test_the_d_time_evidence_must_be_exactly_the_bound_artifacts(self):
        self.write_log([f'contracts/foundry/{r}' for r in sorted(ARTS)] + ['src/app.js']); self.fails_with('flagged other paths')

    def test_git_runs_without_optional_locks_and_writes_nothing(self):
        idx = self.F / '.git/index'; before = (idx.read_bytes(), os.stat(idx).st_mtime_ns)
        os.utime(self.F / 'src/app.js')                                            # a stat change git would normally refresh
        self.assertEqual(self.call()[0], 0); self.assertEqual((idx.read_bytes(), os.stat(idx).st_mtime_ns), before)


class Combine(Case):
    def test_combine_accepts_only_a_completed_run_whose_only_failure_is_the_d_line(self):
        rc, j = self.call('combine'); self.assertEqual(rc, 0, j); self.assertIn('PASS WITH THE CORRECTED D AUDIT', j['verdict'])
        self.write_log([f'contracts/foundry/{r}' for r in sorted(ARTS)], extra_fail='[FAIL] test/x.test.mjs 1 pass=0'); self.fails_with('other [FAIL] lines', 'combine')
        self.write_log([f'contracts/foundry/{r}' for r in sorted(ARTS)])
        (self.run_dir / 'receipts/k1.out').write_text('tampered\n'); self.fails_with('receipts missing or not clean', 'combine')

    def test_combine_never_passes_an_unfinished_or_unclean_run(self):
        self.rc.unlink(); self.write_log([f'contracts/foundry/{r}' for r in sorted(ARTS)], finished=False)
        rc, j = self.call('combine'); self.assertEqual(rc, 1); self.assertIn('INCOMPLETE', j['verdict'])
        self.write_log([f'contracts/foundry/{r}' for r in sorted(ARTS)])
        (self.run_dir / 'RESULTS.tsv').write_text('route\ttest/y.test.mjs\tcomponent: 0 pass=1 fail=0 skip=0 todo=0 cancelled=0\tfinal: 1 pass=0 fail=1 skip=0 todo=0 cancelled=0\tREGRESSION\n')
        self.fails_with('not every result row is clean', 'combine')


if __name__ == '__main__':
    unittest.main()
