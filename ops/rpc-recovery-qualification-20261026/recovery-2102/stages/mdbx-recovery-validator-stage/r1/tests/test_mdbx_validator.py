#!/usr/bin/env python3
"""mdbx-recovery-validator-stage/r1 offline tests (PREPARED; NOT run by Claude). Needs jobs/tests.sh's own user+mount+net namespace
(unshare -Urnm): every database is exposed through a REAL read-only bind mount (mount --bind + remount,bind,ro), so libmdbx's
EROFS -> without-lck path is the one exercised. Small fixtures only (built with the official libmdbx API); no device, no network.
MDBX_BIN = the job's build dir (mdbx_chk, mk_fixture); MDBX_CHK_SHA256 = the built mdbx_chk's sha256."""
import json, os, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
sys.path.insert(0, f"{STAGE}/src")
sys.dont_write_bytecode = True
import mdbx_check as M  # noqa: E402

BIN = os.environ.get("MDBX_BIN", "")
CHK, MK = f"{BIN}/mdbx_chk", f"{BIN}/mk_fixture"
CHK_SHA = os.environ.get("MDBX_CHK_SHA256", "")
PAGE = 4096


def ro_mount(src, dst):
    os.makedirs(dst, exist_ok=True)
    subprocess.run(["mount", "--bind", src, dst], check=True, capture_output=True)
    subprocess.run(["mount", "-o", "remount,bind,ro", dst], check=True, capture_output=True)
    assert os.statvfs(dst).f_flag & os.ST_RDONLY, dst


def corrupt(path, offset, length):
    with open(path, "r+b") as f:
        f.seek(offset); f.write(b"\xa5" * length)


