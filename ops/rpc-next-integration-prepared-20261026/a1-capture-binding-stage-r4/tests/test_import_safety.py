#!/usr/bin/env python3
"""a1_capture.py import-safety regression (capture-import-safety-stage; PREPARED, NOT run by Claude: jobs/root-import-safety-tests.sh
runs it in a1-capture-binding-stage/r4, exact count 7, no skips). The defect, from root's actual run (logs/root-reanchor-r5-0305.out): the r5 harness, an
ORDINARY Python caller with bytecode writing enabled, ran an initial capture; r2 loaded the bound l1_authority.py copy with
importlib's file loader, which wrote code/__pycache__/l1_authority.cpython-314.pyc into the capture; the recheck-capture's
verify of that initial then refused with file_set (correctly). r2's own runner used `python3 -I -B`, which hid it.
Here the CALLER is ordinary (sys.dont_write_bytecode False, no pycache prefix), restored after every test; the captures run
for real over the stage's stub fixtures (tests/test_a1_capture.py Case, unchanged); the strict file_set check is NOT relaxed."""
import hashlib, importlib.util, json, os, pathlib, shutil, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_a1_capture as T                                                        # noqa: E402  (the stage's fixtures, unchanged)
C = T.C
sha = lambda b: hashlib.sha256(b).hexdigest()


def bytecode_in(d):
    return sorted(os.path.relpath(os.path.join(r, x), d) for r, ds, fs in os.walk(d) for x in ds + fs
                  if x == '__pycache__' or x.endswith(('.pyc', '.pyo')))


class OrdinaryCaller(T.Case):
    """every test runs with the caller state of an ordinary `python3 x.py` (bytecode ON) and restores the caller's own state"""
    def setUp(self):
        super().setUp()
        saved = (sys.dont_write_bytecode, sys.pycache_prefix)
        self.addCleanup(lambda: (setattr(sys, 'dont_write_bytecode', saved[0]), setattr(sys, 'pycache_prefix', saved[1])))
        sys.dont_write_bytecode, sys.pycache_prefix = False, None

    def assert_clean(self, out):
        d = out / 'capture'
        self.assertEqual(bytecode_in(out), [], 'no bytecode cache anywhere in the published capture')
        rec = json.loads((d / 'capture.json').read_bytes())
        present = {os.path.relpath(os.path.join(r, f), d) for r, _, fs in os.walk(d) for f in fs}
        self.assertEqual(present, set(rec['files']) | C.RECORDS, 'the published file set is exactly the bound files + records')

    def caller_unchanged(self):
        self.assertIs(sys.dont_write_bytecode, False, 'the capture library never flips the caller global')
        self.assertIsNone(sys.pycache_prefix)


class Control(OrdinaryCaller):
    def test_this_caller_really_writes_bytecode_through_the_r2_file_loader(self):
        """negative control: the r2 loader, verbatim, under THIS caller state, leaves a .pyc beside the loaded file, so the
        clean results below are meaningful (they would be vacuous under -B)"""
        d = pathlib.Path(tempfile.mkdtemp(prefix='pyc-control-', dir=self.t)); p = d / 'l1_authority.py'
        shutil.copyfile(self.src.l1_authority, p)
        spec = importlib.util.spec_from_file_location('l1_authority_copy', p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        self.assertTrue(any(x.endswith('.pyc') for x in bytecode_in(d)), f'expected the r2 loader to write a .pyc: {bytecode_in(d)}')


class Capture(OrdinaryCaller):
    def test_initial_capture_writes_no_bytecode_and_verifies(self):
        ok, res, out = self.cap(); self.assertTrue(ok, res)
        self.assert_clean(out); self.assertEqual(self.verify(out)['mode'], 'initial'); self.caller_unchanged()

    def test_recheck_capture_of_a_fresh_initial_verifies_both(self):
        """the exact r5 failure path: initial capture, then recheck-capture verifying that initial, then the consumer's verify"""
        iout, isha = self.initial_capture(); self.assert_clean(iout)
        ok, res, rout = self.cap('recheck-capture', initial=iout); self.assertTrue(ok, res)
        self.assert_clean(rout); self.assert_clean(iout)
        s = self.verify(rout, initial_out=iout, expected_initial_capture_sha256=isha)
        self.assertEqual(s['initialCapture']['captureSha256'], isha); self.caller_unchanged()

    def test_plain_recheck_capture_writes_no_bytecode_and_verifies(self):
        ok, res, out = self.cap('recheck'); self.assertTrue(ok, res)
        self.assert_clean(out); self.assertEqual(self.verify(out)['mode'], 'recheck'); self.caller_unchanged()

    def test_a_caller_that_disabled_bytecode_keeps_its_own_state(self):
        sys.dont_write_bytecode = True
        ok, res, out = self.cap(); self.assertTrue(ok, res); self.assert_clean(out)
        self.assertIs(sys.dont_write_bytecode, True, 'the caller state is never changed, in either direction')


class Strict(OrdinaryCaller):
    def test_a_planted_bytecode_cache_is_still_refused_by_file_set(self):
        """the fix removes the cause; it does not whitelist caches: a trusted-looking .pyc in code/ still refuses"""
        ok, res, out = self.cap(); self.assertTrue(ok, res)
        c = out / 'capture/code/__pycache__'; os.mkdir(c, 0o700)
        f = c / f'l1_authority.{sys.implementation.cache_tag}.pyc'; f.write_bytes(b'\0' * 16); os.chmod(f, 0o400)
        self.refused('file_set', self.verify, out)

    def test_the_pinned_loader_keeps_module_semantics_and_refuses_unpinned_bytes(self):
        b = self.src.l1_authority.read_bytes(); d = pathlib.Path(tempfile.mkdtemp(prefix='pinned-', dir=self.t)); p = d / 'l1_authority.py'
        p.write_bytes(b)
        L = C.load_pinned(b, p, 'l1_authority_copy', sha(b))
        self.assertEqual((L.__name__, L.__file__, L.__spec__.origin), ('l1_authority_copy', str(p), str(p)), 'not __main__: the run guard stays off')
        self.assertTrue(callable(L.load_config) and callable(L.status))
        self.assertNotIn('l1_authority_copy', sys.modules, 'not registered in sys.modules (as the r2/r3 file loader)')
        self.assertEqual(bytecode_in(d), [], 'nothing written beside the loaded copy')
        p.write_bytes(b + b'\n# changed on disk after hashing\n')
        self.assertFalse(hasattr(C.load_pinned(b, p, 'x', sha(b)), 'changed'), 'executes the verified bytes, never a re-read of the path')
        self.refused('l1_authority_pin', C.load_pinned, b + b'\n', p, 'x', sha(b))


if __name__ == '__main__':
    unittest.main()
