#!/usr/bin/env python3
"""Offline tests of reclaim.py on TEMP fixtures only (the frozen r5 relocation fixtures, imported by hash): no root, no loop
devices, no real /vm or USB. The relocation phases up to cut-over are the real r5 tool; reclaim is exercised end to end."""
import contextlib, hashlib, io, json, os, shutil, stat, sys, tempfile, types, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
R5 = os.path.join(os.path.dirname(STAGE), "nvme-cold-relocation-stage", "r5")
sys.path.insert(0, STAGE); sys.path.insert(0, os.path.join(R5, "tests")); sys.path.insert(0, R5)
import reclaim as RC  # noqa: E402
import test_relocate as T  # noqa: E402  (frozen r5 fixtures: FakeEnv, Base, helpers)

MAX_AGE = 300


class Crash(Exception):
    pass


def tree_hashes(root):
    out = {}
    for d, ds, fs in os.walk(root):
        for f in fs:
            p = os.path.join(d, f)
            if not os.path.islink(p):
                with open(p, "rb") as fh:
                    out[os.path.relpath(p, root)] = hashlib.sha256(fh.read()).hexdigest()
    return out


@unittest.skipUnless(T.RSYNC, "rsync is required")
class Reclaim(T.Base):
    def setUp(self):
        super().setUp()
        self.assertEqual(hashlib.sha256(T._rb(T.R.__file__)).hexdigest(), RC.RELOCATE_SHA256, "the r5 tool under test is the pinned one")
        self.dst = self.cfg["target_mount"] + "/enclave-volumes/codex-archive"
        self.ret = self.vm + "/.retire-codex-archive"

    def rrun(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = RC.main(list(args) + ["--config", self.cfgp, "--tree", "codex-archive"], self.env, T.R)
        return rc, out.getvalue(), err.getvalue()

    def rok(self, *args):
        rc, out, err = self.rrun(*args)
        self.assertEqual(rc, 0, f"{args}: {err}")
        return json.loads(out)

    def rrefused(self, needle, *args):
        rc, out, err = self.rrun(*args)
        self.assertEqual(rc, 3, f"{args} should refuse: {out}")
        self.assertIn(needle, err)

    def cut_over(self):
        self.to_verified(); self.writer_check()
        self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")

    def rwc(self):
        self.env.uid = 0
        try:
            return self.rok("writer-check")
        finally:
            self.env.uid = 4242

    def attest(self, identity):
        return ("reclaim", "--identity", identity, "--hold-attestation", "hold ended 2026-11-01; owner used the USB copy",
                "--apps-stopped-attestation", "archive readers stopped by owner")

    def state(self):
        return json.loads(T._rt(self.cfg["journal_dir"] + "/state.json"))["trees"]["codex-archive"].get("reclaim", {})

    # -------------------------------------------------------------------------------------------------------------
    def test_plan_reclaim_frees_actual_space_and_keeps_the_usb_copy(self):
        T.mkfile(self.arch + "/2026-10-24/big.bin", os.urandom(16 << 20))
        self.cut_over()
        before_usb = tree_hashes(self.dst)
        p = self.rok("reclaim-plan")
        self.assertEqual(p["retired"], self.ret)
        script = T._rt(self.rok("emit-writer-check")["script"])
        self.assertIn(RC.RELOCATE_SHA256, script); self.assertIn(RC.self_sha(), script)
        self.rwc()
        out = self.rok(*self.attest(p["identity"]))
        self.assertGreaterEqual(out["freed_bytes"], (16 << 20) * 9 // 10, "the retired copy's blocks were actually released")
        self.assertFalse(os.path.lexists(self.ret))
        self.assertFalse([n for n in os.listdir(self.vm) if n.startswith(".reclaim-")])
        self.assertEqual(os.readlink(self.arch), self.dst)
        self.assertEqual(tree_hashes(self.dst), before_usb, "the USB copy is untouched")
        for i in range(3):
            self.assertTrue(os.path.exists(f"{self.home}/link{i}"))
        self.assertEqual(self.state()["state"], "complete")
        self.assertIn("already", self.rok(*self.attest(p["identity"])))
        self.assertIn("already", self.rok("reclaim-plan"))

    def test_wrong_identity_or_missing_attestations_delete_nothing(self):
        self.cut_over()
        ident = T.R.identity_now(self.ret)
        p = self.rok("reclaim-plan"); self.rwc()
        self.rrefused("--identity does not match", *self.attest("0" * 64))
        a = list(self.attest(p["identity"]))
        self.rrefused("--hold-attestation", *a[:3], *a[5:])
        self.rrefused("--apps-stopped-attestation", *a[:5])
        self.assertEqual(T.R.identity_now(self.ret), ident)
        self.assertEqual(self.state()["state"], "planned")

    def test_changed_retired_copy_is_never_reclaimed(self):
        self.cut_over()
        T.mkfile(self.ret + "/2026-10-24/late-writer.txt", b"written in the race window")
        self.rrefused("retired tree differs from the verified source", "reclaim-plan")
        os.unlink(self.ret + "/2026-10-24/late-writer.txt")
        self.rrefused("retired tree differs", "reclaim-plan")         # the directory's own metadata changed too
        self.assertTrue(os.path.isfile(self.ret + "/2026-10-24/a/b/data.bin"))

    def test_changed_usb_copy_blocks_reclaim_after_plan(self):
        self.cut_over()
        p = self.rok("reclaim-plan"); self.rwc()
        with open(self.arch + "/2026-10-24/app-write.txt", "w") as f:          # through the cut-over symlink
            f.write("new data on USB")
        self.rrefused("USB copy differs from the verified tree", *self.attest(p["identity"]))
        self.assertTrue(os.path.isdir(self.ret))

    def test_users_staleness_incomplete_visibility_and_coverage(self):
        self.cut_over()
        p = self.rok("reclaim-plan")
        self.rrefused("no root reclaim writer-check", *self.attest(p["identity"]))
        self.rrefused("must run as root", "writer-check")
        pd = self.env.proc + "/300"; os.makedirs(pd + "/fd")
        for n in ("cwd", "root", "exe"):
            os.symlink("/", f"{pd}/{n}")
        T._w(pd + "/maps", "")
        os.symlink(self.ret + "/2026-10-24/a/b/data.bin", pd + "/fd/4")
        self.assertEqual(self.rwc()["hits"], 1)
        self.rrefused("active users", *self.attest(p["identity"]))
        os.unlink(pd + "/fd/4")
        self.env.unreadable = ("300",)
        self.assertEqual(self.rwc()["complete"], False)
        self.rrefused("visibility was incomplete", *self.attest(p["identity"]))
        self.env.unreadable = ()
        self.rwc(); self.env.t += MAX_AGE + 1
        self.rrefused("stale", *self.attest(p["identity"]))
        self.rwc()
        p2 = self.rok("reclaim-plan")                                   # a new plan = a new reclaim path (nonce)
        self.rrefused("does not cover", *self.attest(p2["identity"]))
        self.rwc()
        self.rok(*self.attest(p2["identity"]))

    def test_symlinked_retire_path_and_foreign_source_link_refuse(self):
        self.cut_over()
        moved = self.tmp + "/elsewhere"
        os.rename(self.ret, moved); os.symlink(moved, self.ret)
        self.rrefused("symlink in path", "reclaim-plan")
        os.unlink(self.ret); os.rename(moved, self.ret)
        os.unlink(self.arch); os.symlink(self.ret, self.arch)
        self.rrefused("is not our symlink to the verified USB copy", "reclaim-plan")
        os.unlink(self.arch); os.symlink(self.dst, self.arch)
        self.rok("reclaim-plan")

    def test_entry_checks_refuse_other_device_inode_type_size_and_link_target(self):
        rc = RC.Reclaim.__new__(RC.Reclaim); rc.R = T.R; rc.rc = {"root": [7, 1]}
        st = lambda **k: types.SimpleNamespace(**{"st_mode": stat.S_IFREG | 0o644, "st_dev": 7, "st_ino": 9, "st_size": 3,
                                                   "st_mtime_ns": 5, "st_ctime_ns": 6, "st_nlink": 1, **k})
        m = {"t": "f", "ino": 9, "m": 0o644, "s": 3, "mt": 5, "ctime": 6, "nl": 1}
        rc.check_entry(st(), m, "f", "f", None)
        for bad, needle in [({"st_dev": 8}, "another device"), ({"st_ino": 10}, "inode"), ({"st_size": 4}, "changed"),
                            ({"st_mtime_ns": 50}, "changed"), ({"st_ctime_ns": 60}, "changed"),
                            ({"st_mode": stat.S_IFDIR | 0o755}, "type changed"), ({"st_mode": stat.S_IFREG | 0o600}, "mode")]:
            with self.assertRaises(T.R.Refuse) as c:
                rc.check_entry(st(**bad), m, "f", "f", None)
            self.assertIn(needle, str(c.exception))
        rc.check_entry(st(st_ctime_ns=60, st_nlink=2), dict(m, nl=3), "f", "f", None)   # a sibling link was removed: ok
        d = tempfile.mkdtemp(dir=self.tmp); os.symlink("target-a", d + "/l")
        dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
        try:
            ls = os.lstat("l", dir_fd=dfd)
            lm = {"t": "l", "ino": ls.st_ino, "m": stat.S_IMODE(ls.st_mode), "l": "target-b"}
            rc.rc = {"root": [ls.st_dev, 1]}
            with self.assertRaises(T.R.Refuse) as c:
                rc.check_entry(ls, lm, "l", "l", dfd)
            self.assertIn("symlink target changed", str(c.exception))
        finally:
            os.close(dfd)

    def crash_after(self, n, names=("unlink", "rmdir")):
        real = {k: getattr(os, k) for k in names}
        count = [0]
        def wrap(k):
            def f(*a, **kw):
                count[0] += 1
                if count[0] > n:
                    raise Crash(k)
                return real[k](*a, **kw)
            return f
        for k in names: setattr(os, k, wrap(k))
        return lambda: [setattr(os, k, v) for k, v in real.items()]

    def reclaim_dir(self):
        return [os.path.join(self.vm, n) for n in os.listdir(self.vm) if n.startswith(".reclaim-")]

    def test_crash_mid_deletion_resume_revalidates_and_stops_on_injected_entries(self):
        self.cut_over()
        p = self.rok("reclaim-plan"); self.rwc()
        undo = self.crash_after(3)
        try:
            with self.assertRaises(Crash):
                self.rrun(*self.attest(p["identity"]))
        finally:
            undo()
        self.assertEqual(self.state()["state"], "deleting")
        (rd,) = self.reclaim_dir()
        T.mkfile(rd + "/2026-10-24/injected.txt", b"not part of the verified tree")
        remaining = sorted(os.path.relpath(os.path.join(d, f), rd) for d, ds, fs in os.walk(rd) for f in fs + ds)
        self.rrefused("not in the original inventory", *self.attest(p["identity"]))
        self.assertEqual(sorted(os.path.relpath(os.path.join(d, f), rd) for d, ds, fs in os.walk(rd) for f in fs + ds), remaining,
                         "nothing more was deleted")
        os.unlink(rd + "/2026-10-24/injected.txt")
        out = self.rok(*self.attest(p["identity"]))
        self.assertEqual(out["reclaimed"], "codex-archive"); self.assertEqual(self.reclaim_dir(), [])
        self.assertIn("resume-validated", T._rt(self.cfg["journal_dir"] + "/events.jsonl"))

    def test_crash_resume_refuses_a_changed_remaining_file(self):
        self.cut_over()
        p = self.rok("reclaim-plan"); self.rwc()
        undo = self.crash_after(3)
        try:
            with self.assertRaises(Crash):
                self.rrun(*self.attest(p["identity"]))
        finally:
            undo()
        (rd,) = self.reclaim_dir()
        f = rd + "/2026-10-24/exe.sh"; st = os.lstat(f)
        with open(f, "r+b") as fh:
            fh.write(b"#!/bin/xx\n")                                  # same size
        os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))                # same mtime
        self.rrefused("changed since the inventory", *self.attest(p["identity"]))
        self.assertTrue(os.path.exists(f))

    def test_crash_between_intent_and_rename_resumes_with_full_revalidation(self):
        self.cut_over()
        p = self.rok("reclaim-plan"); self.rwc()
        real = os.rename
        def boom(a, b, *k, **kw):
            if "/.reclaim-" in str(b):
                raise Crash("rename")
            return real(a, b, *k, **kw)
        os.rename = boom
        try:
            with self.assertRaises(Crash):
                self.rrun(*self.attest(p["identity"]))
        finally:
            os.rename = real
        self.assertEqual(self.state()["state"], "intent")
        self.assertTrue(os.path.isdir(self.ret))
        man = self.state()["manifest"]
        self.assertEqual(stat.S_IMODE(os.lstat(self.cfg["journal_dir"] + "/" + man).st_mode), 0o600, "durable private intent")
        self.rok(*self.attest(p["identity"]))
        self.assertFalse(os.path.lexists(self.ret))
        self.assertIn("resume-validated", T._rt(self.cfg["journal_dir"] + "/events.jsonl"))

    def test_deletion_never_escapes_the_renamed_tree(self):
        outside = self.tmp + "/outside.txt"; T.mkfile(outside, b"must survive")
        os.symlink(outside, self.arch + "/2026-10-24/abs-link-outside")
        self.cut_over()
        before_usb = tree_hashes(self.dst)
        p = self.rok("reclaim-plan"); self.rwc()
        calls, real = [], {k: getattr(os, k) for k in ("unlink", "rmdir", "remove", "removedirs")}
        def spy(k):
            def f(path, *a, dir_fd=None, **kw):
                where = os.readlink(f"/proc/self/fd/{dir_fd}") if dir_fd is not None else None
                calls.append((k, path, where))
                return real[k](path, *a, dir_fd=dir_fd, **kw) if dir_fd is not None else real[k](path, *a, **kw)
            return f
        for k in real: setattr(os, k, spy(k))
        try:
            self.rok(*self.attest(p["identity"]))
        finally:
            for k, v in real.items(): setattr(os, k, v)
        self.assertTrue(calls)
        rpath = self.vm + "/.reclaim-codex-archive-" + self.state()["nonce"]
        for k, path, where in calls:
            self.assertIn(k, ("unlink", "rmdir"))
            self.assertIsNotNone(where, "every removal is relative to a verified directory fd")
            self.assertTrue(where == rpath or where.startswith(rpath + "/") or (where == self.vm and path == os.path.basename(rpath)),
                            (k, path, where))
        self.assertEqual(T._rb(outside), b"must survive")
        self.assertEqual(tree_hashes(self.dst), before_usb)

    def test_unwritable_directory_is_refused_before_the_intent(self):
        os.chmod(self.arch + "/2026-10-24/private", 0o500)
        self.cut_over()
        p = self.rok("reclaim-plan"); self.rwc()
        self.rrefused("not owner-owned with u+wx", *self.attest(p["identity"]))
        self.assertEqual(self.state()["state"], "planned")
        self.assertTrue(os.path.isdir(self.ret))
        os.chmod(self.ret + "/2026-10-24/private", 0o700)               # (fixture cleanup)

    def test_pin_loader_runs_only_the_reviewed_relocation_bytes(self):
        good = RC.load_relocate()
        self.assertEqual(hashlib.sha256(T._rb(good.__file__)).hexdigest(), RC.RELOCATE_SHA256)
        bad = self.tmp + "/relocate.py"; shutil.copy(RC.RELOCATE_PATH, bad); T._a(bad, "\n# changed\n")
        with self.assertRaises(SystemExit):
            RC.load_relocate(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
