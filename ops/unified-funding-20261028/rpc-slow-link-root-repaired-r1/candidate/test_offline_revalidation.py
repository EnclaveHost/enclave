#!/usr/bin/python3 -I
"""Targeted content-inventory / RO-to-RW revalidation / per-operation identity / rollback-record regressions for
offline_mask.py.  An in-memory guest model stands in for debugfs (ls/stat/cat/ea_list/call); the real Debugfs.ea_list is
exercised through a FakeRun.  No native tool, image, export or production path is touched."""
import os, sys, types, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import offline_mask as om  # noqa: E402  (import is inert by contract)

STAMP = '20261030T120000Z-abcdef'
STAMPDIR = f'{om.KEEP}/{STAMP}'
WANTS = f'{om.ETC}/multi-user.target.wants'
LINKED = list(om.UNITS)[:4]                 # actual image: four absolute enablement links
T4 = {'atime': '0x1:0', 'crtime': '0x1:0', 'ctime': '0x1:0', 'mtime': '0x1:0'}
MODES = {'regular': 0o100000, 'directory': 0o040000, 'symlink': 0o120000}
BANNER = b'debugfs 1.47.1 (20-May-2024)\n'


class Guest:
    """tiny ext4 namespace model with debugfs semantics: ln/unlink never touch link counts"""
    def __init__(self):
        self.n, self.ino, self.dirs, self.calls, self.ea = 100, {}, {}, [], {}
        for d in ('/', '/etc', '/etc/systemd', om.ETC, '/var', '/var/lib', '/usr', '/usr/lib', '/usr/lib/systemd', om.USR,
                  WANTS):
            self.mk(d, 'directory', 0o755)
        self.mk('/lib', 'symlink', 0o777, target='usr/lib')
        for u in om.UNITS:
            self.mk(f'{om.ETC}/{u}', 'regular', 0o644, data=f'[Unit]\nDescription={u}\n'.encode())
        for u in LINKED:
            self.mk(f'{WANTS}/{u}', 'symlink', 0o777, target=f'{om.ETC}/{u}')
        self.mk(f'{om.USR}/other.service', 'regular', 0o644, data=b'[Unit]\nDescription=a\n')

    def mk(self, path, kind, perm, data=b'', target=None):
        self.n += 1
        self.ino[self.n] = {'kind': kind, 'perm': perm, 'data': data, 'target': target, 'times': dict(T4)}
        if kind == 'directory':
            self.dirs[path] = {}
        if path != '/':
            parent, name = path.rsplit('/', 1)
            self.dirs[parent or '/'][name] = self.n
        return self.n

    def lookup(self, path):
        parent, name = path.rsplit('/', 1)
        return self.dirs[parent or '/'][name]

    def size(self, i):
        x = self.ino[i]
        return len(x['data']) if x['kind'] == 'regular' else len(x['target']) if x['kind'] == 'symlink' else 4096

    def ls(self, d):
        return [{'inode': i, 'mode': MODES[self.ino[i]['kind']] | self.ino[i]['perm'], 'uid': 0, 'gid': 0, 'name': n,
                 'size': self.size(i)} for n, i in self.dirs[d].items()]

    def stat(self, path):
        i = self.lookup(path)
        x = self.ino[i]
        return {'inode': i, 'type': x['kind'], 'perm': x['perm'], 'flags': '0x80000', 'uid': 0, 'gid': 0,
                'size': self.size(i), 'links': 1, 'times': dict(x['times']), 'xattrNames': [], 'xattrSha256': None,
                'target': x['target']}

    def cat(self, path):
        return self.ino[self.lookup(path)]['data']

    def ea_list(self, path):
        if self.ea.get(path, b''):
            om.refuse('xattrs', f'{path}: ea_list not empty')
        return {'eaList': 'empty'}

    def call(self, req, write=False):
        self.calls.append(req)
        w = req.split(' ')
        if w[0] == 'mkdir':
            self.mk(w[1], 'directory', 0o755)
        elif w[0] == 'sif':
            self.ino[self.lookup(w[1])]['perm'] = int(w[3], 8) & 0o7777
        elif w[0] == 'ln':
            parent, name = w[2].rsplit('/', 1)
            self.dirs[parent][name] = int(w[1].strip('<>'))
        elif w[0] in ('unlink', 'rm'):
            parent, name = w[1].rsplit('/', 1)
            del self.dirs[parent][name]
        elif w[0] == 'symlink':
            self.mk(w[1], 'symlink', 0o777, target=w[2])
        return b''

    def replace(self, path, kind, **kw):
        self.dirs[path.rsplit('/', 1)[0]].pop(path.rsplit('/', 1)[1])
        return self.mk(path, kind, 0o777 if kind == 'symlink' else 0o644, **kw)


