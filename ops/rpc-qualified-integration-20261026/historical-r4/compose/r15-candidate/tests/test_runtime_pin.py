#!/usr/bin/env python3
"""runtime-pin: finality_state's node runtime identity (PREPARED; NOT run by Claude: jobs/root-runtime-pin-tests.sh, exact count 10).
REAL: the capture module's accepted identities (production Pins(): host node 22 self-contained, guest Ubuntu node 18 + libnode), the host
node's own process.report sharedObjects, and finality_state's checks. A split guest node is emulated by a launcher stand-in that reports
its mapped shared objects (the probe's exact output contract) and a libnode stand-in file, both pinned by sha for the test only."""
import hashlib, importlib.util, json, os, pathlib, shutil, sys, tempfile, types, unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))
import finality_state as FS                                                     # noqa: E402
FS.OWNER = os.getuid()
NODE = os.path.realpath(os.environ['FINALITY_NODE'])
_s = importlib.util.spec_from_file_location('a1_capture_closure', os.environ['CAPTURE_MODULE']); C = importlib.util.module_from_spec(_s); _s.loader.exec_module(C)
sha = lambda b: hashlib.sha256(b).hexdigest()
HOST22, GUEST18 = '7af789e55afc0975d66bb19ccbc5a3b60c4b838f61d1ec10a117832ba70baaf9', 'f3f93db342d5ac5bb61656d0599a603a73779e98befd9342171e550002725f4d'


def stand_in_r(pins):
    """the harness surface node_profile reads (load_capture, A1_CAPTURE_TEST_PINS, Refused)"""
    return types.SimpleNamespace(load_capture=lambda: C, A1_CAPTURE_TEST_PINS=(lambda: pins) if pins is not None else None, Refused=C.Refused)


class RuntimePin(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.t, True)
        self.lib = self.t / 'libnode.so.109'; self.lib.write_bytes(b'stand-in libnode engine'); os.chmod(self.lib, 0o644)
        self.profile = {'libnode': {'path': str(self.lib), 'sha256': sha(self.lib.read_bytes())}}

    def launcher(self, reports):
        """a split-node launcher stand-in: for the probe it prints exactly what process.report sharedObjects would list"""
        p = self.t / f'node-{len(list(self.t.iterdir()))}'; p.write_text(f'#!/bin/sh\nprintf %s {json.dumps(json.dumps(reports))}\n'); p.chmod(0o755)
        return str(p)

    def code(self, fn, *a, **k):
        with self.assertRaises(FS.Refused) as cm:
            fn(*a, **k)
        return cm.exception.code

    def test_real_accepted_profiles_from_the_capture_module(self):
        pins = C.Pins(); R = stand_in_r(None)
        self.assertNotIn('libnode', FS.node_profile(R, HOST22))                         # host node 22: self-contained
        g = FS.node_profile(R, GUEST18)['libnode']
        self.assertEqual((g['path'], g['sha256']), ('/usr/lib/x86_64-linux-gnu/libnode.so.109',
                                                    'ce7cb9cd408c412090c86dada332aaa82650679ed1b32527768c8dbd8c4028d0'))
        self.assertEqual(self.code(FS.node_profile, R, '00' * 32), 'node_pin'); self.assertIn(HOST22, pins.node_accepted)

    def test_host_node_reports_no_libnode_and_is_accepted_self_contained(self):
        fd = os.open(NODE, os.O_RDONLY)
        try:
            self.assertEqual(FS.mapped_libnode(f'/proc/self/fd/{fd}', (fd,)), [])          # REAL process.report of this node
            self.assertIsNone(FS.libnode_identity({}, f'/proc/self/fd/{fd}', (fd,)))
        finally:
            os.close(fd)

    def test_split_guest_profile_accepted(self):
        lib = FS.libnode_identity(self.profile, self.launcher([str(self.lib)]))
        self.assertEqual((lib['path'], lib['sha256']), (str(self.lib), self.profile['libnode']['sha256'])); FS.libnode_unchanged(lib)

    def test_wrong_libnode_bytes_refuse(self):
        self.lib.write_bytes(b'another engine'); self.assertEqual(self.code(FS.libnode_identity, self.profile, self.launcher([str(self.lib)])), 'node_lib')

    def test_missing_mapping_refuses(self):
        self.assertEqual(self.code(FS.libnode_identity, self.profile, self.launcher([])), 'node_lib')

    def test_duplicate_libnode_mappings_refuse(self):
        other = self.t / 'libnode.so.108'; other.write_bytes(b'x')
        self.assertEqual(self.code(FS.libnode_identity, self.profile, self.launcher([str(self.lib), str(other)])), 'node_lib')

    def test_unapproved_libnode_and_libnode_on_a_self_contained_profile_refuse(self):
        other = self.t / 'libnode.so.999'; other.write_bytes(self.lib.read_bytes())       # same bytes, unapproved path
        self.assertEqual(self.code(FS.libnode_identity, self.profile, self.launcher([str(other)])), 'node_lib')
        self.assertEqual(self.code(FS.libnode_identity, {}, self.launcher([str(self.lib)])), 'node_lib')

    def test_writable_libnode_refuses(self):
        os.chmod(self.lib, 0o666); self.assertEqual(self.code(FS.libnode_identity, self.profile, self.launcher([str(self.lib)])), 'node_lib')

    def test_libnode_replaced_during_the_decision_refuses(self):
        lib = FS.libnode_identity(self.profile, self.launcher([str(self.lib)]))
        new = self.t / 'new'; new.write_bytes(self.lib.read_bytes()); os.replace(new, self.lib)   # same bytes, another file object
        self.assertEqual(self.code(FS.libnode_unchanged, lib), 'node_lib_changed')

    def test_finality_core_report_must_match(self):
        lib = FS.libnode_identity(self.profile, self.launcher([str(self.lib)]))
        FS.core_libs_ok(lib, [str(self.lib)]); FS.core_libs_ok(None, [])
        for l, libs in ((lib, []), (lib, ['/x/libnode.so.1']), (None, [str(self.lib)]), (lib, 'not-a-list')):
            self.assertEqual(self.code(FS.core_libs_ok, l, libs), 'node_lib')


if __name__ == '__main__':
    unittest.main()
