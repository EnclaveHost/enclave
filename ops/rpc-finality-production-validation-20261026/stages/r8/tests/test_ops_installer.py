"""r6-ops-fixes: installer preflight-before-mutation, journaled commit, exact rollback/recover, activation guard. Offline, private root."""
import hashlib, importlib.util, json, os, pathlib, stat, sys, tempfile, unittest

TREE = pathlib.Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('iv_ops', TREE / 'install/install_verified.py'); IV = importlib.util.module_from_spec(spec); spec.loader.exec_module(IV)
sha = lambda b: hashlib.sha256(b).hexdigest()


class Installer(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='ops-install-'))
        IV.ROOT, IV.UID, IV.PROC = self.t / 'root', os.getuid(), self.t / 'proc'
        IV.PROC.mkdir(); (IV.ROOT / 'opt/x').mkdir(parents=True); os.chmod(IV.ROOT / 'opt', 0o755); os.chmod(IV.ROOT / 'opt/x', 0o755)
        os.chmod(IV.ROOT, 0o755)
        self.stage = self.t / 'stage'; self.stage.mkdir()
        self.new = {'a.py': b'NEW A\n', 'b.py': b'NEW B\n', 'c.py': b'NEW C\n'}
        for n, b in self.new.items():
            (self.stage / n).write_bytes(b)
        self.m = {'format': 'enclave-finality-install-manifest/v1', 'trees': [], 'files': [
            {'src': 'a.py', 'dest': '/opt/x/a.py', 'mode': '0755', 'sha256': sha(self.new['a.py'])},
            {'src': 'b.py', 'dest': '/opt/x/b.py', 'mode': '0644', 'sha256': sha(self.new['b.py'])},
            {'src': 'c.py', 'dest': '/opt/y/c.py', 'mode': '0644', 'sha256': sha(self.new['c.py'])}]}
        # the live install: a (mode 0700, odd on purpose: a restore must give it back) and b exist with old bytes; /opt/y is absent
        self.live('a.py', b'OLD A\n', 0o700); self.live('b.py', b'OLD B\n', 0o640)

    def live(self, n, b, mode):
        p = IV.ROOT / 'opt/x' / n; p.write_bytes(b); os.chmod(p, mode)

    def snapshot(self):
        out = {}
        for p in sorted(IV.ROOT.rglob('*')):
            st = os.lstat(p)
            out[str(p.relative_to(IV.ROOT))] = (stat.S_IMODE(st.st_mode), p.read_bytes() if p.is_file() else None)
        return out

    def no_mutation(self, before):
        after = self.snapshot()
        self.assertEqual(after, before)

    def test_late_source_refusal_changes_nothing(self):
        (self.stage / 'c.py').write_bytes(b'TAMPERED\n'); before = self.snapshot()
        with self.assertRaisesRegex(IV.Refused, 'c.py differs from its manifest sha'):
            IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        self.no_mutation(before)

    def test_late_destination_refusal_changes_nothing(self):
        for n in ('a.py', 'b.py'):
            (IV.ROOT / 'opt/x' / n).unlink()
        (IV.ROOT / 'opt/y').mkdir(); os.chmod(IV.ROOT / 'opt/y', 0o755); (IV.ROOT / 'opt/y/c.py').write_bytes(b'OTHER\n')
        before = self.snapshot()
        with self.assertRaisesRegex(IV.Refused, '/opt/y/c.py exists with other bytes'):
            IV.preflight(self.m, replace=False, include_wrapper=False, include_units=False, stage=self.stage)
        self.no_mutation(before)
        os.chmod(IV.ROOT / 'opt/y', 0o777)                                  # an unsafe parent is refused in preflight too
        with self.assertRaisesRegex(IV.Refused, 'not a real root-owned directory'):
            IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)

    def test_extra_file_in_a_tree_destination_is_refused_before_any_write(self):
        src = self.t / 'treesrc'; src.mkdir(); (src / 'index.js').write_bytes(b'x')
        self.m['trees'] = [{'src': str(src), 'dest': '/opt/x/deps', 'treeSha256': IV.tree_sha256(src), 'files': {'index.js': sha(b'x')}}]
        (IV.ROOT / 'opt/x/deps').mkdir(); os.chmod(IV.ROOT / 'opt/x/deps', 0o755); (IV.ROOT / 'opt/x/deps/planted.js').write_bytes(b'evil')
        before = self.snapshot()
        with self.assertRaisesRegex(IV.Refused, r'outside the qualified tree: \[.planted.js.\]'):
            IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        self.no_mutation(before)

    def test_injected_mid_commit_failure_restores_everything_exactly(self):
        before = self.snapshot()
        ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        with self.assertRaisesRegex(IV.Refused, 'rolled back'):
            IV.commit(ops, 'T1', fail_at=2)                                 # a and b replaced, then c (a new dir + file) fails
        after = {k: v for k, v in self.snapshot().items() if '.pre-T1' not in k and 'install-journal' not in k and k not in ('var', 'var/lib', 'var/lib/enclave-rpc')}
        self.assertEqual(after, before)
        self.assertFalse((IV.ROOT / 'opt/y').exists(), 'the created directory is removed')
        j = json.loads((IV.ROOT / 'var/lib/enclave-rpc/install-journal/T1.json').read_text())
        self.assertEqual(j['state'], 'rolled-back'); self.assertEqual(IV.open_journals(), [])

    def test_backup_is_a_copy_and_never_changes_the_live_mode(self):
        ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        self.assertEqual(IV.commit(ops, 'T2'), 'committed')
        a, keep = IV.ROOT / 'opt/x/a.py', IV.ROOT / 'var/lib/enclave-rpc/install-journal/T2.backup/opt/x/a.py'
        self.assertEqual(sorted(p.name for p in (IV.ROOT / 'opt/x').iterdir()), ['a.py', 'b.py'], 'r2: no backup beside the live file')
        self.assertEqual(stat.S_IMODE(os.lstat(keep.parent).st_mode), 0o700)
        self.assertEqual((a.read_bytes(), stat.S_IMODE(os.lstat(a).st_mode)), (self.new['a.py'], 0o755))
        self.assertEqual((keep.read_bytes(), stat.S_IMODE(os.lstat(keep).st_mode)), (b'OLD A\n', 0o600))
        self.assertNotEqual(os.lstat(a).st_ino, os.lstat(keep).st_ino, 'a copy, not a hard link')
        self.assertEqual(IV.preflight(self.m, replace=False, include_wrapper=False, include_units=False, stage=self.stage)[1],
                         [{'dest': e['dest'], 'result': 'identical'} for e in self.m['files']])

    def test_interrupted_commit_blocks_install_and_activation_until_recover_restores_exactly(self):
        before = self.snapshot()
        ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        self.assertEqual(IV.commit(ops, 'T3', crash_at=0), 'crashed (test)')   # a replaced, b and c not: a partial set
        (IV.ROOT / 'opt/x/.b.py.install-99999').write_bytes(b'half')            # another (dead) writer's temp
        self.assertEqual(len(IV.open_journals()), 1)
        with self.assertRaisesRegex(IV.Refused, 'journal is still open'):
            IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        with self.assertRaisesRegex(IV.Refused, 'journal is still open'):
            IV.installed_exactly(self.m)
        self.assertEqual(IV.recover()[0]['result'], 'rolled-back')
        after = {k: v for k, v in self.snapshot().items() if '.pre-T3' not in k and 'install-journal' not in k and k not in ('var', 'var/lib', 'var/lib/enclave-rpc')}
        self.assertEqual(after, before)
        IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)

    def test_activation_refuses_a_partial_or_altered_set(self):
        with self.assertRaisesRegex(IV.Refused, 'not installed as the qualified bytes'):
            IV.installed_exactly(self.m)                                         # nothing installed yet
        ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        IV.commit(ops, 'T4'); IV.installed_exactly(self.m)
        (IV.ROOT / 'opt/y/c.py').write_bytes(b'changed later\n')
        with self.assertRaisesRegex(IV.Refused, '/opt/y/c.py is not installed'):
            IV.installed_exactly(self.m)

    # ---- r2: a real multi-file TREE replacement; backups outside the tree; activation checks trees exactly -------------------
    def tree_setup(self):
        src = self.t / 'tsrc'; (src / 'lib').mkdir(parents=True)
        new = {'index.js': b'export * from "./lib/a.js"\n', 'lib/a.js': b'export const a = 2\n', 'lib/b.js': b'export const b = 2\n'}
        for r, b in new.items():
            (src / r).write_bytes(b)
        self.m['trees'] = [{'src': str(src), 'dest': '/opt/x/deps', 'treeSha256': IV.tree_sha256(src), 'files': {r: sha(b) for r, b in new.items()}}]
        dep = IV.ROOT / 'opt/x/deps'; (dep / 'lib').mkdir(parents=True); os.chmod(dep, 0o755); os.chmod(dep / 'lib', 0o755)
        self.old_tree = {'index.js': (b'old index\n', 0o640), 'lib/a.js': (b'old a\n', 0o600)}     # lib/b.js is new
        for r, (b, mode) in self.old_tree.items():
            (dep / r).write_bytes(b); os.chmod(dep / r, mode)
        (IV.ROOT / 'opt/x/unrelated.txt').write_bytes(b'not ours\n')
        return dep

    def test_tree_replacement_lands_exactly_and_a_repeated_preflight_is_clean(self):
        dep = self.tree_setup()
        ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        self.assertEqual(IV.commit(ops, 'T5'), 'committed')
        t = self.m['trees'][0]
        self.assertEqual(IV.tree_sha256(dep), t['treeSha256'])
        self.assertEqual(sorted(p.relative_to(dep).as_posix() for p in dep.rglob('*') if p.is_file()), sorted(t['files']))
        self.assertFalse([p for p in IV.ROOT.joinpath('opt').rglob('*') if '.pre-' in p.name or '.install-' in p.name])
        bk = IV.ROOT / 'var/lib/enclave-rpc/install-journal/T5.backup/opt/x/deps'
        for r, (b, _) in self.old_tree.items():
            self.assertEqual(((bk / r).read_bytes(), stat.S_IMODE(os.lstat(bk / r).st_mode)), (b, 0o600))
        j = json.loads((IV.ROOT / 'var/lib/enclave-rpc/install-journal/T5.json').read_text())
        self.assertEqual({o['dest']: o.get('prevMode') for o in j['ops'] if o['dest'].startswith('/opt/x/deps/')},
                         {'/opt/x/deps/index.js': 0o640, '/opt/x/deps/lib/a.js': 0o600, '/opt/x/deps/lib/b.js': None})
        again = IV.preflight(self.m, replace=False, include_wrapper=False, include_units=False, stage=self.stage)[1]
        self.assertEqual({x['result'] for x in again}, {'identical'})
        IV.installed_exactly(self.m)

    def test_tree_rollback_restores_originals_removes_only_its_files_and_keeps_backups_outside(self):
        dep = self.tree_setup(); before = self.snapshot()
        ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        last = len([o for o, _ in ops if o['action'] != 'identical']) - 1
        with self.assertRaisesRegex(IV.Refused, 'rolled back'):
            IV.commit(ops, 'T6', fail_at=last)                              # every file but the last tree file replaced, then failure
        after = {k: v for k, v in self.snapshot().items() if not k.startswith('var')}
        self.assertEqual(after, before)                                     # originals (bytes + modes), unrelated.txt kept, lib/b.js gone
        self.assertEqual((IV.ROOT / 'opt/x/unrelated.txt').read_bytes(), b'not ours\n')
        bk = IV.ROOT / 'var/lib/enclave-rpc/install-journal/T6.backup/opt/x/deps/index.js'
        self.assertEqual(bk.read_bytes(), b'old index\n')                 # the backup is retained, outside the tree

    def test_activation_refuses_a_tampered_installed_tree_file(self):
        dep = self.tree_setup(); ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        IV.commit(ops, 'T7'); IV.installed_exactly(self.m)
        (dep / 'lib/a.js').write_bytes(b'export const a = 666\n')
        with self.assertRaisesRegex(IV.Refused, r"is not the qualified tree \(changed: \['lib/a.js'\]\)"):
            IV.installed_exactly(self.m)

    def test_activation_refuses_an_extra_or_missing_tree_file(self):
        dep = self.tree_setup(); ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        IV.commit(ops, 'T8')
        (dep / 'lib/a.js.pre-20260101T000000Z').write_bytes(b'old a\n')    # what an r1-style backup beside the file would have left
        with self.assertRaisesRegex(IV.Refused, r"another file set.*extra \['lib/a.js.pre-20260101T000000Z'\]"):
            IV.installed_exactly(self.m)
        with self.assertRaisesRegex(IV.Refused, 'outside the qualified tree'):
            IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        (dep / 'lib/a.js.pre-20260101T000000Z').unlink(); (dep / 'lib/b.js').unlink()
        with self.assertRaisesRegex(IV.Refused, r"missing \['lib/b.js'\]"):
            IV.installed_exactly(self.m)

    def test_activation_refuses_a_writable_or_symlinked_tree_entry(self):
        dep = self.tree_setup(); ops, _ = IV.preflight(self.m, replace=True, include_wrapper=False, include_units=False, stage=self.stage)
        IV.commit(ops, 'T9')
        os.chmod(dep / 'index.js', 0o666)
        with self.assertRaisesRegex(IV.Refused, 'group/other writable'):
            IV.installed_exactly(self.m)
        os.chmod(dep / 'index.js', 0o644); (dep / 'lib/a.js').unlink(); os.symlink('b.js', dep / 'lib/a.js')
        with self.assertRaisesRegex(IV.Refused, 'symlink'):
            IV.installed_exactly(self.m)

    def test_qualification_needs_the_exact_r6_lines(self):
        q, rc = self.t / 'q.out', self.t / 'q.rc'; rc.write_text('0\n')
        q.write_text('## finality-r6 rc=0\n## r6 SHA256SUMS abc\n'); IV.qualified(q, rc, 'abc')
        q.write_text('## finality-r5 rc=0\n## r6 SHA256SUMS abc\n')
        with self.assertRaises(IV.Refused):
            IV.qualified(q, rc, 'abc')


if __name__ == '__main__':
    unittest.main(verbosity=2)
