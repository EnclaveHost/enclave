#!/usr/bin/env python3
"""compact-header-extraction-stage/r2 UNIT tests (PREPARED by Claude 1881/1892; NOT run by Claude). No mount, session, backup or network:
tmp trees and owned child processes only; test 12 reads the small pinned RAID-owner receipt JSON (never the image). Expected: "Ran 16 tests", OK."""
import hashlib, importlib.util, json, os, signal, subprocess, sys, tempfile, time, unittest
from pathlib import Path

ST = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ST)); sys.path.insert(0, str(ST / "jobs")); sys.path.insert(0, str(ST / "tests"))
import extract as X  # noqa: E402
import coordination as C  # noqa: E402
import make_meta_fixture as MM  # noqa: E402  (tests/; only its pure functions are called here)


def ent(path, size, **k):
    return {"path": path, "size": size, "nlink": 1, **k}


class T(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory(prefix="che1881-unit-"); self.d = self.td.name

    def tearDown(self):
        self.td.cleanup()

    def tree(self):
        src = os.path.join(self.d, "src"); os.makedirs(src + "/data/sf")
        Path(src, "data/a.toml").write_bytes(b"x" * 2590); Path(src, "data/sf/h").write_bytes(os.urandom(3 * X.CHUNK + 7))
        dst = os.path.join(self.d, "dst"); os.mkdir(dst, 0o700)
        return src, dst, os.open(src, os.O_RDONLY | os.O_DIRECTORY), os.open(dst, os.O_RDONLY | os.O_DIRECTORY)

    def test_01_production_allowlist_exact(self):
        sha, tot = X.validate_allowlist(X.PROD_ALLOWLIST, X.PROD["total"])
        self.assertEqual(tot, 362900885); self.assertEqual(len(X.PROD_ALLOWLIST), 7)
        self.assertEqual(sorted(e["path"] for e in X.PROD_ALLOWLIST)[0], "data/reth.toml")
        self.assertTrue(all(e["nlink"] == 1 and e["uid"] == 994 and e["gid"] == 985 for e in X.PROD_ALLOWLIST))
        self.assertEqual(sha, X.validate_allowlist(json.loads(json.dumps(X.PROD_ALLOWLIST)), X.PROD["total"])[0])

    def test_02_allowlist_refusals(self):
        for bad in ([], [ent("/abs", 1)], [ent("a/../b", 1)], [ent("a//b", 1)], [ent("a", 1), ent("a", 1)],
                    [{**ent("a", 1), "nlink": 2}], [ent("a", -1)], [{**ent("a", 1), "extra": 1}], [ent("a", X.MAX_TOTAL + 1)]):
            with self.assertRaises(X.Refuse, msg=bad):
                X.validate_allowlist(bad)
        with self.assertRaises(X.Refuse):
            X.validate_allowlist(X.PROD_ALLOWLIST, X.PROD["total"] + 1)

    def test_03_copy_exact_and_double_read(self):
        src, dst, sfd, dfd = self.tree()
        try:
            r = X.copy_one(sfd, dfd, ent("data/sf/h", 3 * X.CHUNK + 7), lambda: False)
            want = hashlib.sha256(Path(src, "data/sf/h").read_bytes()).hexdigest()
            self.assertEqual((r["sha256"], r["reads"], r["copyReread"]), (want, 2, True))
            self.assertEqual(hashlib.sha256(Path(dst, "data/sf/h").read_bytes()).hexdigest(), want)
            self.assertFalse(os.path.lexists(dst + "/data/sf/h.partial"))
            self.assertEqual(os.stat(dst + "/data/sf/h").st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):                  # never replaces: a second copy to an existing name fails
                X.copy_one(sfd, dfd, ent("data/sf/h", 3 * X.CHUNK + 7), lambda: False)
            self.assertEqual(hashlib.sha256(Path(dst, "data/sf/h").read_bytes()).hexdigest(), want)
            with self.assertRaises(X.Fail):                           # an allowlist sha that differs keeps only the .partial
                X.copy_one(sfd, dfd, ent("data/a.toml", 2590, sha256="0" * 64), lambda: False)
            self.assertFalse(os.path.lexists(dst + "/data/a.toml")); self.assertTrue(os.path.lexists(dst + "/data/a.toml.partial"))
        finally:
            os.close(sfd); os.close(dfd)

    def test_04_no_symlink_or_hardlink_or_metadata_drift(self):
        src, dst, sfd, dfd = self.tree()
        try:
            os.symlink("a.toml", src + "/data/link"); os.symlink("sf", src + "/data/sfl"); os.symlink(src + "/data", src + "/d2")
            os.link(src + "/data/a.toml", src + "/data/hard"); os.mkfifo(src + "/data/fifo")
            for p in ("data/link", "data/sfl/h", "d2/a.toml", "data/fifo", "data/missing"):
                with self.assertRaises(X.Refuse, msg=p):
                    X.open_nofollow(sfd, p)
            f, st = X.open_nofollow(sfd, "data/hard"); os.close(f)
            with self.assertRaises(X.Refuse):                         # nlink 2 != the allowlist's 1
                X.check_entry(ent("data/hard", 2590), st)
            os.unlink(src + "/data/hard")
            f, st = X.open_nofollow(sfd, "data/a.toml"); os.close(f)
            X.check_entry(ent("data/a.toml", 2590, mode=st.st_mode, uid=st.st_uid, gid=st.st_gid, mtime_ns=st.st_mtime_ns), st)
            for k, v in (("size", 2591), ("mode", st.st_mode ^ 0o20), ("uid", st.st_uid + 1), ("mtime_ns", st.st_mtime_ns + 1)):
                with self.assertRaises(X.Refuse, msg=k):
                    X.check_entry({**ent("data/a.toml", 2590), k: v}, st)
            self.assertEqual(os.listdir(dst), [])
        finally:
            os.close(sfd); os.close(dfd)

    def test_05_stop_leaves_partial_only(self):
        src, dst, sfd, dfd = self.tree()
        n = {"c": 0}
        def stop():
            n["c"] += 1; return n["c"] > 2
        try:
            with self.assertRaises(X.Stopped):
                X.copy_one(sfd, dfd, ent("data/sf/h", 3 * X.CHUNK + 7), stop)
            self.assertTrue(os.path.lexists(dst + "/data/sf/h.partial")); self.assertFalse(os.path.lexists(dst + "/data/sf/h"))
        finally:
            os.close(sfd); os.close(dfd)

    def test_06_plan_qemu_info_receipt(self):
        p = X.zero_patch_plan(X.PROD["fsBlocks"], X.PROD["uuid"], X.PROD_ALLOWLIST[0])
        self.assertEqual((p["format"], p["patches"], p["samples"], p["fs"]["fsOffset"], p["target"]),
                         ("recovery-overlay-plan/v1", [], [], 0, {"path": "/data/reth.toml", "size": 2590}))
        fsb = X.PROD["fsBlocks"] * X.BLOCK
        X.check_qemu_info({"format": "qcow2", "virtual-size": fsb}, fsb)
        for bad in ({"format": "raw", "virtual-size": fsb}, {"format": "qcow2", "virtual-size": fsb - 1},
                    {"format": "qcow2", "virtual-size": fsb, "backing-filename": "/x"}, {"format": "qcow2", "virtual-size": fsb, "full-backing-filename": "/x"}):
            with self.assertRaises(X.Refuse):
                X.check_qemu_info(bad, fsb)
        argv = ["/usr/bin/python3", "w"]
        good = {"rc": 0, "cleanupComplete": True, "parentUnchanged": True, "planSha256": "p", "overlayDeleted": True, "leftoverProcesses": [],
                "exec": {"cmd": argv, "rc": 0, "timedOut": False, "groupLeftovers": [], "escapedKilled": 0},
                "children": {"exec": {"pid": 7}}, "checks": {"a": {"ok": True}, "b": {"ok": True}}}
        self.assertEqual(X.check_receipt(good, "p", argv, 7), [])
        for mut in (lambda r: r.update(rc=6), lambda r: r.update(cleanupComplete=False), lambda r: r.update(parentUnchanged=False),
                    lambda r: r.update(planSha256="q"), lambda r: r["exec"].update(rc=1), lambda r: r["exec"].update(cmd=["x"]),
                    lambda r: r["exec"].update(timedOut=True), lambda r: r["exec"].update(groupLeftovers=[9]),
                    lambda r: r["exec"].update(escapedKilled=1), lambda r: r["children"]["exec"].update(pid=8),
                    lambda r: r["checks"]["b"].update(ok=False), lambda r: r.update(checks={}), lambda r: r.update(leftoverProcesses=[3]),
                    lambda r: r.update(overlayDeleted=False)):
            r = json.loads(json.dumps(good)); mut(r)
            self.assertTrue(X.check_receipt(r, "p", argv, 7))

    def test_07_view_mount_and_fs_header(self):
        mnt, nbd = "/vm/x/run 1/session/work/mnt", "/vm/x/run 1/session/work/view/nbd"
        line = lambda mid, mp, opts, fst, srcp: f"{mid} 1 0:99 / {mp.replace(' ', chr(92) + '040')} {opts},nosuid - {fst} {srcp.replace(' ', chr(92) + '040')} ro"
        X.check_view(mnt, nbd, "u", line(5, mnt, "ro", "fuse", nbd))
        for mi in (line(5, mnt, "rw", "fuse", nbd), line(5, mnt, "ro", "ext4", nbd), line(5, mnt, "ro", "fuse", "/dev/sda"),
                   line(5, mnt, "ro", "fuse", nbd) + "\n" + line(6, mnt, "ro", "fuse", nbd), line(5, mnt + "x", "ro", "fuse", nbd)):
            with self.assertRaises(X.Refuse):
                X.check_view(mnt, nbd, "u", mi)
        img = os.path.join(self.d, "img"); b = bytearray(8192)
        b[1080:1082] = b"\x53\xef"; b[1128:1144] = bytes.fromhex(X.PROD["uuid"].replace("-", ""))
        Path(img).write_bytes(b); X.check_fs_header(img, X.PROD["uuid"])
        with self.assertRaises(X.Refuse):
            X.check_fs_header(img, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
        b[1080] = 0; Path(img).write_bytes(b)
        with self.assertRaises(X.Refuse):
            X.check_fs_header(img, X.PROD["uuid"])

    def test_08_ready_only_from_our_exec_child(self):
        tgt = "/vm/run/session/work/mnt/data/reth.toml"
        argv = [X.PY3, "-I", "-B", "-c", "import time; time.sleep(60)"]
        env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "RECOVERY_TARGET": tgt}
        c = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL)
        bad_env = subprocess.Popen(argv, env={**env, "EXTRA": "1"}, stdin=subprocess.DEVNULL)
        try:
            time.sleep(0.3)
            ready = {"pid": c.pid, "startTime": X.starttime(c.pid)[1], "target": tgt}
            os.close(X.verify_ready(ready, os.getpid(), argv, tgt))
            for r, sp, av, t in ((ready, os.getpid() + 1, argv, tgt), (ready, os.getpid(), argv[:-1] + ["x"], tgt),
                                 ({**ready, "startTime": ready["startTime"] + 1}, os.getpid(), argv, tgt), (ready, os.getpid(), argv, tgt + "x"),
                                 ({"pid": bad_env.pid, "startTime": X.starttime(bad_env.pid)[1], "target": tgt}, os.getpid(), argv, tgt),
                                 ({"pid": 1, "startTime": X.starttime(1)[1], "target": tgt}, os.getpid(), argv, tgt), ({"pid": "1"}, 0, argv, tgt)):
                with self.assertRaises(X.Refuse):
                    X.verify_ready(r, sp, av, t)
            c.kill(); c.wait()
            with self.assertRaises(X.Refuse):                         # a reaped (dead) pid is never accepted
                X.verify_ready(ready, os.getpid(), argv, tgt)
        finally:
            for p in (c, bad_env):
                if p.poll() is None:
                    p.kill()
                p.wait()

    def test_09_production_refusals_before_anything(self):
        dp = os.path.join(self.d, "dp"); os.mkdir(dp)
        req = os.path.join(self.d, "req.json"); Path(req).write_text("{}")
        rsha = hashlib.sha256(b"{}").hexdigest()
        base = ["run", "--dest-parent", dp, "--request", req, "--stage-sums", "s"]
        self.assertEqual(X.main(base), 3)                             # no --request-sha256
        self.assertEqual(X.main(base + ["--request-sha256", rsha, "--floor-bytes", "1"]), 3)
        self.assertEqual(X.main(base + ["--request-sha256", rsha, "--host-mem-floor", "1"]), 3)
        self.assertEqual(X.main(base + ["--request-sha256", "0" * 64]), 3)
        self.assertEqual(X.main(base + ["--request-sha256", rsha]), 3)   # content not the purpose-bound request
        self.assertEqual(X.main(["run", "--dest-parent", dp, "--fixture"]), 3)
        self.assertEqual(os.listdir(dp), [])

    def test_10_coordination_filter(self):
        procs = [(10, ["/usr/bin/python3", "-I", "-B", "/w/jobs/root-multipart-batches-1773.py", "drive"]),
                 (11, ["python3", "jobs/root-multipart-batches-1764.py", "batch"]), (12, ["/usr/bin/vim", "root-multipart-batches-1773.py"]),
                 (13, ["/usr/bin/bash", "-c", "echo"]), (14, ["/usr/bin/python3", "/w/jobs/root-multipart-batches-1773.py"])]
        self.assertEqual([r.split(":")[0] for r in C.coordination_reasons(procs, 14)], ["pid 10", "pid 11", "pid 12"])
        self.assertEqual(C.coordination_reasons([(13, ["/usr/bin/bash"])], 1), [])

    # ---- r2 (review 1885) ----------------------------------------------------------------------------------------------------------
    def test_11_lane_1024_and_host_floor_headroom(self):
        need = X.PROD["hostMemFloor"] + ((1024 + 256) << 20)
        self.assertEqual(X.lane_errors(str(1024 << 20) + "\n", need, X.PROD["hostMemFloor"]), [])
        for mm, av in ((str(512 << 20), need), ("max", need), (str(1024 << 20), need - 1), (str(1024 << 20), True), (None, need)):
            self.assertTrue(X.lane_errors(mm, av, X.PROD["hostMemFloor"]), (mm, av))

    def test_12_backup_bound_to_its_fresh_post_chmod_identity(self):
        raw = Path(X.BACKUP_RECEIPT[0]).read_bytes()                  # the small pinned owner receipt (never the image)
        good = {"dev": 64768, "ino": 4856848, "size": X.PROD["backupSize"], "mode": 0o444, "mtimeNs": 1793046916167070631,
                "ctimeNs": 1793097367170099837}
        self.assertEqual(X.backup_binding_errors(good, raw), [])
        for k, v in (("ctimeNs", 1793051528993087982), ("ctimeNs", good["ctimeNs"] + 1), ("mode", 0o644), ("ino", 1), ("dev", 1),
                     ("mtimeNs", 0), ("size", 1)):
            self.assertTrue(X.backup_binding_errors(dict(good, **{k: v}), raw), k)  # incl. the PRE-chmod ctime: never accepted
        self.assertTrue(X.backup_binding_errors(good, raw + b" "))
        self.assertTrue(X.backup_binding_errors(good, None))
        self.assertEqual(X.HOLD_DEFAULT, 900)

    def test_13_receipt_write_failure_is_never_rc0(self):
        self.assertEqual([X.final_rc(rc, False) for rc in (0, 3, 4, 5)], [4, 3, 4, 4])
        self.assertEqual([X.final_rc(rc, True) for rc in (0, 3, 4, 5)], [0, 3, 4, 5])

    def test_14_state_pins_only_from_a_clean_receipt(self):
        run = X.PROD["destParent"] + "/compact-header-extraction-20261101T000000Z-7"
        files = [{"path": e["path"], "size": e["size"], "sha256": f"{i:064x}"} for i, e in enumerate(X.PROD_ALLOWLIST)]
        rec = {"rc": 0, "outcome": "CLEAN", "runDir": run, "session": {"rc": 0, "reasons": []}, "canonicalAuthority": False,
               "resetAuthority": False, "files": files, "totalBytes": X.PROD["total"]}
        pins = X.state_pins(json.loads(json.dumps(rec)), run)
        self.assertEqual(pins["staticFilesDir"], run + "/files/data/static_files")
        self.assertEqual([f["name"] for f in pins["staticFiles"]], [e["path"].rsplit("/", 1)[1] for e in X.PROD_ALLOWLIST[1:]])
        self.assertEqual(len(pins["staticFiles"]), 6); self.assertNotIn("reth.toml", json.dumps(pins["staticFiles"]))
        muts = [("rc", 4), ("rc", True), ("outcome", "FAILED"), ("session", {"rc": 0, "reasons": ["x"]}), ("session", {"rc": 1, "reasons": []}),
                ("canonicalAuthority", True), ("totalBytes", 1), ("runDir", run + "x"), ("files", files[1:]), ("files", files[::-1]),
                ("files", [dict(files[0], size=1)] + files[1:]), ("files", [dict(files[0], sha256="X")] + files[1:]), ("error", "x")]
        for k, v in muts:
            with self.assertRaises(X.Refuse, msg=k):
                X.state_pins(dict(json.loads(json.dumps(rec)), **{k: v}), run)
        self.assertEqual(X.main(["state-pins", "--run-dir", self.d]), 3)

    def test_15_fixture_mode_never_touches_production(self):
        dp = os.path.join(self.d, "dp"); os.mkdir(dp)
        al = os.path.join(self.d, "a.json"); Path(al).write_text("[]")
        fx = ["--allowlist", al, "--uuid", "u", "--fuse2fs", "/x", "--fuse2fs-sha256", "0" * 64, "--view-target", "t", "--fs-blocks", "1"]
        good_dest = X.E2E_PARENT + "/compact-header-e2e-20261101T000000Z-1/work/dest-1"
        for args in (["--dest-parent", good_dest, "--backup", X.PROD["backup"]],                 # the production backup
                     ["--dest-parent", dp, "--backup", os.path.join(self.d, "f.qcow2")],         # dest outside the /vm E2E workspace
                     ["--dest-parent", good_dest, "--backup", os.path.join(self.d, "f.qcow2"), "--floor-bytes", "0"],
                     ["--dest-parent", good_dest, "--backup", os.path.join(self.d, "f.qcow2"), "--host-mem-floor", "0"]):
            self.assertEqual(X.main(["run", "--fixture", *args, *fx]), 3, args)
        self.assertEqual(os.listdir(dp), [])

    def test_16_metadata_fixture_mirrors_production(self):
        c = MM.commands("/w")
        for want in ("sif data mode 040750", "sif data uid 994", "sif data gid 985", "sif data/reth.toml mode 0100640",
                     "sif data/reth.toml mtime @1793026310", f"sif data/reth.toml mtime_extra {98139981 << 2}"):
            self.assertIn(want, c)
        reth = MM.expected_allowlist()[0]
        prod = X.PROD_ALLOWLIST[0]
        self.assertEqual({k: reth[k] for k in ("path", "mode", "uid", "gid", "mtime_ns", "nlink", "size")},
                         {k: prod[k] for k in ("path", "mode", "uid", "gid", "mtime_ns", "nlink", "size")})
        self.assertNotEqual(MM.UUID, X.PROD["uuid"])
        self.assertEqual(X.validate_allowlist(MM.expected_allowlist())[1], 2590 + 75)


if __name__ == "__main__":
    unittest.main(verbosity=2)
