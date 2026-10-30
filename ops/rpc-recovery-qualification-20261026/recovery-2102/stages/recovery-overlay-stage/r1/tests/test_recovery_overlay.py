#!/usr/bin/env python3
"""recovery-overlay-stage/r1 tests (prepared by Claude 1660; NOT run by Claude). REAL tools on a TINY controlled-delete fixture:
mkfs.ext4/debugfs (fixture), qemu-img/qemu-io/qemu-nbd, nbdfuse, the pinned fuse2fs, fusermount3. Unprivileged; everything lives in
RECOVERY_OVERLAY_WORK (set by jobs/tests.sh). 8 tests."""
import contextlib, hashlib, io, json, os, shutil, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
sys.path.insert(0, STAGE); sys.path.insert(0, os.path.join(STAGE, "fixture"))
import overlay_plan as P      # noqa: E402
import overlay_session as S   # noqa: E402
import make_fixture as F      # noqa: E402

WORK = os.environ["RECOVERY_OVERLAY_WORK"]
FUSE2FS, FUSE2FS_SHA = os.environ["RECOVERY_OVERLAY_FUSE2FS"], os.environ["RECOVERY_OVERLAY_FUSE2FS_SHA256"]
NAME, PATH = "mdbx.dat", "/data/db/mdbx.dat"


def read_json(path):
    with open(path) as f:
        return json.load(f)


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def write_bytes(path, data):
    with open(path, "wb") as f:
        f.write(data)


def quiet(fn, argv):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        rc = fn(argv)
    return rc, out.getvalue()