class Validator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.access(CHK, os.X_OK) and os.access(MK, os.X_OK) and len(CHK_SHA) == 64, "MDBX_BIN/MDBX_CHK_SHA256 from jobs/tests.sh"
        cls.tmp = tempfile.mkdtemp(prefix="mdbxv", dir=os.environ.get("TEST_TMP"))
        cls.mounts = []
        src = f"{cls.tmp}/src/pristine"; os.makedirs(src)
        subprocess.run([MK, src, "20000"], check=True, capture_output=True)
        with open(f"{src}/database.version", "w") as f:
            f.write("2")                                            # reth DB_VERSION file, as in a reth db/ directory
        for name in ("bad-meta", "bad-tree", "truncated"):
            shutil.copytree(src, f"{cls.tmp}/src/{name}")
        dat = lambda n: f"{cls.tmp}/src/{n}/mdbx.dat"
        corrupt(dat("bad-meta"), 0, 3 * PAGE)                       # all three meta pages
        corrupt(dat("bad-tree"), 3 * PAGE, 32 * PAGE)               # the first data (B-tree) pages after the metas
        os.truncate(dat("truncated"), 16 * PAGE)
        cls.size = os.path.getsize(dat("pristine"))
        assert cls.size > 64 * PAGE, cls.size
        for name in ("pristine", "bad-meta", "bad-tree", "truncated"):
            ro_mount(f"{cls.tmp}/src/{name}", f"{cls.tmp}/ro/{name}"); cls.mounts.append(f"{cls.tmp}/ro/{name}")
        cls.ident = {n: M.identity(f"{cls.tmp}/src/{n}") for n in ("pristine", "bad-meta", "bad-tree", "truncated")}

    @classmethod
    def tearDownClass(cls):
        for m in reversed(cls.mounts):
            subprocess.run(["umount", m], capture_output=True)
        shutil.rmtree(cls.tmp, True)

    def tearDown(self):                                             # nothing may ever change the databases (incl. lock files)
        for n, ident in self.ident.items():
            self.assertEqual(M.identity(f"{self.tmp}/src/{n}"), ident, n)

    def chk(self, *args):
        return subprocess.run([CHK, *args], capture_output=True, text=True, timeout=300)

    def wrap(self, db, *extra):
        out = f"{self.tmp}/report-{len(os.listdir(self.tmp))}.json"
        rc = M.main(["mdbx_check.py", "--chk", CHK, "--chk-sha256", CHK_SHA, "--db-dir", db, "--out", out, *extra])
        return rc, (json.load(open(out)) if os.path.exists(out) else None)

    def test_the_build_is_the_pinned_libmdbx(self):
        r = self.chk("-V")
        self.assertIn(M.LIBMDBX_DESCRIBE, r.stdout + r.stderr)

    def test_the_pristine_fixture_is_clean_readonly_and_unchanged(self):
        rc, rep = self.wrap(f"{self.tmp}/ro/pristine")
        self.assertEqual(rc, 0, rep)
        self.assertEqual((rep["rc"], rep["structurallyClean"], rep["unchangedIdentity"], rep["preflight"]["databaseVersion"]), (0, True, True, "2"))
        self.assertNotIn("-w", rep["argv"]); self.assertEqual(rep["argv"][1:], ["-v", f"{self.tmp}/ro/pristine"])

    def test_each_meta_page_checks_readonly_and_the_newest_is_clean(self):
        import struct
        with open(f"{self.tmp}/src/pristine/mdbx.dat", "rb") as f:
            head = f.read(3 * PAGE)
        txn = [struct.unpack_from("<Q", head, i * PAGE + 20 + 8)[0] for i in range(3)]     # page header 20 B, then magic, txnid
        newest = txn.index(max(txn))
        for meta in (0, 1, 2):
            rc, rep = self.wrap(f"{self.tmp}/ro/pristine", "--meta", str(meta))
            self.assertIn(rep["rc"], (0, 1, 2), (meta, rep["outputTail"][-500:]))           # checked, never an MDBX/system error
            self.assertTrue(rep["unchangedIdentity"])
            if meta == newest:
                self.assertEqual((rc, rep["rc"]), (0, 0), rep["outputTail"][-500:])

    def test_corrupted_meta_pages_are_not_clean(self):
        self.assertNotIn(self.chk(f"{self.tmp}/ro/bad-meta").returncode, (0, 5))
        rc, rep = self.wrap(f"{self.tmp}/ro/bad-meta")
        self.assertEqual(rc, 2); self.assertFalse(rep["structurallyClean"])

    def test_corrupted_btree_pages_are_not_clean(self):
        self.assertNotIn(self.chk(f"{self.tmp}/ro/bad-tree").returncode, (0, 5))
        rc, rep = self.wrap(f"{self.tmp}/ro/bad-tree")
        self.assertEqual(rc, 2); self.assertFalse(rep["structurallyClean"])

    def test_a_truncated_file_is_not_clean(self):
        self.assertNotIn(self.chk(f"{self.tmp}/ro/truncated").returncode, (0, 5))
        rc, rep = self.wrap(f"{self.tmp}/ro/truncated")
        self.assertEqual(rc, 2); self.assertFalse(rep["structurallyClean"])

    def test_a_writable_view_is_refused_before_anything_runs(self):
        rc, rep = self.wrap(f"{self.tmp}/src/pristine")
        self.assertEqual((rc, rep), (1, None))                     # no report: mdbx_chk never ran on the writable view

    def test_even_mdbx_chk_w_cannot_change_the_readonly_view(self):
        r = self.chk("-w", f"{self.tmp}/ro/pristine")              # the wrapper never passes -w; the read-only mount is the guard
        self.assertNotEqual(r.returncode, 0)

    def test_wrong_binary_and_bad_meta_selection_are_refused(self):
        self.assertEqual(M.main(["mdbx_check.py", "--chk", CHK, "--chk-sha256", "0" * 64, "--db-dir", f"{self.tmp}/ro/pristine"]), 1)
        self.assertEqual(M.main(["mdbx_check.py", "--chk", CHK, "--chk-sha256", CHK_SHA, "--db-dir", f"{self.tmp}/ro/pristine", "--meta", "3"]), 1)

    def test_a_symlinked_or_empty_db_dir_is_refused(self):
        os.symlink(f"{self.tmp}/ro/pristine", f"{self.tmp}/link")
        self.assertEqual(self.wrap(f"{self.tmp}/link")[0], 1)
        os.makedirs(f"{self.tmp}/empty")
        self.assertEqual(self.wrap(f"{self.tmp}/empty")[0], 1)


if __name__ == "__main__":
    unittest.main()
