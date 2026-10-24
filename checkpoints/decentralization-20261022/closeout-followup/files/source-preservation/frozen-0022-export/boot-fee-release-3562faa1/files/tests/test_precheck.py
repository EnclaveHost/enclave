"""precheck.py against real commits on a SHARED BARE CLONE of H's repo (tests/.fixture-repo, gitignored): H's repo and working tree
are never written. Fixture commits are made with git plumbing on top of the real 9f6d37bd."""
import copy, os, subprocess, sys, unittest
from pathlib import Path
HERE = Path(__file__).resolve().parent; sys.path.insert(0, str(HERE.parent))
import precheck as pc
H = HERE.parent.parent / 'custody-boot-registration-20261023' / 'repo'
FX = HERE / '.fixture-repo'
ENV = {**os.environ, 'GIT_AUTHOR_NAME': 'fixture', 'GIT_AUTHOR_EMAIL': 'fixture@invalid', 'GIT_COMMITTER_NAME': 'fixture',
       'GIT_COMMITTER_EMAIL': 'fixture@invalid', 'GIT_OPTIONAL_LOCKS': '0'}

def g(*a, inp=None, env=None):
    return subprocess.run(['git', '-C', str(FX), *a], input=inp, capture_output=True, check=True, env={**ENV, **(env or {})}).stdout

def commit(parents, changes, msg='fixture'):
    """changes: {path: bytes} applied to the FIRST parent's tree -> new commit hash."""
    idx = FX / f'idx-{os.getpid()}'
    try:
        e = {'GIT_INDEX_FILE': str(idx)}
        g('read-tree', parents[0], env=e)
        for p, b in changes.items():
            blob = g('hash-object', '-w', '--stdin', inp=b).decode().strip()
            g('update-index', '--add', '--cacheinfo', f'100644,{blob},{p}', env=e)
        tree = g('write-tree', env=e).decode().strip()
    finally:
        idx.unlink(missing_ok=True)
    return g('commit-tree', tree, *sum((['-p', p] for p in parents), []), '-m', msg).decode().strip()

def applies(patch, c, zero=False):
    """the exported patch applied to 9f6d37bd's tree reproduces EXACTLY the commit's tree (the parent anchor)"""
    idx = FX / f'idx-a-{os.getpid()}'
    try:
        e = {'GIT_INDEX_FILE': str(idx)}; g('read-tree', pc.PARENT, env=e)
        subprocess.run(['git', '-C', str(FX), 'apply', '--cached', *(['--unidiff-zero'] if zero else []), '-'], input=patch, check=True, capture_output=True, env={**ENV, **e})
        return g('write-tree', env=e).decode().strip() == g('rev-parse', c + '^{tree}').decode().strip()
    finally: idx.unlink(missing_ok=True)

def appr(c, gsup='UNCHANGED', tests='test/boot-price.test.mjs'): return f'commit {c}\ngsup {gsup}\ntests {tests}\n'

class Precheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not FX.exists(): subprocess.run(['git', 'clone', '-q', '--shared', '--bare', str(H), str(FX)], check=True, env=ENV)
        cls.sup = g('show', f'{pc.PARENT}:supervisor.js'); cls.gsup = g('show', f'{pc.PARENT}:metal/guest/gsup.mjs')
        cls.T = b'// fixture test\n'
        cls.good = commit([pc.PARENT], {'supervisor.js': cls.sup + b'// pending-GPU guard (fixture)\n', 'test/boot-price.test.mjs': cls.T})
    def check(self, text): return pc.check(FX, text)

    def test_good_child_passes_with_parent_anchored_patch(self):
        rec, patch, form = self.check(appr(self.good))
        self.assertEqual((rec['parent'], rec['gsupReviewed'], rec['imageFiles']), (pc.PARENT, False, ['/app/supervisor.js']))
        self.assertEqual(rec['delta'], ['supervisor.js', 'test/boot-price.test.mjs']); self.assertEqual(form, 'full context')
        self.assertIn(self.good.encode(), patch.splitlines()[0]); self.assertFalse(pc.has_old(patch))
        self.assertLess(len(patch), 4096)                                           # a patch, never the parent tree
        self.assertTrue(applies(patch, self.good))
        self.assertTrue(all(l.rstrip().endswith(b'@@') for l in patch.splitlines() if l.startswith(b'@@')))   # no function context
    def test_gsup_needs_explicit_review_both_ways(self):
        c = commit([pc.PARENT], {'supervisor.js': self.sup + b'//x\n', 'metal/guest/gsup.mjs': self.gsup + b'//expect\n', 'test/boot-price.test.mjs': self.T})
        with self.assertRaisesRegex(pc.Refused, 'is not exactly'): self.check(appr(c))
        rec, _, _ = self.check(appr(c, gsup='REVIEWED')); self.assertEqual(rec['imageFiles'], ['/app/supervisor.js', '/opt/metal/gsup.mjs'])
        with self.assertRaisesRegex(pc.Refused, 'is not exactly'): self.check(appr(self.good, gsup='REVIEWED'))   # REVIEWED but unchanged
    def test_any_other_file_refuses(self):
        for p in ['metal/guest/agent.mjs', 'client/lease-executor-client.mjs', 'verifier/snp.mjs', 'metal/overlay-control-image.py', 'test-helpers.mjs']:
            c = commit([pc.PARENT], {'supervisor.js': self.sup + b'//x\n', 'test/boot-price.test.mjs': self.T, p: b'x\n'})
            with self.assertRaises(pc.Refused, msg=p): self.check(appr(c))
    def test_tests_must_be_exactly_the_approved_ones(self):
        with self.assertRaisesRegex(pc.Refused, 'is not exactly'): self.check(appr(self.good, tests='NONE'))
        with self.assertRaisesRegex(pc.Refused, 'is not exactly'): self.check(appr(self.good, tests='test/boot-price.test.mjs test/other.test.mjs'))
        c = commit([pc.PARENT], {'test/boot-price.test.mjs': self.T})            # supervisor.js untouched
        with self.assertRaisesRegex(pc.Refused, 'is not exactly'): self.check(appr(c))
    def test_parent_must_be_exactly_9f6d37bd(self):
        grandchild = commit([self.good], {'supervisor.js': self.sup + b'//y\n'})
        merge = commit([pc.PARENT, g('rev-parse', '9f6d37bd^').decode().strip()], {'supervisor.js': self.sup + b'//z\n', 'test/boot-price.test.mjs': self.T})
        for c in [grandchild, merge, pc.PARENT]:
            with self.assertRaisesRegex(pc.Refused, 'parents'): self.check(appr(c))
        with self.assertRaisesRegex(pc.Refused, 'not in H'): self.check(appr('0' * 40))
    def test_literal_context_falls_back_to_zero_context_and_a_changed_line_refuses(self):
        old = pc.OLD; i = self.sup.find(old) if old in self.sup else self.sup.lower().find(old.lower())
        self.assertGreater(i, 0)                                                   # the parent supervisor.js carries it once
        eol = self.sup.index(b'\n', i) + 1
        near = commit([pc.PARENT], {'supervisor.js': self.sup[:eol] + b'// next to it\n' + self.sup[eol:], 'test/boot-price.test.mjs': self.T})
        rec, patch, form = self.check(appr(near)); self.assertTrue(form.startswith('zero context')); self.assertFalse(pc.has_old(patch))
        self.assertTrue(applies(patch, near, zero=True))
        on = commit([pc.PARENT], {'supervisor.js': self.sup + b'// ' + old + b'\n', 'test/boot-price.test.mjs': self.T})
        with self.assertRaisesRegex(pc.Refused, 'changed line'): self.check(appr(on))
    def test_approval_format(self):
        for t in [f'commit {self.good}\ngsup UNCHANGED\n', appr(self.good)[:-1], appr(self.good.upper()), appr(self.good, gsup='yes'),
                  appr(self.good, tests='test/../supervisor.js'), appr(self.good, tests='lib/x.mjs'), appr(self.good, tests=''),
                  appr(self.good, tests='test/a.mjs test/a.mjs'), appr(self.good) + 'extra\n']:
            with self.assertRaises(pc.Refused, msg=repr(t)): self.check(t)

if __name__ == '__main__': unittest.main()
