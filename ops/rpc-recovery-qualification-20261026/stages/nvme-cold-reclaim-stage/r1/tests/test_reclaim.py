#!/usr/bin/env python3
"""reclaim-r1 offline tests on TEMP fixture trees only (no root, no mounts, no real /vm, /, archive or home paths).
The state reclaim consumes is produced by the REAL frozen r8 phases (inventory, copy, verify, root writer-check on stdout,
record-writer-check, cutover) driven on the fixture; mounts, cgroup lane, MemAvailable, free space and /proc are FakeEnv values;
rsync is the real binary (RSYNC env or PATH), as in r8."""
import contextlib, hashlib, io, json, os, shutil, stat, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.dont_write_bytecode = True
import reclaim as C  # noqa: E402

ST, R = C.ST, C.R
RSYNC = os.environ.get("RSYNC") or shutil.which("rsync")
GIB = 1 << 30
LANE = 268435456
SUBS = ["2026-10-24/home/hf-convert", "2026-10-24/home/gvs5h", "2026-10-24/home/gguf-e2b"]
ATTEST = ["--apps-stopped-attestation", "cold archive: no users"]


def mkfile(p, data=b"", mode=0o644):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    os.chmod(p, mode)


class FakeEnv(C.Env):
    production = False

    def __init__(self, tmp):
        self.tmp, self.uid, self.t = tmp, 4242, 1_000_000.0
        self.proc = os.path.join(tmp, "proc"); os.makedirs(self.proc, exist_ok=True)
        self.sys_block = os.path.join(tmp, "sysblock"); os.makedirs(self.sys_block, exist_ok=True)
        self.lane, self.avail_mem, self.free_dest, self.free_src = str(LANE), 20 * GIB, 10 ** 13, 10 ** 9
        self.mounts_ok, self.dest_on_source = True, False
        self.mount_table = [{"majmin": "8:1", "root": "/", "point": f"{tmp}/vm", "fstype": "ext4", "source": "/dev/fakevm", "opts": [], "super": []},
                            {"majmin": "8:2", "root": "/", "point": f"{tmp}/root", "fstype": "ext4", "source": "/dev/fakeroot", "opts": [], "super": []}]

    def euid(self): return self.uid
    def now(self): return self.t
    def cgroup_max(self): return self.lane
    def mem_available(self): return self.avail_mem
    def mounts(self): return self.mount_table

    def statvfs(self, p):
        class V: pass
        v = V(); v.f_frsize = 1; v.f_bavail = self.free_src if p.startswith(f"{self.tmp}/vm") else self.free_dest
        return v

    def dev_of(self, p):
        p = ST.existing_ancestor(p)
        if p.startswith(f"{self.tmp}/vm"):
            return 1
        if p.startswith(f"{self.tmp}/root"):
            return 1 if self.dest_on_source else 2
        return 3

    def check_mounts(self, cfg):
        if not self.mounts_ok:
            R.refuse("wrong device")

    def check_mount(self, pin, path):
        if not self.mounts_ok:
            R.refuse("wrong device")

    def run_tail(self, argv):
        import subprocess
        r = subprocess.run(argv, capture_output=True)
        return r.returncode, r.stderr[-4096:].decode("utf-8", "replace")