def writer():
    w = om.Writer.__new__(om.Writer)
    w.p, w.b, w.work, w.ops_done = {'stamp': STAMP, 'usrMerge': True}, {'maxInventoryEntries': 500}, '/nonexistent/w', []
    w.fx = types.SimpleNamespace(append_sync=lambda *a: None)
    return w


def prepare(g):
    """the read-only phase of Writer.execute, minus UNIT-PINS hash checks (fixture contents are not the pinned bytes)"""
    w = writer()
    base = om.inventory(g, om.guest_dirs(g, True), 500)
    anc, keep_exists, _ = w.ancestors(g)
    frag = {u: g.stat(f'{om.ETC}/{u}') for u in om.UNITS}
    links = [{'path': p, 'target': m['target'], 'meta': dict(m)} for p, m in sorted(base['entries'].items())
             if p.startswith(WANTS + '/')]
    _, links, dirmaps = w.rollback_inputs(g, frag, links, keep_exists)
    return types.SimpleNamespace(w=w, base=base, anc=anc, frag=frag, links=links, dirmaps=dirmaps,
                                 ops=om.build_ops(w.p, links, keep_exists))


def run_ops(g, s, until=None):
    model = s.w.revalidate(g, s.base, s.frag, s.links, s.anc, s.dirmaps)
    for op in s.ops:
        if until and until(op):
            return model
        s.w.guard(g, op, s.frag, s.links, model)
        s.w.apply(g, op, s.frag)
        s.w.settle(g, op, s.frag, model)
    return model


class FakeRun:
    def __init__(self, replies):
        self.replies = list(replies)

    def run(self, argv, timeout, limit):
        return self.replies.pop(0)


