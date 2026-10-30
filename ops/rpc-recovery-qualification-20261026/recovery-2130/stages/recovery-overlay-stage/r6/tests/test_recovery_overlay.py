#!/usr/bin/env python3
"""recovery-overlay-stage/r2 tests (prepared by Claude 1660/1674; NOT run by Claude). REAL tools on a TINY controlled-delete fixture:
mkfs.ext4/debugfs (fixture), qemu-img/qemu-io/qemu-nbd, nbdfuse, the pinned fuse2fs, fusermount3. Unprivileged; everything lives in
RECOVERY_OVERLAY_WORK (set by jobs/tests.sh). 20 tests (r1: 8, r2: +12)."""
import contextlib, hashlib, io, json, os, shutil, signal, subprocess, sys, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
sys.path.insert(0, STAGE); sys.path.insert(0, os.path.join(STAGE, "fixture"))
import overlay_plan as P      # noqa: E402
import overlay_session as S   # noqa: E402
import make_fixture as F      # noqa: E402
import make_jbd2_inputs as J  # noqa: E402

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
        args = ["--plan-dir", plan_dir, "--parent", parent, "--run-dir", run, "--fuse2fs", FUSE2FS, "--fuse2fs-sha256", FUSE2FS_SHA,
                "--plan-sha256", hashlib.sha256(read_bytes(os.path.join(plan_dir, "plan.json"))).hexdigest()]
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
        rc, r, run = self.session(plan_dir, self.parent("parent-clean.qcow2"), "--exec", "sh", "-c", 'test -s "$RECOVERY_TARGET"')
        self.assertEqual(rc, 0, r)
        self.assertEqual((r["exec"]["rc"], r["exec"]["timedOut"], r["exec"]["groupLeftovers"], r["exec"]["escapedKilled"]), (0, False, [], 0))
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

    def test_6_an_overlay_estimate_over_the_cap_is_refused_before_anything_is_created(self):
        rc, plan_dir, _ = self.plan("cap")
        self.assertEqual(rc, 0)
        rc, r, run = self.session(plan_dir, self.parent("parent-clean.qcow2"), "--cap-bytes", "4096")
        self.assertEqual(rc, 3, r)
        self.assertIn("worst-case overlay estimate", r["refused"])
        self.assertNotIn("children", r)
        self.assertFalse(os.path.exists(os.path.join(run, "work")), "r2: refused BEFORE any file is created")

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
        self.assertEqual(S.SOCK_ARG, "/proc/self/cwd/nbd.sock")                # r6: short, absolute, resolved to each child's cwd
        self.assertIn('f"--socket={SOCK_ARG}"', src); self.assertIn('"--unix", SOCK_ARG', src); self.assertEqual(src.count("cwd=self.work"), 2)
        self.assertIn('"--read-only"', src); self.assertIn('["nbdfuse", "-r"', src); self.assertNotIn('"--fork"', src)
        ro, rw = S.image_opts("/a/o.qcow2", "/a/p.qcow2", True), S.image_opts("/a/o.qcow2", "/a/p.qcow2", False)
        self.assertIn("backing.read-only=on", rw); self.assertIn("backing.file.locking=off", rw); self.assertTrue(ro.endswith(",read-only=on"))
        with self.assertRaises(S.Refused):
            S.image_opts("/a/o,x.qcow2", "/a/p.qcow2", True)


    # ---- r2: the REAL plan path on synthetic verifier/candidate inputs built from the fixture capture ------------------------------
    def real_plan(self, variant):
        inp = J.build(self.fx["capture"], os.path.join(WORK, f"jbd2-{variant}"), variant)
        out = os.path.join(WORK, f"realplan-{variant}")
        rc, text = quiet(P.main, inp["args"] + ["--name", NAME, "--path", PATH, "--out", out])
        return rc, out, text

    def test_9_the_real_plan_path_yields_exactly_the_fixture_patches_with_chronology(self):
        rc, real, text = self.real_plan("ok")
        self.assertEqual(rc, 0, text)
        rc, fix, _ = self.plan("compare")
        self.assertEqual(rc, 0)
        rp, fp = read_json(os.path.join(real, "plan.json")), read_json(os.path.join(fix, "plan.json"))
        key = lambda pl: [(p["kind"], p["byteOffset"], p["length"], p["sha256"]) for p in pl["patches"]]
        self.assertEqual(key(rp), key(fp))
        self.assertEqual(rp["map"]["digest"], fp["map"]["digest"])
        self.assertEqual(rp["chronology"]["limitSequence"], 500)

    def test_10_a_journal_image_that_is_not_its_proven_sha256_is_refused(self):
        rc, out, text = self.real_plan("tampered-sha")
        self.assertEqual(rc, 3, text); self.assertIn("contentSha256", text); self.assertFalse(os.path.exists(out))

    def test_11_a_newer_valid_image_of_a_tree_block_makes_the_chosen_one_stale(self):
        rc, out, text = self.real_plan("newer-valid-leaf")
        self.assertEqual(rc, 3, text); self.assertIn("NEWER valid image", text)

    def test_12_revoked_unproven_or_partial_chosen_images_are_refused(self):
        for variant, needle in (("revoked", "was revoked"), ("unproven", "unproven references"), ("partial-tree", "not exactly one proven")):
            rc, out, text = self.real_plan(variant)
            self.assertEqual(rc, 3, (variant, text)); self.assertIn(needle, text, variant)

    def test_13_the_latest_directory_image_must_itself_validate(self):
        rc, out, text = self.real_plan("dir-latest-invalid")
        self.assertEqual(rc, 3, text); self.assertIn("directory block checksum mismatch", text)

    def test_14_an_escaped_jbd2_image_is_restored_before_its_sha256_check(self):
        C = P.load_checker()
        content = C.JBD2_MAGIC + hashlib.sha256(b"escaped").digest() * 127 + bytes(4092 - 32 * 127)   # a block that BEGINS with the magic
        d = self.newdir("escaped")
        jp = os.path.join(d, "j.bin")
        write_bytes(jp, bytes(4096) + bytes(4) + content[4:])
        rec = {"imageJournalBlock": 1, "imageByteOffset": 4096, "escaped": True, "contentSha256": hashlib.sha256(content).hexdigest()}
        fd = os.open(jp, os.O_RDONLY)
        try:
            self.assertEqual(P.read_proven(C, fd, rec, 2), content)
            with self.assertRaises(P.Refused):
                P.read_proven(C, fd, {**rec, "escaped": False}, 2)
        finally:
            os.close(fd)

    def test_15_the_real_mode_read_only_mount_requirement_refuses_a_writable_filesystem(self):
        rc, plan_dir, _ = self.plan("romount")
        self.assertEqual(rc, 0)
        rc, r, run = self.session(plan_dir, self.parent("parent-clean.qcow2"), "--require-ro-mount")
        self.assertEqual(rc, 3, r); self.assertIn("ST_RDONLY", r["refused"])
        self.assertFalse(os.path.exists(os.path.join(run, "work")))

    def test_16_a_failing_validator_gives_rc_6_and_leaves_no_descendants(self):
        rc, plan_dir, _ = self.plan("execfail")
        self.assertEqual(rc, 0)
        for script in ("sleep 300 & exit 3", "setsid sleep 300 & sleep 1; exit 0"):   # a failure; a success that leaves an escaped child
            rc, r, run = self.session(plan_dir, self.parent("parent-clean.qcow2"), "--exec", "sh", "-c", script)
            self.assertEqual(rc, 6, (script, r.get("exec")))
            self.assertTrue(r["exec"]["groupLeftovers"] or r["exec"]["escapedKilled"], (script, r["exec"]))   # found (group or adopted) ...
            self.assertIs(r["exec"]["groupEmpty"], True); self.assertIs(r["exec"]["orphansGone"], True)   # ... and killed and reaped
            self.assert_clean(r, run)

    def test_17_a_validator_timeout_gives_rc_6_and_kills_its_group(self):
        rc, plan_dir, _ = self.plan("exectimeout")
        self.assertEqual(rc, 0)
        rc, r, run = self.session(plan_dir, self.parent("parent-clean.qcow2"), "--exec-timeout", "2", "--exec", "sh", "-c", "sleep 300")
        self.assertEqual(rc, 6, r.get("exec"))
        self.assertIs(r["exec"]["timedOut"], True); self.assertIs(r["exec"]["groupEmpty"], True)
        self.assert_clean(r, run)

    def test_18_rlimit_fsize_stops_any_child_file_beyond_the_cap(self):
        d = self.newdir("fsize")
        f = os.path.join(d, "grow")
        rc, _o, _e = S.run(["truncate", "-s", str(2 << 20), f], fsize=1 << 20)
        self.assertNotEqual(rc, 0)
        self.assertLessEqual(os.path.getsize(f) if os.path.exists(f) else 0, 1 << 20)


    # ---- r2 (da 1671 B1): the session killed mid-hold ------------------------------------------------------------------------------
    def killed_mid_hold(self, sig):
        rc, plan_dir, _ = self.plan(f"kill{sig}")
        self.assertEqual(rc, 0)
        run, parent = self.newdir(f"kill{sig}"), self.parent("parent-clean.qcow2")
        cmd = [sys.executable, "-I", "-B", os.path.join(STAGE, "overlay_session.py"), "--plan-dir", plan_dir, "--parent", parent,
               "--run-dir", run, "--fuse2fs", FUSE2FS, "--fuse2fs-sha256", FUSE2FS_SHA, "--hold-seconds", "300",
               "--plan-sha256", hashlib.sha256(read_bytes(os.path.join(plan_dir, "plan.json"))).hexdigest()]
        with open(os.path.join(run, "session.out"), "wb") as out:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
            mnt, end = os.path.join(run, "work", "mnt"), time.monotonic() + 120
            while time.monotonic() < end and mnt not in read_bytes("/proc/self/mountinfo").decode():
                self.assertIsNone(proc.poll(), "the session ended before its view was mounted")
                time.sleep(0.5)
            proc.send_signal(sig)
            rc = proc.wait(timeout=120)
        end = time.monotonic() + 30                                # PDEATHSIG: the children end, libfuse unmounts
        while time.monotonic() < end:
            alive = [p for p in os.listdir("/proc") if p.isdigit() and int(p) != os.getpid() and self.names(p, run)]
            if run not in read_bytes("/proc/self/mountinfo").decode() and not alive:
                break
            time.sleep(0.5)
        while True:                                                # reap orphans re-parented to this (subreaper) test process
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
        self.assertNotIn(run, read_bytes("/proc/self/mountinfo").decode(), "a mount survived the killed session")
        self.assertEqual(alive, [], "a child survived the killed session")
        self.assertEqual(hashlib.sha256(read_bytes(parent)).hexdigest(), self.fx["parents"]["parent-clean.qcow2"])
        return rc, run

    @staticmethod
    def names(pid, run):
        try:
            return run.encode() in read_bytes(f"/proc/{pid}/cmdline") and read_bytes(f"/proc/{pid}/stat").split(b") ")[1][:1] != b"Z"
        except OSError:
            return False

    def test_19_sigterm_mid_hold_runs_the_full_cleanup(self):
        rc, run = self.killed_mid_hold(signal.SIGTERM)
        self.assertEqual(rc, 5)
        r = read_json(os.path.join(run, "receipt.json"))
        self.assertIn("interrupted", r); self.assertIs(r["cleanupComplete"], True, r); self.assertIs(r["parentUnchanged"], True)

    def test_20_sigkill_mid_hold_still_ends_every_child_and_mount(self):
        rc, _run = self.killed_mid_hold(signal.SIGKILL)
        self.assertEqual(rc, -signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
