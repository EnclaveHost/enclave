#!/usr/bin/env python3
"""r7 subtree.py offline tests (r6 + root 1523: no guard JSON, low source free, writes pinned to the destination fs) on TEMP fixture trees only: no root, no mounts, no real /vm, /, archive or home paths.
Mounts, cgroup lane, MemAvailable and free space are FakeEnv values; rsync is the real binary (RSYNC env or PATH), as in r5.
The "1381" journal is produced by r5's own inventory() on the fixture archive, so its digests are real."""
import contextlib, hashlib, io, json, os, shutil, stat, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.dont_write_bytecode = True
import subtree as S  # noqa: E402

R = S.R
RSYNC = os.environ.get("RSYNC") or shutil.which("rsync")
GIB = 1 << 30
LANE = 268435456
SUBS = ["2026-10-24/home/hf-convert", "2026-10-24/home/gvs5h", "2026-10-24/home/gguf-e2b"]


def mkfile(p, data=b"", mode=0o644):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    os.chmod(p, mode)


class FakeEnv(S.Env):
    production = False

    def __init__(self, tmp):
        self.tmp, self.uid, self.t = tmp, 4242, 1_000_000.0
        self.proc = os.path.join(tmp, "proc"); os.makedirs(self.proc, exist_ok=True)
        self.sys_block = os.path.join(tmp, "sysblock"); os.makedirs(self.sys_block, exist_ok=True)
        self.lane, self.avail_mem, self.free_dest, self.mounts_ok = str(LANE), 20 * GIB, 10 ** 13, True
        self.free_src = 1_000_000_000          # r7: /vm almost full (1 GB) by default: relief must still copy
        self.dest_on_source = False

    def euid(self): return self.uid
    def now(self): return self.t
    def cgroup_max(self): return self.lane
    def mem_available(self): return self.avail_mem

    def statvfs(self, p):
        class V: pass
        v = V(); v.f_frsize = 1; v.f_bavail = self.free_src if p.startswith(f"{self.tmp}/vm") else self.free_dest
        return v

    def dev_of(self, p):                       # fixture filesystems: t/vm = source (1), t/root = destination (2)
        p = S.existing_ancestor(p)
        if p.startswith(f"{self.tmp}/vm"):
            return 1
        if p.startswith(f"{self.tmp}/root"):
            return 1 if self.dest_on_source else 2
        return 3

    def check_mounts(self, cfg):
        if not self.mounts_ok:
            R.refuse("wrong device")

    def run(self, argv):
        import subprocess
        return subprocess.run(argv, capture_output=True).returncode


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sub", dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, self.tmp, True)
        t = self.tmp
        self.arch = f"{t}/vm/enclave-volumes/codex-archive"; os.makedirs(os.path.dirname(self.arch)); os.mkdir(self.arch, 0o700)
        a = f"{self.arch}/2026-10-24"
        for s in SUBS:
            mkfile(f"{self.arch}/{s}/model/w.bin", os.urandom(200_000)); mkfile(f"{self.arch}/{s}/README", b"r")
        mkfile(f"{a}/home/Projects/keep.bin", os.urandom(1000)); mkfile(f"{a}/other/x", b"x")
        self.home = f"{t}/home"; os.makedirs(self.home)
        ents = []
        for i, rel in enumerate([f"{SUBS[0]}/model/w.bin", f"{SUBS[2]}/README", "2026-10-24/other/x"]):
            dst = f"{self.arch}/{rel}"; src = f"{self.home}/link{i}"; os.symlink(dst, src)
            with open(dst, "rb") as f:
                ents.append({"source": src, "destination": dst, "bytes": os.path.getsize(dst), "sha256": hashlib.sha256(f.read()).hexdigest()})
        self.man = f"{a}/recovery-documents/artifact-relocation-manifest.json"; mkfile(self.man, json.dumps(ents).encode())
        uid = os.geteuid()
        # root 1381 stand-in: r5's own inventory of the whole fixture archive
        j1381 = R.Journal({"journal_dir": f"{t}/j1381", "owner_uid": uid}, None, create=True)
        inv = R.inventory(self.arch, "source", "codex-archive", j1381)
        j1381.state["trees"]["codex-archive"] = {"source_inventory": inv}; j1381.save()
        self.inv1381 = inv
        os.makedirs(f"{t}/root/home/steven")
        self.dest_root = f"{t}/root/home/steven/.cold-archive/codex-archive"
        self.guard = f"{t}/guard-status.json"; self.write_stopped_guard()
        with open(self.man, "rb") as f:
            msha = hashlib.sha256(f.read()).hexdigest()
        self.cfg = {"format": S.FORMAT, "owner_uid": uid, "owner_gid": os.getegid(), "archive_root": self.arch, "subtrees": list(SUBS),
                    "dest_root": self.dest_root, "source_mount": {"path": f"{t}/vm", "fstype": "ext4", "device": "/dev/fakevm"},
                    "dest_mount": {"path": f"{t}/root", "fstype": "ext4", "device": "/dev/fakeroot"},
                    "manifest": {"path": self.man, "sha256": msha, "entries": 3},
                    "inventory_1381": {"journal_dir": f"{t}/j1381", "identity": inv["identity"], "logical": inv["logical"]},
                    "journal_dir": f"{t}/root/home/steven/.local/state/nvme-cold-subtree-r7", "rsync_path": RSYNC, "bwlimit_kib": 100000,
                    "queue_lane_bytes": LANE, "dest_floor_bytes": 300000000000, "writer_check_max_age_seconds": 300}
        self.jd = self.cfg["journal_dir"]; os.makedirs(os.path.dirname(self.jd), exist_ok=True)
        self.write_cfg(); self.env = FakeEnv(t)

    def write_stopped_guard(self):
        """root 1523: the REAL stopped-VM guard-status.json shape: no thresholds, stale free"""
        with open(self.guard, "w") as f:
            json.dump({"state": "stopped", "free": {"nvme": 544182374400}, "manifestSha": "fd71831c7f54b79e22596ae566e21521b67979e81fa8decf886c61d90f199ca3"}, f)

    def write_cfg(self):
        self.cfgp = f"{self.tmp}/cfg.json"
        with open(self.cfgp, "w") as f:
            json.dump(self.cfg, f)
        os.chmod(self.cfgp, 0o600)

    def ph(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = S.main(list(args) + ["--config", self.cfgp], self.env)
        return rc, out.getvalue(), err.getvalue()

    def ok(self, *args):
        rc, out, err = self.ph(*args); self.assertEqual(rc, 0, err); return json.loads(out)

    def refused(self, needle, *args):
        rc, out, err = self.ph(*args); self.assertEqual(rc, 3, out); self.assertIn(needle, err); return err

    def writer_check(self, **kw):
        res = {"complete": True, "hits": [], "incomplete": [], "entries": 1, "t": self.env.now(),
               "prefixes": sorted(os.path.realpath(f"{self.arch}/{s}") for s in SUBS)}
        res.update(kw)
        p = f"{self.jd}/writer-check.json"
        with open(p, "w") as f:
            json.dump(res, f)
        os.chmod(p, 0o600)

    def inventory_all(self):
        for s in SUBS:
            self.ok("inventory-source", "--subtree", s)

    def through_verify(self, sub=SUBS[0]):
        self.inventory_all(); self.ok("copy", "--subtree", sub); return self.ok("verify", "--subtree", sub)

    def source_fs(self):
        """every entry on the fixture SOURCE filesystem: (type, mode, size, mtime, inode) - must not change before cut-over"""
        out = {}
        for root, ds, fs in os.walk(f"{self.tmp}/vm"):
            for n in ds + fs:
                q = os.path.join(root, n); st = os.lstat(q)
                out[q] = (stat.S_IFMT(st.st_mode), stat.S_IMODE(st.st_mode), st.st_size, st.st_mtime_ns, st.st_ino)
        return out


class Pins(Base):
    def test_relocate_is_the_frozen_r5_bytes(self):
        with open(os.path.join(os.path.dirname(HERE), "relocate.py"), "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), S.R5_RELOCATE_SHA256)

    def test_production_pins_refuse_any_deviation(self):
        prod = {"format": S.FORMAT, "owner_uid": os.geteuid(), "owner_gid": os.getegid(), "archive_root": S.PROD["archive_root"],
                "subtrees": list(S.PROD["subtrees"]), "dest_root": S.PROD["dest_root"], "source_mount": dict(S.PROD["source_mount"]),
                "dest_mount": dict(S.PROD["dest_mount"]), "manifest": dict(S.PROD["manifest"]),
                "inventory_1381": {"journal_dir": "/home/steven/.local/state/nvme-cold-relocation", **S.PROD["inventory_1381"]},
                "journal_dir": "/home/steven/.local/state/nvme-cold-subtree-r6", "rsync_path": "/home/steven/.local/bin/rsync",
                "bwlimit_kib": 204800, "queue_lane_bytes": LANE, "dest_floor_bytes": 300000000000, "writer_check_max_age_seconds": 600}
        env = S.Env()
        def load(c):
            self.cfg = c; self.write_cfg(); return S.load_config(self.cfgp, env)
        load(json.loads(json.dumps(prod)))                                   # the reviewed production config loads
        for k, v in (("archive_root", "/vm/enclave-volumes/other"), ("subtrees", SUBS + ["2026-10-24/home/Projects"]), ("subtrees", SUBS[:2]),
                     ("dest_root", "/mnt/usb/cold"), ("dest_floor_bytes", 299999999999),
                     ("dest_mount", {"path": "/mnt/usb", "fstype": "ntfs3", "device": "/dev/sda2"}),
                     ("bwlimit_kib", 204801), ("guard", {"status_path": "/x/guard-status.json"}),
                     ("inventory_1381", {**prod["inventory_1381"], "identity": "0" * 64}),
                     ("journal_dir", "/home/steven/.local/state/nvme-cold-relocation")):
            with self.assertRaises(R.Refuse, msg=k):
                load({**json.loads(json.dumps(prod)), k: v})


class Inventory(Base):
    def test_exact_1381_identity_reuses_hashes_and_matches_a_fresh_hash(self):
        inv = self.ok("inventory-source", "--subtree", SUBS[0])
        self.assertEqual((inv["hashes"], inv["counts"]["hashed"]), ("1381", 0))
        fresh = S.phase_inventory(self.cfg | {"journal_dir": f"{self.tmp}/j2"}, self.env, S.open_journal(self.cfg | {"journal_dir": f"{self.tmp}/j2"}, self.env, True), SUBS[0], fresh=True)
        self.assertEqual(inv["logical"], fresh["logical"]); self.assertEqual(fresh["hashes"], "fresh")

    def test_any_difference_refuses_reuse_and_fresh_hash_needs_the_queue(self):
        f = f"{self.arch}/{SUBS[1]}/model/w.bin"
        for mut in (lambda: os.utime(f, ns=(1, 1)), lambda: mkfile(f"{self.arch}/{SUBS[1]}/new", b"n"), lambda: os.chmod(f, 0o600)):
            self.tearDown(); self.setUp(); f = f"{self.arch}/{SUBS[1]}/model/w.bin"
            mut(); self.refused("no reuse", "inventory-source", "--subtree", SUBS[1])
        self.env.lane = "max"; self.refused("queue lane", "inventory-source", "--subtree", SUBS[1], "--fresh-hash")
        self.env.lane = str(LANE); self.assertEqual(self.ok("inventory-source", "--subtree", SUBS[1], "--fresh-hash")["hashes"], "fresh")

    def test_a_tampered_1381_journal_is_never_trusted(self):
        p = f"{self.tmp}/j1381/source-codex-archive.logical.json"
        log = json.load(open(p)); log[-1]["m"] = 0o777; json.dump(log, open(p, "w"))
        self.refused("not provably root 1381", "inventory-source", "--subtree", SUBS[0])


class Copy(Base):
    def test_refusals_create_nothing(self):
        self.refused("inventory-source first", "copy", "--subtree", SUBS[0])
        self.ok("inventory-source", "--subtree", SUBS[0])
        self.refused("inventory every subtree first", "copy", "--subtree", SUBS[0])      # the floor needs ALL remaining copies
        for s in SUBS[1:]:
            self.ok("inventory-source", "--subtree", s)
        j = S.open_journal(self.cfg, self.env, create=False)
        one, total = R.required_bytes(j, "hf-convert")[0], S.remaining_need(self.cfg, j)
        reset = lambda: (setattr(self.env, "lane", str(LANE)), setattr(self.env, "avail_mem", 20 * GIB), setattr(self.env, "free_dest", 10 ** 13),
                         setattr(self.env, "mounts_ok", True), setattr(self.env, "dest_on_source", False))
        for setup, needle in ((lambda: setattr(self.env, "lane", "max"), "queue lane"), (lambda: setattr(self.env, "avail_mem", 16 * GIB - 1), "16 GiB"),
                              (lambda: setattr(self.env, "free_dest", 300000000000), "insufficient"),
                              (lambda: setattr(self.env, "free_dest", 300000000000 + one + 1), "insufficient"),   # fits alone, not with the rest
                              (lambda: setattr(self.env, "dest_on_source", True), "SOURCE filesystem"),
                              (lambda: setattr(self.env, "mounts_ok", False), "wrong device")):
            reset(); setup(); self.refused(needle, "copy", "--subtree", SUBS[0])
            self.assertFalse(os.path.lexists(os.path.dirname(self.dest_root)))
        self.assertGreater(total, one)
        reset(); os.utime(f"{self.arch}/{SUBS[0]}/README", ns=(5, 5)); self.refused("changed since inventory", "copy", "--subtree", SUBS[0])

    def test_destination_must_be_private_and_symlink_free(self):
        self.inventory_all()
        top = os.path.dirname(self.dest_root); os.mkdir(top, 0o755)
        self.refused("0700", "copy", "--subtree", SUBS[0]); os.rmdir(top)
        os.mkdir(f"{self.tmp}/elsewhere", 0o700); os.symlink(f"{self.tmp}/elsewhere", top)
        self.refused("symlink", "copy", "--subtree", SUBS[0])

    def test_copy_verify_metadata_exact_and_tamper_detected(self):
        v = self.through_verify()
        src, dst = f"{self.arch}/{SUBS[0]}", f"{self.dest_root}/{SUBS[0]}"
        for d in (os.path.dirname(self.dest_root), self.dest_root, f"{self.dest_root}/2026-10-24", f"{self.dest_root}/2026-10-24/home"):
            self.assertEqual(stat.S_IMODE(os.lstat(d).st_mode), 0o700, d)
        for rel in ("", "model", "model/w.bin", "README"):
            a, b = os.lstat(os.path.join(src, rel)), os.lstat(os.path.join(dst, rel))
            self.assertEqual((stat.S_IMODE(a.st_mode), a.st_mtime_ns, a.st_size), (stat.S_IMODE(b.st_mode), b.st_mtime_ns, b.st_size), rel)
        self.assertEqual(v["source_identity"], json.load(open(f"{self.jd}/state.json"))["trees"][SUBS[0]]["source_inventory"]["identity"])
        with open(f"{dst}/README", "r+b") as f:
            f.write(b"R")
        os.utime(f"{dst}/README", ns=(os.lstat(f"{src}/README").st_atime_ns, os.lstat(f"{src}/README").st_mtime_ns))
        self.refused("differs from the source", "verify", "--subtree", SUBS[0])


class Cutover(Base):
    def test_writer_check_gates(self):
        self.through_verify()
        self.refused("must run as root", "writer-check")
        s = self.ok("emit-writer-check")["script"]; txt = open(s).read()
        self.assertIn("subtree.py", txt); self.assertIn("relocate.py", txt); self.assertIn("sha256sum -c", txt)
        self.refused("no root writer-check", "cutover", "--subtree", SUBS[0], "--apps-stopped-attestation", "hf-convert users stopped")
        for kw, needle in (({"complete": False, "incomplete": [["1", "x"]]}, "incomplete"), ({"hits": [["9", "fd", "x"]]}, "active users"),
                           ({"t": self.env.now() - 301}, "stale"), ({"prefixes": []}, "stale")):
            self.writer_check(**kw); self.refused(needle, "cutover", "--subtree", SUBS[0], "--apps-stopped-attestation", "hf-convert users stopped")
        self.writer_check(); self.refused("attestation", "cutover", "--subtree", SUBS[0])
        self.assertTrue(os.path.isdir(f"{self.arch}/{SUBS[0]}") and not os.path.islink(f"{self.arch}/{SUBS[0]}"))

    def test_cutover_keeps_every_path_then_rollback_restores(self):
        self.through_verify(); self.writer_check()
        sib = R.identity_now(f"{self.arch}/2026-10-24/home/Projects")
        out = self.ok("cutover", "--subtree", SUBS[0], "--apps-stopped-attestation", "hf-convert users stopped")
        src, dst, ret = f"{self.arch}/{SUBS[0]}", f"{self.dest_root}/{SUBS[0]}", f"{self.arch}/2026-10-24/home/.retire-hf-convert"
        self.assertEqual((os.readlink(src), out["retired"]), (dst, ret)); self.assertTrue(os.path.isdir(ret))
        self.assertEqual(os.path.realpath(f"{self.home}/link0"), f"{dst}/model/w.bin"); self.assertTrue(os.path.exists(f"{self.home}/link0"))
        self.assertEqual(R.identity_now(f"{self.arch}/2026-10-24/home/Projects"), sib)
        self.ok("rollback", "--subtree", SUBS[0])
        self.assertTrue(os.path.isdir(src) and not os.path.islink(src)); self.assertFalse(os.path.lexists(ret)); self.assertTrue(os.path.isdir(dst))

    def test_source_change_after_verify_and_failed_postcheck_roll_back(self):
        self.through_verify(); self.writer_check()
        os.utime(f"{self.arch}/{SUBS[0]}/README", ns=(7, 7))
        self.refused("source changed after verify", "cutover", "--subtree", SUBS[0], "--apps-stopped-attestation", "hf-convert users stopped")
        self.tearDown(); self.setUp(); self.through_verify(); self.writer_check()
        os.unlink(f"{self.home}/link0")                                     # a manifest link that no longer resolves
        self.refused("rolled back", "cutover", "--subtree", SUBS[0], "--apps-stopped-attestation", "hf-convert users stopped")
        src = f"{self.arch}/{SUBS[0]}"; self.assertTrue(os.path.isdir(src) and not os.path.islink(src))
        self.assertFalse(os.path.lexists(f"{self.arch}/2026-10-24/home/.retire-hf-convert"))

    def test_rollback_refuses_after_writes_through_the_symlink(self):
        self.through_verify(); self.writer_check()
        self.ok("cutover", "--subtree", SUBS[0], "--apps-stopped-attestation", "hf-convert users stopped")
        mkfile(f"{self.dest_root}/{SUBS[0]}/written-after", b"w")
        self.refused("changed since cut-over", "rollback", "--subtree", SUBS[0])


class Safety(Base):
    def test_no_deletion_and_no_destructive_rsync(self):
        calls = []
        real = (os.unlink, os.rmdir, os.remove, shutil.rmtree)
        os.unlink = lambda p, *a, **k: (calls.append(("unlink", p)), real[0](p, *a, **k))[1]
        os.rmdir = lambda p, *a, **k: (calls.append(("rmdir", p)), real[1](p, *a, **k))[1]
        os.remove = lambda p, *a, **k: (calls.append(("remove", p)), real[2](p, *a, **k))[1]
        shutil.rmtree = lambda p, *a, **k: (calls.append(("rmtree", p)), real[3](p, *a, **k))[1]
        argvs = []; run = self.env.run; self.env.run = lambda argv: (argvs.append(argv), run(argv))[1]
        try:
            self.through_verify(); self.writer_check()
            self.ok("cutover", "--subtree", SUBS[0], "--apps-stopped-attestation", "hf-convert users stopped")
            self.ok("rollback", "--subtree", SUBS[0])
        finally:
            os.unlink, os.rmdir, os.remove, shutil.rmtree = real
        self.assertEqual([c for c in calls if not c[1].startswith(self.jd)], [("unlink", f"{self.arch}/{SUBS[0]}")])
        self.assertTrue(argvs and all(not any(x.startswith("--del") or x in ("--remove-source-files", "--inplace") for x in a) for a in argvs))
        self.assertTrue(all(any(x.startswith("--bwlimit=") for x in a) for a in argvs))

    def test_never_mixes_with_an_r5_image_journal(self):
        os.makedirs(self.jd, mode=0o700)
        with open(f"{self.jd}/state.json", "w") as f:
            json.dump({"format": R.JOURNAL_FORMAT, "trees": {"codex-archive": {"copy": "done"}}}, f)
        os.chmod(f"{self.jd}/state.json", 0o600)
        self.refused("not a subtree-r6 journal", "inventory-source", "--subtree", SUBS[0])

    def test_plan_reports_capacity_and_the_padbank_caveat(self):
        self.inventory_all()
        p = self.ok("plan")
        self.assertEqual(p["capacity"]["sourceFreeInformational"], 1_000_000_000)
        self.assertTrue(any("padbank" in n for n in p["notes"])); self.assertTrue(any("reclamation" in n for n in p["notes"]))
        self.assertGreater(p["capacity"]["remainingInventoriedNeed"], 0)
        self.env.free_dest = 300000000000 + 10; self.refused("would fall", "plan")


class R7(Base):
    def test_real_stopped_guard_is_never_read_and_low_source_free_still_copies(self):
        with self.assertRaises(R.Refuse):                               # r6 read this file: missing thresholds -> refusal (1523)
            R.guard_status({"guard": {"status_path": self.guard, "shutdown_bytes": 468719476736, "floor_bytes": 300000000000}}, self.env)
        real = R.guard_status
        R.guard_status = lambda *a, **k: (_ for _ in ()).throw(AssertionError("r7 must not read the VM guard status"))
        try:
            self.assertEqual(self.env.free_src, 1_000_000_000)          # /vm nearly full
            self.ok("plan"); v = self.through_verify(); self.assertIn("dest_identity", v); self.ok("plan")
        finally:
            R.guard_status = real

    def test_journal_or_destination_on_the_source_fs_is_refused_before_any_write(self):
        self.cfg["journal_dir"] = f"{self.tmp}/vm/enclave-volumes/.subtree-journal"; self.write_cfg()
        self.refused("journal is not on the destination", "inventory-source", "--subtree", SUBS[0])
        self.assertFalse(os.path.lexists(self.cfg["journal_dir"]))
        self.tearDown(); self.setUp(); self.env.dest_on_source = True
        self.refused("SOURCE filesystem", "inventory-source", "--subtree", SUBS[0])
        self.assertFalse(os.path.lexists(self.jd))
        self.env.dest_on_source = False; self.ok("inventory-source", "--subtree", SUBS[0])

    def test_no_source_mutation_through_inventory_copy_verify(self):
        before = self.source_fs()
        self.through_verify(); self.ok("copy", "--subtree", SUBS[1]); self.ok("verify", "--subtree", SUBS[1])
        self.assertEqual(self.source_fs(), before)

    def test_bandwidth_cap_and_guard_key_refused(self):
        self.cfg["bwlimit_kib"] = 204801; self.write_cfg(); self.refused("200 MiB/s", "plan")
        self.cfg["bwlimit_kib"] = 204800; self.cfg["guard"] = {"status_path": self.guard}; self.write_cfg(); self.refused("keys must be exactly", "plan")


if __name__ == "__main__":
    unittest.main()