class RevalidationTests(unittest.TestCase):
    def test_positive_sequence_all_mutations_succeed(self):
        g = Guest()
        s = prepare(g)
        self.assertEqual(len(s.links), 4)
        self.assertTrue(all(sorted(l['stat']['times']) == list(om.TIMES) and l['xattrs'] for l in s.links))
        run_ops(g, s)
        self.assertEqual(len(s.w.ops_done), len(s.ops))
        for u in om.UNITS:
            self.assertEqual((g.stat(f'{om.ETC}/{u}')['type'], g.stat(f'{om.ETC}/{u}')['target']), ('symlink', '/dev/null'))
            self.assertEqual(g.stat(f'{STAMPDIR}/{u}'), s.frag[u])         # original inode bytes/metadata preserved
        self.assertEqual(g.dirs[WANTS], {})
        post = om.inventory(g, om.guest_dirs(g, True), 500)
        self.assertEqual(om.semantic_delta(s.base, post, s.links), [])
        archived = {u: g.stat(f'{STAMPDIR}/{u}') for u in om.UNITS}
        self.assertEqual(om.verify_archive(s.frag, archived, g.ls(STAMPDIR)), [])

    def test_every_regular_unit_file_hashed_and_same_size_drift_caught(self):
        g = Guest()
        s = prepare(g)
        self.assertIn(f'{om.USR}/other.service', s.base['hashes'])
        g.ino[g.lookup(f'{om.USR}/other.service')]['data'] = b'[Unit]\nDescription=b\n'      # same size
        post = om.inventory(g, om.guest_dirs(g, True), 500)
        self.assertEqual(post['entries'], s.base['entries'])
        self.assertTrue(any('content hash changed' in b for b in om.semantic_delta(s.base, post, s.links)))
        with self.assertRaisesRegex(om.Refusal, 'hashes changed'):
            s.w.revalidate(g, s.base, s.frag, s.links, s.anc, s.dirmaps)

    def test_ro_to_rw_boundary_drift(self):
        cases = {
            'enablement link metadata': lambda g: g.ino[g.lookup(f'{WANTS}/{LINKED[0]}')]['times'].update(ctime='0x2:0'),
            'ancestor metadata': lambda g: g.ino[g.lookup('/var/lib')]['times'].update(mtime='0x2:0'),
            'fragment inode metadata': lambda g: g.ino[g.lookup(f'{om.ETC}/{LINKED[1]}')]['times'].update(atime='0x2:0'),
            'directory entries changed': lambda g: g.mk('/var/lib/enclave-rpc-maint', 'directory', 0o755),
            'unexpected symlink': lambda g: g.ino[g.lookup('/lib')].update(target='usr/other'),
            'not empty': lambda g: g.ea.update({f'{om.ETC}/{LINKED[2]}': b'user.x'}),
        }
        for want, drift in cases.items():
            g = Guest()
            s = prepare(g)
            drift(g)
            with self.assertRaisesRegex(om.Refusal, want, msg=want):
                run_ops(g, s)
            self.assertFalse([c for c in g.calls if c.split(' ')[0] in ('mkdir', 'ln', 'unlink', 'symlink', 'rm')], want)

    def test_immediate_unlink_replacement_refused(self):
        u = LINKED[0]
        g = Guest()
        s = prepare(g)
        model = run_ops(g, s, until=lambda op: op['op'] == 'unlink')
        g.replace(f'{om.ETC}/{u}', 'regular', data=b'x')
        with self.assertRaisesRegex(om.Refusal, 'entries differ'):
            s.w.guard(g, s.ops[3], s.frag, s.links, model)
        self.assertNotIn(f'unlink {om.ETC}/{u}', g.calls)

    def test_archive_drift_before_unlink_refused(self):
        u = LINKED[0]
        g = Guest()
        s = prepare(g)
        model = run_ops(g, s, until=lambda op: op['op'] == 'unlink')
        g.replace(f'{STAMPDIR}/{u}', 'regular', data=b'x')
        with self.assertRaisesRegex(om.Refusal, 'does not reference the original inode'):
            s.w.guard(g, s.ops[3], s.frag, s.links, model)

    def test_unexpected_archive_occupant_refused(self):
        g = Guest()
        s = prepare(g)
        model = run_ops(g, s, until=lambda op: op['op'] == 'ln')
        g.mk(f'{STAMPDIR}/{LINKED[0]}', 'regular', 0o644, data=b'x')
        with self.assertRaisesRegex(om.Refusal, 'entries differ'):
            s.w.guard(g, s.ops[2], s.frag, s.links, model)

    def test_immediate_rm_replacement_refused(self):
        g = Guest()
        s = prepare(g)
        model = run_ops(g, s, until=lambda op: op['op'] == 'rm')
        rm = next(op for op in s.ops if op['op'] == 'rm')
        g.replace(rm['path'], 'symlink', target=f'{om.ETC}/{LINKED[0]}')          # same target, new inode
        with self.assertRaisesRegex(om.Refusal, 'entries differ'):
            s.w.guard(g, rm, s.frag, s.links, model)
        g = Guest()
        s = prepare(g)
        model = run_ops(g, s, until=lambda op: op['op'] == 'rm')
        g.ino[g.lookup(rm['path'])]['times'].update(ctime='0x3:0')                # same inode, changed metadata
        with self.assertRaisesRegex(om.Refusal, 'not the recorded enablement link'):
            s.w.guard(g, rm, s.frag, s.links, model)

    def test_own_step_with_extra_change_refused(self):
        g = Guest()
        s = prepare(g)
        orig = g.call

        def noisy(req, write=False):
            out = orig(req, write)
            if req.startswith('unlink '):
                g.dirs[om.ETC].pop(list(om.UNITS)[-1], None)          # an extra entry vanishes with our step
            return out
        g.call = noisy
        with self.assertRaisesRegex(om.Refusal, 'single expected change'):
            run_ops(g, s)

    def test_complete_link_and_fragment_timestamps_required(self):
        g = Guest()
        del g.ino[g.lookup(f'{WANTS}/{LINKED[0]}')]['times']['crtime']
        with self.assertRaisesRegex(om.Refusal, 'incomplete'):
            prepare(g)
        g = Guest()
        del g.ino[g.lookup(f'{om.ETC}/{LINKED[0]}')]['times']['atime']
        with self.assertRaisesRegex(om.Refusal, 'incomplete'):
            prepare(g)

    def test_native_ea_list_nonempty_and_rc0_error(self):
        def dbg(reply):
            return om.Debugfs(FakeRun([reply]), '/usr/bin/debugfs', '/nonexistent/root.ext4',
                              {'commandSeconds': 5, 'maxOutputBytes': 4096}, om.Deadline(60, lambda: 0.0), lambda *a: None)
        path = f'{om.ETC}/{LINKED[0]}'
        self.assertEqual(dbg((0, b'', BANNER)).ea_list(path)['eaList'], 'empty')
        with self.assertRaisesRegex(om.Refusal, 'not empty'):
            dbg((0, b'Extended attributes:\n  user.x (1) = "1"\n', BANNER)).ea_list(path)
        with self.assertRaisesRegex(om.Refusal, 'not empty'):
            dbg((0, b'\n', BANNER)).ea_list(path)
        with self.assertRaisesRegex(om.Refusal, 'stderr'):
            dbg((0, b'', BANNER + b'ea_list: Inode checksum does not match inode\n')).ea_list(path)
        with self.assertRaises(om.Refusal):
            dbg((1, b'', BANNER)).ea_list(path)


if __name__ == '__main__':
    unittest.main()