class Base(unittest.TestCase):
    HARDLINK = False

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rec", dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, self.tmp, True)
        t = self.tmp
        self.arch = f"{t}/vm/enclave-volumes/codex-archive"; os.makedirs(os.path.dirname(self.arch)); os.mkdir(self.arch, 0o700)
        a = f"{self.arch}/2026-10-24"
        for s in SUBS:
            mkfile(f"{self.arch}/{s}/model/w.bin", os.urandom(200_000)); mkfile(f"{self.arch}/{s}/README", b"r")
            mkfile(f"{self.arch}/{s}/deep/x/y.bin", os.urandom(5000), 0o600)
        if self.HARDLINK:
            os.link(f"{self.arch}/{SUBS[1]}/README", f"{self.arch}/{SUBS[1]}/README.hl")
        mkfile(f"{a}/home/Projects/keep.bin", os.urandom(1000)); mkfile(f"{a}/other/x", b"x")
        self.home = f"{t}/home"; os.makedirs(self.home)
        ents = []
        for i, rel in enumerate([f"{SUBS[0]}/model/w.bin", f"{SUBS[2]}/README", "2026-10-24/other/x"]):
            dst = f"{self.arch}/{rel}"; src = f"{self.home}/link{i}"; os.symlink(dst, src)
            with open(dst, "rb") as f:
                ents.append({"source": src, "destination": dst, "bytes": os.path.getsize(dst), "sha256": hashlib.sha256(f.read()).hexdigest()})
        self.man = f"{a}/recovery-documents/artifact-relocation-manifest.json"; mkfile(self.man, json.dumps(ents).encode())
        uid = os.geteuid()
        j1381 = R.Journal({"journal_dir": f"{t}/j1381", "owner_uid": uid}, None, create=True)
        inv = R.inventory(self.arch, "source", "codex-archive", j1381)
        j1381.state["trees"]["codex-archive"] = {"source_inventory": inv}; j1381.save()
        os.makedirs(f"{t}/root/home/steven/.local/state")
        self.dest_root = f"{t}/root/home/steven/.cold-archive/codex-archive"
        with open(self.man, "rb") as f:
            msha = hashlib.sha256(f.read()).hexdigest()
        self.c8 = {"format": ST.FORMAT, "owner_uid": uid, "owner_gid": os.getegid(), "archive_root": self.arch, "subtrees": list(SUBS),
                   "dest_root": self.dest_root, "source_mount": {"path": f"{t}/vm", "fstype": "ext4", "device": "/dev/fakevm"},
                   "dest_mount": {"path": f"{t}/root", "fstype": "ext4", "device": "/dev/fakeroot"},
                   "manifest": {"path": self.man, "sha256": msha, "entries": 3},
                   "inventory_1381": {"journal_dir": f"{t}/j1381", "identity": inv["identity"], "logical": inv["logical"]},
                   "journal_dir": f"{t}/root/home/steven/.local/state/nvme-cold-subtree-r7", "rsync_path": RSYNC, "bwlimit_kib": 100000,
                   "queue_lane_bytes": LANE, "dest_floor_bytes": 300000000000, "writer_check_max_age_seconds": 300}
        self.c8p = f"{t}/cfg8.json"; self.put(self.c8p, self.c8)
        self.rjd = f"{t}/root/home/steven/.local/state/nvme-cold-reclaim-r1"
        self.rc = {"format": C.FORMAT, "subtree_config": self.c8p, "subtree_config_sha256": self.sha(self.c8p), "journal_dir": self.rjd,
                   "verify_max_age_seconds": 3600}
        self.rcp = f"{t}/reclaim.json"; self.put(self.rcp, self.rc)
        self.env = FakeEnv(t); self.n = 0

    # ---------------------------------------------------------------------------------------------------- helpers
    def put(self, p, obj, mode=0o600):
        with open(p, "w") as f:
            json.dump(obj, f)
        os.chmod(p, mode)

    def sha(self, p):
        with open(p, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    def run8(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = ST.main(list(args) + ["--config", self.c8p], self.env)
        self.assertEqual(rc, 0, err.getvalue()); return out.getvalue()

    def ph(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = C.main(list(args) + ["--config", self.rcp], self.env)
        return rc, out.getvalue(), err.getvalue()

    def ok(self, *args):
        rc, out, err = self.ph(*args); self.assertEqual(rc, 0, err); return json.loads(out)

    def refused(self, needle, *args):
        rc, out, err = self.ph(*args); self.assertEqual(rc, 3, out); self.assertIn(needle, err); return err

    def scan(self, **kw):
        """r8's root scanner (stdout) captured into an owner file, the way the handoff does it"""
        self.env.t += 5; self.env.uid = 0
        try:
            res = json.loads(self.run8("writer-check"))
        finally:
            self.env.uid = 4242
        res.update(kw); self.n += 1
        p = f"{self.tmp}/scan{self.n}.json"; self.put(p, res); return p

    def paths(self, sub):
        return f"{self.arch}/{sub}", f"{self.dest_root}/{sub}", f"{os.path.dirname(f'{self.arch}/{sub}')}/.retire-{os.path.basename(sub)}"

    def cut_over(self, *subs, fresh=()):
        for s in SUBS:
            if "source_inventory" not in self.r8_state().get(s, {}):
                self.run8("inventory-source", "--subtree", s, *(["--fresh-hash"] if s in fresh else []))
        for s in subs:
            self.run8("copy", "--subtree", s); self.run8("verify", "--subtree", s)
            self.run8("record-writer-check", "--result", self.scan())
            self.run8("cutover", "--subtree", s, *ATTEST)

    def r8_state(self):
        p = f"{self.c8['journal_dir']}/state.json"
        return json.load(open(p))["trees"] if os.path.exists(p) else {}

    def rstate(self, sub):
        p = f"{self.rjd}/state.json"
        return json.load(open(p))["trees"].get(sub, {}) if os.path.exists(p) else {}

    def prepared(self, sub=SUBS[2]):
        self.cut_over(sub); return self.ok("verify", "--subtree", sub)

    def reclaim(self, sub=SUBS[2], result=None, confirm=None):
        return self.ph("reclaim", "--subtree", sub, "--result", result or self.scan(), "--reclaim-retired", confirm or self.paths(sub)[2])

    def tree(self, root):
        out = {}
        for d, ds, fs in os.walk(root):
            for n in ds + fs:
                q = os.path.join(d, n); st = os.lstat(q); out[os.path.relpath(q, root)] = (st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        return out


class Reclaim(Base):
    def test_full_reclaim_of_one_tree_with_receipts_others_untouched(self):
        v = self.prepared()
        src, dst, ret = self.paths(SUBS[2])
        self.assertEqual((v["hashed_fresh"], v["plan_files"], v["plan_dirs"]), (3, 3, 4))
        others = {s: R.identity_now(f"{self.arch}/{s}") for s in SUBS[:2]}; dest_before = self.tree(dst)
        calls = []; real = (os.unlink, os.rmdir, shutil.rmtree)
        os.unlink = lambda p, *a, **k: (calls.append(("unlink", p, k.get("dir_fd"))), real[0](p, *a, **k))[1]
        os.rmdir = lambda p, *a, **k: (calls.append(("rmdir", p, k.get("dir_fd"))), real[1](p, *a, **k))[1]
        shutil.rmtree = lambda *a, **k: self.fail("recursive rm used")
        try:
            rc, out, err = self.reclaim()
        finally:
            os.unlink, os.rmdir, shutil.rmtree = real
        self.assertEqual(rc, 0, err); out = json.loads(out)
        self.assertFalse(os.path.lexists(ret))
        self.assertEqual((os.readlink(src), self.tree(dst)), (dst, dest_before))
        self.assertEqual(open(f"{self.home}/link1", "rb").read(), b"r")                    # the manifest link still resolves
        tree_calls = [c for c in calls if c[2] is not None]
        self.assertEqual(sorted(c[1] for c in tree_calls if c[0] == "unlink"), ["README", "w.bin", "y.bin"])
        self.assertEqual(len([c for c in tree_calls if c[0] == "rmdir"]), 4)
        self.assertEqual([c for c in calls if c[2] is None and not c[1].startswith(self.tmp + "/root")], [])  # only dir_fd removals
        self.assertEqual(out["deleted_journalled"], {"files": 3, "dirs": 4, "bytes": out["plan"]["bytes"]})
        self.assertTrue(all(out["post_checks"].values()))
        for f in ("verify-gguf-e2b.json", "reclaimed-gguf-e2b.json", out["dest_logical_file"], *out["scan_files"]):
            self.assertTrue(os.path.isfile(f"{self.rjd}/{f}"), f)
        self.assertEqual({s: R.identity_now(f"{self.arch}/{s}") for s in SUBS[:2]}, others)
        self.assertEqual(self.ok("reclaim", "--subtree", SUBS[2], "--result", self.scan(), "--reclaim-retired", ret), {"already": "complete"})
        self.assertEqual(self.ok("check-retained", "--subtree", SUBS[2])["hashed_fresh"], 3)
        with self.assertRaises(AssertionError):                       # r8 rollback after reclaim fails closed, changes nothing
            self.run8("rollback", "--subtree", SUBS[2])
        self.assertEqual(os.readlink(src), dst)

    def test_requires_complete_consistent_r8_cutover(self):
        self.cut_over()
        self.run8("copy", "--subtree", SUBS[2]); self.run8("verify", "--subtree", SUBS[2])
        self.refused("not complete", "verify", "--subtree", SUBS[2])
        self.run8("record-writer-check", "--result", self.scan()); self.run8("cutover", "--subtree", SUBS[2], *ATTEST)
        p = f"{self.c8['journal_dir']}/state.json"; st = json.load(open(p))
        for k, v in (("cutover", "renamed"), ("verified", None)):
            bad = json.loads(json.dumps(st)); bad["trees"][SUBS[2]][k] = v
            with open(p, "w") as f:
                json.dump(bad, f)
            self.refused("r8", "verify", "--subtree", SUBS[2])
        with open(p, "w") as f:
            json.dump(st, f)
        self.ok("verify", "--subtree", SUBS[2])
        self.run8("rollback", "--subtree", SUBS[2])                   # before reclaim, r8 rollback is the recovery and still works
        self.assertTrue(os.path.isdir(self.paths(SUBS[2])[0]) and not os.path.islink(self.paths(SUBS[2])[0]))
        self.refused("not complete", "reclaim", "--subtree", SUBS[2], "--result", self.scan(), "--reclaim-retired", self.paths(SUBS[2])[2])

    def test_verify_rehashes_every_destination_byte(self):
        self.cut_over(SUBS[2])
        src, dst, ret = self.paths(SUBS[2])
        with open(f"{dst}/README", "r+b") as f:                       # same size, same mtime: only the bytes differ
            f.write(b"X")
        os.utime(f"{dst}/README", ns=(os.lstat(f"{ret}/README").st_atime_ns, os.lstat(f"{ret}/README").st_mtime_ns))
        p = f"{self.c8['journal_dir']}/state.json"; st = json.load(open(p))  # model corruption that metadata does not show
        st["trees"][SUBS[2]]["dest_identity_at_cutover"] = R.identity_now(dst)
        with open(p, "w") as f:
            json.dump(st, f)
        self.refused("content differs", "verify", "--subtree", SUBS[2])
        self.assertNotIn("verified", self.rstate(SUBS[2])); self.assertTrue(os.path.isdir(ret))
        self.refused("verify first", "reclaim", "--subtree", SUBS[2], "--result", self.scan(), "--reclaim-retired", ret)
        self.assertEqual(len(self.tree(ret)), 6)

    def test_changed_retired_tree_destination_or_receipt_refused_nothing_deleted(self):
        self.prepared(); src, dst, ret = self.paths(SUBS[2]); before = self.tree(ret)
        mkfile(f"{ret}/deep/unknown", b"u")
        self.refused("changed since the verify receipt", "reclaim", "--subtree", SUBS[2], "--result", self.scan(), "--reclaim-retired", ret)
        self.assertTrue(os.path.exists(f"{ret}/deep/unknown")); os.unlink(f"{ret}/deep/unknown")
        os.utime(f"{ret}/deep", ns=(before["deep"][2], before["deep"][2]))
        self.refused("changed since the verify receipt", "reclaim", "--subtree", SUBS[2], "--result", self.scan(), "--reclaim-retired", ret)
        self.tearDown(); self.setUp(); self.prepared(); src, dst, ret = self.paths(SUBS[2])
        mkfile(f"{dst}/new-after-verify", b"n")
        self.refused("destination changed", "reclaim", "--subtree", SUBS[2], "--result", self.scan(), "--reclaim-retired", ret)
        os.unlink(f"{dst}/new-after-verify")
        p = f"{self.rjd}/verify-gguf-e2b.json"; rec = json.load(open(p)); rec["plan"] = rec["plan"][:1]
        with open(p, "w") as f:
            json.dump(rec, f, sort_keys=True)
        self.refused("receipt differs", "reclaim", "--subtree", SUBS[2], "--result", self.scan(), "--reclaim-retired", ret)
        self.assertEqual(len(self.tree(ret)), 6)

    def test_root_scan_gates_and_per_tree_blocking(self):
        self.cut_over(SUBS[2], SUBS[1]); self.ok("verify", "--subtree", SUBS[2]); self.ok("verify", "--subtree", SUBS[1])
        ret2, ret1 = self.paths(SUBS[2])[2], self.paths(SUBS[1])[2]
        self.refused("--result FILE", "reclaim", "--subtree", SUBS[2], "--reclaim-retired", ret2)
        for kw, needle in (({"complete": False}, "incomplete"), ({"euid": 1000}, "not a root scan"), ({"format": "x"}, "not a root scan"),
                           ({"tools": {"subtree.py": "0" * 64, "relocate.py": C.R5_RELOCATE_SHA256}}, "other tool bytes"),
                           ({"prefixes": []}, "does not cover"), ({"t": 1.0}, "stale")):
            self.assertEqual(self.reclaim(result=self.scan(**kw))[0], 3, kw)
        old = self.scan(); self.env.t += 301; self.refused("stale", "reclaim", "--subtree", SUBS[2], "--result", old, "--reclaim-retired", ret2)
        early = self.scan(); self.ok("verify", "--subtree", SUBS[2])                  # a scan older than the receipt
        self.refused("older than the verify receipt", "reclaim", "--subtree", SUBS[2], "--result", early, "--reclaim-retired", ret2)
        pid = f"{self.env.proc}/4321"; os.makedirs(f"{pid}/fd"); open(f"{pid}/maps", "w").close()
        os.symlink(f"{ret2}/model", f"{pid}/cwd"); os.symlink("/", f"{pid}/root"); os.symlink("/usr/bin/python3", f"{pid}/exe")
        self.assertIn("active users", self.reclaim(SUBS[2])[2])                       # a real user blocks ITS tree ...
        self.assertTrue(os.path.isdir(ret2))
        rc, out, err = self.reclaim(SUBS[1]); self.assertEqual(rc, 0, err)            # ... and only that tree
        self.assertFalse(os.path.lexists(ret1)); self.assertEqual(json.loads(out)["deleted_journalled"]["files"], 3)
        shutil.rmtree(pid)
        used = self.scan(); self.assertEqual(self.reclaim(SUBS[2], result=used)[0], 0)
        self.assertFalse(os.path.lexists(ret2))

    def test_crash_mid_delete_resumes_never_deletes_unplanned_and_scans_are_single_use(self):
        self.prepared(); src, dst, ret = self.paths(SUBS[2])
        real, n = os.unlink, [0]
        def flaky(p, *a, **k):
            n[0] += k.get("dir_fd") is not None
            if n[0] == 2 and k.get("dir_fd") is not None:
                raise OSError(5, "simulated I/O error")
            return real(p, *a, **k)
        os.unlink = flaky
        try:
            used = self.scan(); self.assertIn("interrupted", self.reclaim(result=used)[2])
        finally:
            os.unlink = real
        self.assertEqual(self.rstate(SUBS[2])["reclaim"], "deleting"); left = self.tree(ret); self.assertEqual(len(left), 5)
        self.refused("already used", "reclaim", "--subtree", SUBS[2], "--result", used, "--reclaim-retired", ret)
        mkfile(f"{ret}/model/planted", b"p")                                         # unrecognized: never deleted, nothing else either
        self.assertIn("unrecognized entries", self.reclaim()[2])
        self.assertTrue(os.path.exists(f"{ret}/model/planted")); self.assertEqual(len(self.tree(ret)), 6)
        os.unlink(f"{ret}/model/planted")
        with open(f"{ret}/README", "ab") as f:                # a NEW inode under an already-removed planned name: refused too
            f.write(b"+")
        self.assertIn("differs from the verified plan", self.reclaim()[2]); self.assertTrue(os.path.exists(f"{ret}/README"))
        self.tearDown(); self.setUp(); self.prepared(); src, dst, ret = self.paths(SUBS[2])
        os.unlink = flaky; n[0] = 0
        try:
            self.assertIn("interrupted", self.reclaim()[2])
        finally:
            os.unlink = real
        rc, out, err = self.reclaim(); self.assertEqual(rc, 0, err)                  # resume: same per-entry checks, completes
        self.assertFalse(os.path.lexists(ret)); self.assertEqual(json.loads(out)["deleted_journalled"]["files"], 3)
        self.assertEqual(os.readlink(src), dst)

    def test_crash_before_top_rmdir_resumes(self):
        self.prepared(); src, dst, ret = self.paths(SUBS[2])
        real = os.rmdir
        os.rmdir = lambda p, *a, **k: (_ for _ in ()).throw(OSError(16, "busy")) if p == os.path.basename(ret) else real(p, *a, **k)
        try:
            self.assertIn("interrupted", self.reclaim()[2])
        finally:
            os.rmdir = real
        self.assertEqual(self.rstate(SUBS[2])["reclaim"], "rmdir-top"); self.assertEqual(os.listdir(ret), [])
        mkfile(f"{ret}/late", b"l"); self.assertIn("unrecognized entries left", self.reclaim()[2]); self.assertTrue(os.path.exists(f"{ret}/late"))
        os.unlink(f"{ret}/late")
        rc, out, err = self.reclaim(); self.assertEqual(rc, 0, err); self.assertFalse(os.path.lexists(ret))

    def test_mounts_devices_symlinks_and_floor_refused(self):
        self.prepared(); src, dst, ret = self.paths(SUBS[2]); before = self.tree(ret)
        t = self.env.mount_table
        for bad, needle in ((t + [dict(t[0], majmin="8:9", point=f"{ret}/model")], "mount point inside"),
                            (t + [dict(t[0], point=f"{self.tmp}/elsewhere")], "mounted more than once"),
                            ([dict(t[0], root="/enclave-volumes"), t[1]], "exactly once")):
            self.env.mount_table = bad; self.assertIn(needle, self.reclaim()[2])
        self.env.mount_table = t
        self.env.mounts_ok = False; self.assertIn("wrong device", self.reclaim()[2]); self.env.mounts_ok = True
        self.env.dest_on_source = True; self.assertEqual(self.reclaim()[0], 3); self.env.dest_on_source = False
        self.env.free_dest = self.c8["dest_floor_bytes"] - 1; self.assertIn("floor", self.reclaim()[2]); self.env.free_dest = 10 ** 13
        self.env.lane = "max"; self.assertIn("queue lane", self.reclaim()[2]); self.env.lane = str(LANE)
        self.env.avail_mem = 16 * GIB - 1; self.assertIn("16 GiB", self.reclaim()[2]); self.env.avail_mem = 20 * GIB
        self.assertIn("must name exactly", self.reclaim(confirm=ret + "/")[2])
        os.rename(ret, ret + ".real"); os.symlink(ret + ".real", ret)              # a symlink in place of the retired tree
        self.assertEqual(self.reclaim()[0], 3); self.assertEqual(self.tree(ret + ".real"), before)
        os.unlink(ret); os.rename(ret + ".real", ret)
        scan = self.scan(); self.env.production = True; self.env.uid = 0          # (the r8 scan is taken first, as root does)
        self.assertIn("never root", self.reclaim(result=scan)[2]); self.env.production = False; self.env.uid = 4242
        self.rc["subtree_config_sha256"] = "0" * 64; self.put(self.rcp, self.rc); self.assertIn("pinned bytes", self.reclaim()[2])
        self.assertEqual(self.tree(ret), before)


class Hardlinks(Base):
    HARDLINK = True

    def test_hardlinked_tree_is_not_reclaimed(self):
        self.cut_over(SUBS[1], fresh=(SUBS[1],))
        self.refused("hardlinked", "verify", "--subtree", SUBS[1])
        self.assertTrue(os.path.exists(self.paths(SUBS[1])[2] + "/README.hl"))


class Stage(unittest.TestCase):
    def test_r8_is_reused_by_pinned_bytes_only(self):
        for n, want in (("subtree.py", C.R8_SUBTREE_SHA256), ("relocate.py", C.R5_RELOCATE_SHA256)):
            with open(os.path.join(C.R8_DIR, n), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), want)
        txt = open(os.path.join(os.path.dirname(HERE), "reclaim.py")).read()
        for banned in ("rmtree", "os.system", "subprocess", "glob", "shell=True", "os.walk("):
            self.assertNotIn(banned, txt, banned)


if __name__ == "__main__":
    unittest.main()