class RecoveryOverlay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = F.build(os.path.join(WORK, "fixture"))
        cls.n = 0

    def newdir(self, name):
        type(self).n += 1
        d = os.path.join(WORK, f"{type(self).n:02d}-{name}")
        os.mkdir(d, 0o700)
        return d

    def plan(self, name, *extra, capture=None):
        out = os.path.join(WORK, f"plan-{name}")
        rc, text = quiet(P.main, ["fixture", "--capture", capture or self.fx["capture"], "--name", NAME, "--path", PATH,
                                  "--out", out, *extra])
        return rc, out, text

    def session(self, plan_dir, parent, *extra, parent_sha=True):
        run = self.newdir("run")
        args = ["--plan-dir", plan_dir, "--parent", parent, "--run-dir", run, "--fuse2fs", FUSE2FS, "--fuse2fs-sha256", FUSE2FS_SHA]
        if parent_sha:
            args += ["--parent-sha256", self.fx["parents"][os.path.basename(parent)]]
        rc, _ = quiet(S.main, args + list(extra))
        return rc, read_json(os.path.join(run, "receipt.json")), run

    def parent(self, name):
        return os.path.join(WORK, "fixture", name)

    def assert_clean(self, r, run):
        self.assertIs(r["cleanupComplete"], True, r)
        self.assertIs(r["parentUnchanged"], True, r)
        self.assertEqual(r["leftoverProcesses"], [])
        self.assertIs(r["overlayDeleted"], True)
        for name, c in r.get("children", {}).items():
            self.assertIsNotNone(c.get("returncode"), name)            # every child of ours was reaped
        work = os.path.join(run, "work")
        with open("/proc/self/mountinfo") as f:
            self.assertNotIn(work, f.read(), "a mount of ours survived")

    # -------------------------------------------------------------------------------------------------------------------------------
    def test_1_restored_view_reads_the_deleted_file_exactly_and_refuses_writes(self):
        rc, plan_dir, _ = self.plan("ok")
        self.assertEqual(rc, 0)
        plan = read_json(os.path.join(plan_dir, "plan.json"))
        self.assertEqual(len(plan["patches"]), 2 + len(self.fx["treeBlocks"]))
        self.assertEqual([p["length"] for p in plan["patches"] if p["kind"] == "inode"], [256])    # the inode ONLY, not its table block
        self.assertEqual(plan["target"]["treeDepth"], 2)
        rc, r, run = self.session(plan_dir, self.parent("parent-clean.qcow2"))
        self.assertEqual(rc, 0, r)
        for k in ("overlayWithinCap", "overlayQcowCheck", "patchesReadBack", "nbdRefusesWrite", "targetRegularAndSized",
                  "targetRefusesWrite", "mountRefusesMkdir", "newFileRefused", "targetExact", "samplesFollowRestoredMap"):
            self.assertIs(r["checks"][k]["ok"], True, (k, r["checks"][k]))
        self.assertLessEqual(r["overlayBytes"], 64 << 20)
        self.assert_clean(r, run)

    def test_2_reused_data_blocks_are_detected_not_accepted(self):
        rc, plan_dir, _ = self.plan("reused")
        self.assertEqual(rc, 0)
        rc, r, run = self.session(plan_dir, self.parent("parent-reused.qcow2"))
        self.assertEqual(rc, 1, r)
        self.assertIs(r["checks"]["targetExact"]["ok"], False)                 # the restored map now names overwritten blocks
        self.assertIs(r["checks"]["patchesReadBack"]["ok"], True)
        self.assert_clean(r, run)

    def test_3_a_tampered_tree_image_is_refused_by_its_checksum(self):
        cap = self.newdir("tampered-capture")
        src = self.fx["capture"]
        meta = read_json(os.path.join(src, "capture.json"))
        raw = bytearray(read_bytes(os.path.join(src, "captured.bin")))
        leaf = [im for im in meta["images"] if im["kind"] == "tree"][-1]
        raw[leaf["offset"] + 20] ^= 0x01                                   # an extent entry byte; hashes are updated, the CRC is not
        leaf["sha256"] = hashlib.sha256(raw[leaf["offset"]:leaf["offset"] + 4096]).hexdigest()
        meta["capturedSha256"] = hashlib.sha256(raw).hexdigest()
        write_bytes(os.path.join(cap, "captured.bin"), bytes(raw))
        write_bytes(os.path.join(cap, "capture.json"), json.dumps(meta).encode())
        rc, out, text = self.plan("tampered", capture=cap)
        self.assertEqual(rc, 3, text)
        self.assertIn("checksum mismatch", text)
        self.assertFalse(os.path.exists(out))

    def test_4_a_directory_block_for_another_generation_is_refused(self):
        rc, out, text = self.plan("dirgen", "--dir-gen", str(self.fx["dir"]["generation"] + 1))
        self.assertEqual(rc, 3, text)
        self.assertIn("directory block checksum mismatch", text)
        self.assertFalse(os.path.exists(out))

    def test_5_a_missing_tree_block_is_refused(self):
        rc, out, text = self.plan("missing", "--drop-tree-block", str(self.fx["treeBlocks"][-1]))
        self.assertEqual(rc, 3, text)
        self.assertIn("has no planned image", text)

    def test_6_an_overlay_over_the_cap_is_refused_and_cleaned_up(self):
        rc, plan_dir, _ = self.plan("cap")
        self.assertEqual(rc, 0)
        rc, r, run = self.session(plan_dir, self.parent("parent-clean.qcow2"), "--cap-bytes", "4096")
        self.assertEqual(rc, 3, r)
        self.assertIn("exceeds the cap", r["refused"])
        self.assertNotIn("children", r)                                        # nothing was exposed
        self.assert_clean(r, run)

    def test_7_a_writable_parent_is_refused_before_anything_is_created(self):
        rc, plan_dir, _ = self.plan("writable")
        self.assertEqual(rc, 0)
        d = self.newdir("writable-parent")
        p = os.path.join(d, "parent-clean.qcow2")
        shutil.copyfile(self.parent("parent-clean.qcow2"), p); os.chmod(p, 0o644)
        rc, r, run = self.session(plan_dir, p, parent_sha=False)
        self.assertEqual(rc, 3, r)
        self.assertIn("WRITABLE", r["refused"])
        self.assertFalse(os.path.exists(os.path.join(run, "work")))

    def test_8_the_read_only_contract_is_in_the_commands(self):
        src = read_bytes(os.path.join(STAGE, "overlay_session.py")).decode()
        self.assertTrue(S.FUSE2FS_OPTS.startswith("ro,norecovery,"))
        self.assertIn('"--read-only"', src); self.assertIn('["nbdfuse", "-r"', src); self.assertNotIn('"--fork"', src)
        ro, rw = S.image_opts("/a/o.qcow2", "/a/p.qcow2", True), S.image_opts("/a/o.qcow2", "/a/p.qcow2", False)
        self.assertIn("backing.read-only=on", rw); self.assertIn("backing.file.locking=off", rw); self.assertTrue(ro.endswith(",read-only=on"))
        with self.assertRaises(S.Refused):
            S.image_opts("/a/o,x.qcow2", "/a/p.qcow2", True)


if __name__ == "__main__":
    unittest.main()
