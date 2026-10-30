#!/usr/bin/env python3
"""r4: directory mtimes re-applied after rsync and strictly verified; destructive rsync argv refused at run time; behavioural
no-deletion test (actual unlink/rmdir/remove calls and rsync argv); relative symlinks escaping a tree refused; files closed.
r3: fixture correction only (source_mount = t/vm). r2: + shell-injection safety of every generated script (run with stub tools on hostile temp paths), canonical UUID/label,
persistence gate before cut-over, rollback refusal after target writes and the verified reverse copy.
Offline tests of relocate.py on TEMP fixture trees only: no root, no loop devices, no mounts, no real /vm or USB paths.
Mount/loop identity is replaced by FakeEnv (its pure parsers/checkers are tested separately on fixture mountinfo/sysfs).
rsync is the real binary (RSYNC env or PATH). mkfs is faked (writes an ext4-shaped superblock), never executed."""
import contextlib, glob, io, json, os, shlex, shutil, stat, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import relocate as R  # noqa: E402

RSYNC = os.environ.get("RSYNC") or shutil.which("rsync")
UUID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"


def _rt(p, *a, **k):
    with open(p, *a, **k) as f:
        return f.read()


def _rb(p):
    with open(p, "rb") as f:
        return f.read()


def _w(p, data):
    with open(p, "w") as f:
        f.write(data)


def _a(p, data):
    with open(p, "a") as f:
        f.write(data)


def _wb(p, data):
    with open(p, "wb") as f:
        f.write(data)


class FakeEnv(R.Env):
    production = False

    def __init__(self, tmp):
        self.tmp, self.uid, self.t, self.busy = tmp, 4242, 1_000_000.0, 0     # a non-root caller by default
        self.proc = os.path.join(tmp, "proc"); os.makedirs(self.proc, exist_ok=True)
        self.sys_block = os.path.join(tmp, "sysblock"); os.makedirs(self.sys_block, exist_ok=True)
        self.free_usb = self.free_target = 10 ** 13
        self.mounts_ok = self.target_ok = True
        self.unreadable = ()
        self.mkfs_calls = []
        self.systemd_dir = os.path.join(tmp, "systemd"); os.makedirs(self.systemd_dir + "/multi-user.target.wants", exist_ok=True)
        self.fstab = os.path.join(tmp, "fstab")
        if not os.path.exists(self.fstab):
            _w(self.fstab, "# <file system> <mount point> <type> <options> <dump> <pass>\n/dev/x / ext4 rw 0 1\n")
        self.root_uid = os.geteuid()

    def euid(self): return self.uid
    def now(self): return self.t
    def readlink(self, p):
        if any(f"/proc/{pid}/" in p for pid in self.unreadable):
            raise PermissionError(13, "Permission denied", p)
        return os.readlink(p)

    def statvfs(self, p):
        class V: pass
        v = V(); v.f_frsize = 1
        v.f_bavail = self.free_target if p == os.path.join(self.tmp, "cold") else self.free_usb
        return v

    def sleep(self, s):                       # the "busy" device writes self.busy sectors during the sample
        f = os.path.join(self.tmp, "sda-stat"); x = _rt(f).split(); x[6] = str(int(x[6]) + self.busy)
        _w(f, " ".join(x))

    def run(self, argv):
        if argv[0] == R.MKFS:
            self.mkfs_calls.append(argv)
            img, label, uuid = argv[-1], argv[argv.index("-L") + 1], argv[argv.index("-U") + 1]
            with open(img, "r+b") as f:
                f.seek(1024 + 56); f.write((0xEF53).to_bytes(2, "little"))
                f.seek(1024 + 104); f.write(bytes.fromhex(uuid.replace("-", "")))
                f.seek(1024 + 120); f.write(label.encode().ljust(16, b"\0"))
            return 0
        import subprocess
        return subprocess.run(argv, capture_output=True).returncode

    def check_mounts(self, cfg):
        if not self.mounts_ok:
            R.refuse("wrong device for /vm")

    def check_target(self, cfg, journal):
        if not self.target_ok:
            R.refuse("target is not mounted (unmounted target)")


def mkfile(p, data=b"", mode=0o644):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f: f.write(data)
    os.chmod(p, mode)


class Base(unittest.TestCase):
    PREFIX = "tmp"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix=self.PREFIX, dir=os.environ.get("TEST_TMP"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        t = self.tmp
        self.vm = os.path.join(t, "vm/enclave-volumes"); os.makedirs(self.vm)
        self.arch = os.path.join(self.vm, "codex-archive"); os.mkdir(self.arch, 0o700)
        a = os.path.join(self.arch, "2026-10-24")
        mkfile(f"{a}/a/b/data.bin", os.urandom(300_000))
        mkfile(f"{a}/a/hl1", b"hardlinked"); os.link(f"{a}/a/hl1", f"{a}/a/hl2")
        os.symlink("b/data.bin", f"{a}/a/rel-link")
        mkfile(f"{a}/exe.sh", b"#!/bin/sh\n", 0o755); mkfile(f"{a}/empty")
        os.makedirs(f"{a}/private", mode=0o700)
        try:
            os.setxattr(f"{a}/a/b/data.bin", "user.tag", b"v1"); self.xattr = True
        except OSError:
            self.xattr = False
        self.home = os.path.join(t, "home"); os.makedirs(self.home)
        ents = []
        for i, rel in enumerate(["a/b/data.bin", "exe.sh", "a/hl1"]):
            dst = f"{a}/{rel}"; src = f"{self.home}/link{i}"
            os.symlink(dst, src)
            ents.append({"source": src, "destination": dst, "bytes": os.path.getsize(dst), "sha256": R.hashlib.sha256(_rb(dst)).hexdigest()})
        man = f"{a}/recovery-documents/artifact-relocation-manifest.json"
        mkfile(man, json.dumps(ents).encode())
        self.pix = os.path.join(self.vm, ".pixel10"); os.mkdir(self.pix, 0o755)
        mkfile(f"{self.pix}/tensor-sdk/venv/bin/python", b"\x7fELF", 0o755); mkfile(f"{self.pix}/tensor-sdk/lib/x.py", b"x=1")
        os.symlink("venv", f"{self.pix}/tensor-sdk/env")
        self.inbound = f"{self.home}/tensor-sdk"; os.symlink(f"{self.pix}/tensor-sdk", self.inbound)
        os.makedirs(f"{t}/usb"); os.makedirs(f"{t}/cold")
        mkfile(f"{t}/sda-stat", b"1 0 2 3 4 0 1000 5 0 6 7")
        self.guard = f"{t}/guard.json"
        self.write_guard()
        uid = os.geteuid()
        self.cfg = {"format": R.CONFIG_FORMAT, "owner_uid": uid, "owner_gid": os.getegid(), "source_parent": self.vm,
            "trees": [{"name": "codex-archive", "source": self.arch, "manifest": {"path": man, "sha256": R.hashlib.sha256(_rb(man)).hexdigest(), "entries": 3}},
                      {"name": ".pixel10", "source": self.pix, "inbound_links": [self.inbound]}],
            # r3: the fixture's source mount is t/vm (as /vm in production), NOT the temp root: a mount enclosing cold/ and
            # usb/ violates load_config's real disjoint-mount guard (root run 1288: 11 failures + 1 error, all that refusal)
            "source_mount": {"path": f"{t}/vm", "fstype": "ext4", "device": "/dev/fake"}, "usb_mount": {"path": f"{t}/usb", "fstype": "ntfs3", "device": "/dev/fakeusb"},
            "image": {"path": f"{t}/usb/vm-cold/cold.ext4", "size_bytes": 10 ** 9, "inodes": 100_000, "label": "vm-cold", "uuid": UUID},
            "target_mount": f"{t}/cold", "journal_dir": f"{t}/journal", "rsync_path": RSYNC,
            "copy": {"bwlimit_kib": 100_000, "busy_device_stat": f"{t}/sda-stat", "busy_sample_seconds": 1, "busy_max_write_sectors": 100},
            "guard": {"status_path": self.guard, "shutdown_bytes": 468719476736, "floor_bytes": 300000000000},
            "writer_check_max_age_seconds": 300, "capacity_reserve_bytes": 1000, "inode_reserve": 10}
        self.write_cfg()
        self.env = FakeEnv(t)

    def write_guard(self, free=10 ** 12, shutdown=468719476736):
        _w(self.guard, json.dumps({"free": {"nvme": free}, "thresholds": {"nvme": {"floor": 300000000000, "pause": 368719476736,
                   "shutdown": shutdown, "start": 488719476736}}, "state": "armed"}))

    def write_cfg(self):
        self.cfgp = os.path.join(self.tmp, "cfg.json")
        with open(self.cfgp, "w") as f: json.dump(self.cfg, f)
        os.chmod(self.cfgp, 0o600)

    def run_phase(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = R.main(list(args) + ["--config", self.cfgp], self.env)
        return rc, out.getvalue(), err.getvalue()

    def ok(self, *args):
        rc, out, err = self.run_phase(*args)
        self.assertEqual(rc, 0, f"{args}: {err}")
        return json.loads(out)

    def refused(self, needle, *args):
        rc, out, err = self.run_phase(*args)
        self.assertEqual(rc, 3, f"{args} should refuse: {out}")
        self.assertIn(needle, err)
        return err

    def to_verified(self):
        for n in ("codex-archive", ".pixel10"):
            self.ok("inventory-source", "--tree", n)
        self.ok("prepare-image", "--execute"); self.ok("mount-handoff"); self.ok("verify-mount"); self.persist()
        for n in ("codex-archive", ".pixel10"):
            self.ok("copy", "--tree", n); self.ok("verify", "--tree", n)

    def persist(self):
        """What persistence-handoff.sh does as root, done in the fixture (the script itself is exercised with stub tools)."""
        self.ok("persistence-handoff")
        name, text = R.persistence_unit(R.load_config(self.cfgp, self.env))
        unit = os.path.join(self.env.systemd_dir, name)
        _w(unit, text); os.chmod(unit, 0o644)
        link = os.path.join(self.env.systemd_dir, "multi-user.target.wants", name)
        if not os.path.lexists(link):
            os.symlink("../" + name, link)
        return self.ok("verify-persistence"), unit, link

    def writer_check(self):
        self.env.uid = 0
        try:
            return self.ok("writer-check")
        finally:
            self.env.uid = 4242


@unittest.skipUnless(RSYNC, "rsync is required")
class Flow(Base):
    def test_plan_is_read_only_and_points_to_the_next_phase(self):
        r = self.ok("plan")
        self.assertFalse(os.path.exists(self.cfg["journal_dir"]), "plan created no journal")
        self.assertEqual(r["next"], "inventory-source --tree codex-archive")
        self.assertFalse(os.path.exists(self.cfg["image"]["path"]))

    def test_full_flow_cutover_rollback_idempotence_and_preserved_metadata(self):
        self.refused("inventory-source --tree", "prepare-image", "--execute")
        inv = self.ok("inventory-source", "--tree", "codex-archive")
        self.assertGreater(inv["counts"]["hashed"], 0)
        again = self.ok("inventory-source", "--tree", "codex-archive")  # resumable: nothing re-hashed
        self.assertEqual(again["counts"]["hashed"], 0); self.assertEqual(again["logical"], inv["logical"])
        self.ok("inventory-source", "--tree", ".pixel10")
        dry = self.ok("prepare-image")
        self.assertIn("dry run", dry["note"]); self.assertFalse(os.path.exists(self.cfg["image"]["path"]))
        self.ok("prepare-image", "--execute")
        self.assertEqual(len(self.env.mkfs_calls), 1)
        argv = self.env.mkfs_calls[0]
        self.assertIn("-U", argv); self.assertIn(UUID, argv); self.assertIn(f"nodiscard,root_owner={os.geteuid()}:{os.getegid()}", argv)
        self.assertTrue(self.ok("prepare-image", "--execute")["already"])                 # idempotent, image never recreated
        self.assertEqual(len(self.env.mkfs_calls), 1)
        script = _rt(self.ok("mount-handoff")["script"])
        self.assertIn("nodev,nosuid", script); self.assertIn(UUID, script)
        self.assertNotIn("rm ", script); self.assertNotIn(">> /etc/fstab", script)
        self.assertTrue(all(l.startswith("#") for l in script.splitlines() if "fstab" in l or "x-systemd" in l))
        self.ok("verify-mount")
        tp = self.cfg["target_mount"] + "/enclave-volumes"
        self.assertEqual(stat.S_IMODE(os.stat(tp).st_mode), 0o700)
        for n in ("codex-archive", ".pixel10"):
            self.ok("copy", "--tree", n); self.ok("verify", "--tree", n)
        d = tp + "/codex-archive"
        self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700)
        self.assertEqual(os.stat(d + "/2026-10-24/a/hl1").st_ino, os.stat(d + "/2026-10-24/a/hl2").st_ino, "hardlink kept")
        self.assertEqual(os.readlink(d + "/2026-10-24/a/rel-link"), "b/data.bin")
        self.assertEqual(stat.S_IMODE(os.stat(d + "/2026-10-24/exe.sh").st_mode), 0o755)
        if self.xattr:
            self.assertEqual(os.getxattr(d + "/2026-10-24/a/b/data.bin", "user.tag"), b"v1")
        self.writer_check()
        self.refused("--apps-stopped-attestation", "cutover", "--tree", "codex-archive")
        self.refused("no verified persistent mount", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.persist()
        r = self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "no users: archive readers stopped by owner")
        self.assertEqual(os.readlink(self.arch), d)
        self.assertTrue(os.path.isdir(self.vm + "/.retire-codex-archive"))
        for i in range(3):                                            # the manifest links resolve through ONE symlink
            self.assertTrue(os.path.realpath(f"{self.home}/link{i}").startswith(d + "/"))
        self.assertEqual(_rb(f"{self.home}/link0"), _rb(self.vm + "/.retire-codex-archive/2026-10-24/a/b/data.bin"))
        self.assertTrue(self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "re-run, nothing to do")["already"])
        self.ok("rollback", "--tree", "codex-archive")
        self.assertTrue(os.path.isdir(self.arch) and not os.path.islink(self.arch))
        self.assertFalse(os.path.lexists(self.vm + "/.retire-codex-archive"))
        self.assertIn("already", self.ok("rollback", "--tree", "codex-archive"))
        self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "second cut-over after rollback")
        self.ok("cutover", "--tree", ".pixel10", "--apps-stopped-attestation", "tensor-sdk users stopped by owner")
        self.assertTrue(os.path.realpath(self.inbound).startswith(tp + "/.pixel10/"))
        self.assertTrue(os.path.exists(self.inbound + "/venv/bin/python"))
        self.assertTrue(self.ok("plan")["next"].startswith("none"))
        ev = _rt(self.cfg["journal_dir"] + "/events.jsonl")
        self.assertIn("rename-intent", ev); self.assertIn("unlink-our-symlink", ev)
        for f in os.listdir(self.cfg["journal_dir"]):
            self.assertEqual(stat.S_IMODE(os.lstat(self.cfg["journal_dir"] + "/" + f).st_mode) & 0o077, 0, f)

    def test_directory_mtimes_are_restored_after_copy_and_still_strictly_verified(self):
        # root runs 1302/1303: the pinned rsync left destination directory mtimes at copy time
        for n in ("codex-archive", ".pixel10"):
            self.ok("inventory-source", "--tree", n)
        self.ok("prepare-image", "--execute"); self.ok("verify-mount"); self.ok("copy", "--tree", "codex-archive")
        dst = self.cfg["target_mount"] + "/enclave-volumes/codex-archive"
        dirs = [""] + [os.path.relpath(os.path.join(r, d), self.arch) for r, ds, _ in os.walk(self.arch) for d in ds]
        self.assertGreaterEqual(len(dirs), 6)
        for rel in dirs:
            self.assertEqual(os.lstat(os.path.join(self.arch, rel)).st_mtime_ns, os.lstat(os.path.join(dst, rel)).st_mtime_ns, rel)
        self.assertIn('"dir_mtimes_restored"', _rt(self.cfg["journal_dir"] + "/events.jsonl"))
        self.ok("verify", "--tree", "codex-archive")
        st = os.lstat(dst + "/2026-10-24/private")                      # verification is NOT relaxed for directories
        os.utime(dst + "/2026-10-24/private", ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
        self.refused("destination differs", "verify", "--tree", "codex-archive")
        self.assertIn('"mt"', _rt(self.cfg["journal_dir"] + "/verify-diff-codex-archive.json"))

    def test_changed_source_after_verify_refuses_until_recopied(self):
        self.to_verified(); self.writer_check()
        with open(self.arch + "/2026-10-24/new-file", "w") as f: f.write("a late writer")
        self.refused("source changed after verify", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.assertFalse(os.path.islink(self.arch))
        self.ok("copy", "--tree", "codex-archive"); self.ok("verify", "--tree", "codex-archive")
        self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped, recopied")

    def test_tampered_destination_with_same_size_and_mtime_is_refused_by_hash(self):
        for n in ("codex-archive", ".pixel10"):
            self.ok("inventory-source", "--tree", n)
        self.ok("prepare-image", "--execute"); self.ok("verify-mount"); self.ok("copy", "--tree", "codex-archive")
        p = self.cfg["target_mount"] + "/enclave-volumes/codex-archive/2026-10-24/a/b/data.bin"
        st = os.stat(p); data = bytearray(_rb(p)); data[0] ^= 1
        _wb(p, data); os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.refused("destination differs", "verify", "--tree", "codex-archive")
        self.assertTrue(os.path.exists(self.cfg["journal_dir"] + "/verify-diff-codex-archive.json"))
        self.refused("verify first", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")

    def test_writer_check_hits_incomplete_visibility_staleness_and_root_only(self):
        self.to_verified()
        self.refused("must run as root", "writer-check")
        self.refused("no root writer-check result", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        pd = self.env.proc + "/100"; os.makedirs(pd + "/fd"); os.makedirs(pd + "/task/100")
        for n in ("cwd", "root"):
            os.symlink("/", f"{pd}/{n}"); os.symlink("/", f"{pd}/task/100/{n}")
        os.symlink("/usr/bin/true", pd + "/exe")
        os.symlink(self.arch + "/2026-10-24/a/b/data.bin", pd + "/fd/3")
        _w(pd + "/maps", "")
        r = self.writer_check()
        self.assertEqual(r["hits"], 1)
        self.refused("active users", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        os.unlink(pd + "/fd/3")
        _w(pd + "/maps", f"7f00-7f01 r--p 0 08:01 5 {self.pix}/tensor-sdk/lib/x.py\n")
        self.assertEqual(self.writer_check()["hits"], 1, "a mapped file counts")
        _w(pd + "/maps", "")
        os.makedirs(self.env.proc + "/200/fd"); self.env.unreadable = ("200",)
        for n in ("cwd", "root", "exe"):
            os.symlink("/", f"{self.env.proc}/200/{n}")
        _w(self.env.proc + "/200/maps", "")
        r = self.writer_check()
        self.assertFalse(r["complete"])
        self.refused("visibility was incomplete", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.env.unreadable = ()
        self.assertTrue(self.writer_check()["complete"])
        os.makedirs(self.env.sys_block + "/loop3/loop")                  # a kernel user: loop device backed by a tree file
        _w(self.env.sys_block + "/loop3/loop/backing_file", self.pix + "/tensor-sdk/lib/x.py\n")
        self.assertEqual(self.writer_check()["hits"], 1)
        os.unlink(self.env.sys_block + "/loop3/loop/backing_file")
        _w(self.env.proc + "/swaps", "Filename Type Size Used Priority\n" + self.arch + "/2026-10-24/empty file 4 0 -2\n")
        self.assertEqual(self.writer_check()["hits"], 1, "a swap file in a tree counts")
        os.unlink(self.env.proc + "/swaps")
        self.env.t += 301
        self.refused("stale", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.writer_check()
        self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")

    def test_busy_usb_needs_explicit_operator_flag_and_is_journaled(self):
        for n in ("codex-archive", ".pixel10"):
            self.ok("inventory-source", "--tree", n)
        self.ok("prepare-image", "--execute"); self.ok("verify-mount")
        self.env.busy = 5000
        self.refused("USB device busy", "copy", "--tree", "codex-archive")
        self.assertFalse(os.path.exists(self.cfg["target_mount"] + "/enclave-volumes/codex-archive"))
        self.ok("copy", "--tree", "codex-archive", "--accept-busy-usb")
        self.assertIn("busy_override", _rt(self.cfg["journal_dir"] + "/events.jsonl"))

    def test_guard_pins_and_shutdown_proximity(self):
        self.write_guard(shutdown=400000000000)
        self.refused("live guard thresholds differ", "plan")
        self.write_guard(free=468719476736)
        for n in ("codex-archive", ".pixel10"):
            self.ok("inventory-source", "--tree", n)
        self.ok("prepare-image", "--execute"); self.ok("verify-mount")
        self.refused("shutdown threshold", "copy", "--tree", "codex-archive")
        os.unlink(self.guard)
        self.refused("guard status unreadable", "plan")

    def test_reused_image_capacity_and_unmounted_target(self):
        os.makedirs(os.path.dirname(self.cfg["image"]["path"])); _w(self.cfg["image"]["path"], "")
        self.refused("reused image", "plan")
        os.unlink(self.cfg["image"]["path"])
        for n in ("codex-archive", ".pixel10"):
            self.ok("inventory-source", "--tree", n)
        self.cfg["image"]["size_bytes"] = 100_000; self.write_cfg()
        self.refused("insufficient capacity", "prepare-image", "--execute")
        self.cfg["image"]["size_bytes"] = 10 ** 9; self.cfg["image"]["inodes"] = 5; self.write_cfg()
        self.refused("image inodes", "prepare-image", "--execute")
        self.cfg["image"]["inodes"] = 100_000; self.write_cfg()
        self.env.free_usb = 10 ** 6
        self.refused("USB free space", "prepare-image", "--execute")
        self.env.free_usb = 10 ** 13
        self.ok("prepare-image", "--execute")
        self.env.target_ok = False
        self.refused("unmounted target", "verify-mount")
        self.env.target_ok = True; self.ok("verify-mount")
        self.env.free_target = 10
        self.refused("insufficient capacity", "copy", "--tree", "codex-archive")
        self.env.mounts_ok = False
        self.refused("wrong device", "plan")

    def test_crash_between_rename_intent_and_symlink_resumes_or_rolls_back(self):
        self.to_verified(); self.writer_check()
        st = json.loads(_rt(self.cfg["journal_dir"] + "/state.json"))
        st["trees"]["codex-archive"]["cutover"] = "renaming"
        os.rename(self.arch, self.vm + "/.retire-codex-archive")        # the rename happened, the process died
        jp = self.cfg["journal_dir"] + "/state.json"; _w(jp, json.dumps(st)); os.chmod(jp, 0o600)
        self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "resume after crash")
        self.assertTrue(os.path.islink(self.arch))
        self.ok("rollback", "--tree", "codex-archive")
        self.assertTrue(os.path.isdir(self.arch) and not os.path.islink(self.arch))

    def test_failed_post_cutover_check_rolls_back_automatically(self):
        self.to_verified(); self.writer_check()
        os.unlink(f"{self.home}/link1"); os.symlink("/nonexistent/elsewhere", f"{self.home}/link1")
        self.refused("rolled back", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.assertTrue(os.path.isdir(self.arch) and not os.path.islink(self.arch))
        self.assertFalse(os.path.lexists(self.vm + "/.retire-codex-archive"))


class Refusals(Base):
    def test_config_validation(self):
        for mut, needle in [(lambda c: c.update(extra=1), "keys must be exactly"),
                            (lambda c: c.update(journal_dir="rel/j"), "normalized absolute"),
                            (lambda c: c.update(journal_dir=self.arch + "/j"), "overlap"),
                            (lambda c: c.update(target_mount=self.vm + "/cold"), "overlap"),
                            (lambda c: c["trees"].reverse(), "trees must be exactly"),
                            (lambda c: c["trees"][1].update(source=self.vm + "/other"), "source must be exactly"),
                            (lambda c: c["image"].update(path="/elsewhere/x.ext4"), "file on usb_mount"),
                            (lambda c: c["copy"].update(bwlimit_kib="REQUIRED"), "no default is assumed"),
                            (lambda c: c.update(writer_check_max_age_seconds=0), "no default is assumed")]:
            self.setUp(); mut(self.cfg); self.write_cfg()
            self.refused(needle, "plan")
        self.setUp(); os.chmod(self.cfgp, 0o666)
        self.refused("group/world-writable", "plan")
        self.setUp(); self.env.production = True
        self.refused("source_parent must be exactly /vm/enclave-volumes", "plan")

    def test_path_and_tree_safety(self):
        moved = self.tmp + "/real-vm"; os.rename(self.tmp + "/vm", moved); os.symlink(moved, self.tmp + "/vm")
        self.refused("symlink in path", "plan")
        self.setUp(); os.mkfifo(self.arch + "/fifo")
        self.refused("unsupported file type", "inventory-source", "--tree", "codex-archive")
        self.setUp(); os.link(self.arch + "/2026-10-24/empty", self.tmp + "/outside-link")
        self.refused("external hardlink", "inventory-source", "--tree", "codex-archive")
        self.setUp(); os.makedirs(self.cfg["journal_dir"], mode=0o755); os.chmod(self.cfg["journal_dir"], 0o755)
        self.refused("0700 directory", "inventory-source", "--tree", "codex-archive")
        self.setUp(); man = self.cfg["trees"][0]["manifest"]; man["sha256"] = "0" * 64; self.write_cfg()
        self.refused("mismatched manifest", "plan")
        self.setUp(); os.unlink(f"{self.home}/link2"); _w(f"{self.home}/link2", "")
        self.refused("manifest symlinks do not resolve", "plan")

    def test_mountinfo_and_loop_identity_checkers(self):
        tm, img = self.cfg["target_mount"], self.cfg["image"]["path"]
        os.makedirs(os.path.dirname(img)); _wb(img, b"\0" * 4096)
        sysb = self.tmp + "/sys"; os.makedirs(sysb + "/loop7/loop")
        _w(sysb + "/loop7/loop/backing_file", img + "\n")
        env = R.Env(); env.production = False; env.sys_block = sysb; env.mountinfo = self.tmp + "/mountinfo"
        def mi(opts="rw,nosuid,nodev,noatime", fstype="ext4", src="/dev/loop7"):
            _w(env.mountinfo, f"30 1 0:5 / / rw - ext4 /dev/root rw\n"
                                           f"40 30 7:7 / {tm} {opts} shared:9 - {fstype} {src} rw\n")
        cfg = R.load_config(self.cfgp, FakeEnv(self.tmp)); cfg["target_parent"] = tm + "/enclave-volumes"
        class J: state = {"image": {"dev": os.stat(img).st_dev, "ino": os.stat(img).st_ino}}
        def sb(uuid=UUID, label="vm-cold"):
            with open(img, "r+b") as f:
                f.seek(1024 + 56); f.write((0xEF53).to_bytes(2, "little"))
                f.seek(1024 + 104); f.write(bytes.fromhex(uuid.replace("-", ""))); f.seek(1024 + 120); f.write(label.encode().ljust(16, b"\0"))
        def refuses(needle):
            with self.assertRaises(R.Refuse) as c:
                R.check_target_mount(cfg, env, J)
            self.assertIn(needle, str(c.exception))
        _w(env.mountinfo, "30 1 0:5 / / rw - ext4 /dev/root rw\n"); refuses("unmounted target")
        mi(fstype="ntfs3"); refuses("unmounted target")
        mi(src="/dev/sdb1"); refuses("not a loop device")
        mi(opts="rw,noatime"); refuses("must be mounted nodev")
        mi(); sb()
        _w(sysb + "/loop7/loop/backing_file", "/other.ext4\n"); refuses("backing file")
        _w(sysb + "/loop7/loop/backing_file", img + "\n")
        J.state = {"image": {"dev": 1, "ino": 2}}; refuses("reused or replaced image")
        J.state = {"image": {"dev": os.stat(img).st_dev, "ino": os.stat(img).st_ino}}
        sb(uuid="11111111-2222-4333-8444-555555555555"); refuses("pinned UUID")
        sb()
        refuses("same filesystem")      # every identity check passed; only the fixture's shared filesystem remains
        with self.assertRaises(R.Refuse):
            R.check_mount({"path": "/", "fstype": "ext4", "device": "/dev/other"}, env, "/")

    def test_relative_symlink_escaping_a_tree_is_refused(self):
        # it would resolve from the image after cut-over and break; absolute and in-tree relative links are fine
        os.symlink("../../.pixel10/tensor-sdk", self.arch + "/2026-10-24/escape")
        self.refused("relative symlink escapes the tree", "inventory-source", "--tree", "codex-archive")
        self.setUp(); os.symlink("/vm/enclave-volumes/.pixel10", self.arch + "/2026-10-24/absolute-ok")
        os.symlink("a/../a/b", self.arch + "/2026-10-24/inside-ok")
        self.ok("inventory-source", "--tree", "codex-archive")

    def test_destructive_rsync_options_are_refused_at_run_time(self):
        base = [RSYNC or "/x/rsync", "-aHAX", "--numeric-ids", "src", "dst/"]
        self.assertEqual(R.safe_rsync_argv(base), base)
        for bad in ("--delete", "--del", "--delete-after", "--delete-excluded", "--remove-source-files", "--force",
                    "--max-delete=5", "--inplace", "--append", "--append-verify"):
            with self.assertRaises(R.Refuse):
                R.safe_rsync_argv(base[:2] + [bad] + base[2:])

    def test_invalid_uuid_label_and_path_characters_are_refused(self):
        for bad in ["0b1c2d3e-4f50-4617-8899-aabbccddeefg", "0B1C2D3E-4F50-4617-8899-AABBCCDDEEFF",
                    "0b1c2d3e4f50-4617-8899-aabbccdd-eeff", "'; touch PWNED; '00000000-0000-0000-0000-00", 12345]:
            self.setUp(); self.cfg["image"]["uuid"] = bad; self.write_cfg()
            self.refused("uuid", "plan")
        for bad in ["vm cold", "a'b", "x$(id)", "", "seventeen-chars-x"]:
            self.setUp(); self.cfg["image"]["label"] = bad; self.write_cfg()
            self.refused("label", "plan")
        for bad in ["/tmp/x\nrm -rf /", "/tmp/a\\b", "/tmp/del\x7f", "/tmp/t\tab"]:
            self.setUp(); self.cfg["journal_dir"] = bad; self.write_cfg()
            self.refused("control characters or backslashes", "plan")


HOSTILE = "we'ird $(touch PWNED1) `touch PWNED2` ;touch PWNED3; \"q\" "


def stubs(dirpath):
    """Stub system tools: each records its argv (NUL-separated) and answers like the real tool would for the pins."""
    os.makedirs(dirpath)
    body = {"id": 'echo 0', "stat": 'echo "$STUB_INO"', "blkid": 'echo "$STUB_UUID"', "mountpoint": 'exit 1',
            "install": 'exit 0', "mount": 'exit 0', "systemctl": 'exit 0', "python3": 'exit 0'}
    for name, b in body.items():
        p = os.path.join(dirpath, name)
        _w(p, '#!/bin/bash\nprintf \'%s\\0\' "$(basename "$0")" "$@" >> "$STUB_LOG"\nprintf \'\\n\' >> "$STUB_LOG"\n' + b + "\n")
        os.chmod(p, 0o755)


def stub_calls(log):
    return [x.split("\0") for x in _rt(log).split("\0\n") if x] if os.path.exists(log) else []


@unittest.skipUnless(RSYNC, "rsync is required")
class Hostile(Base):
    PREFIX = HOSTILE

    def run_script(self, script, extra_env=None):
        cwd = os.path.join(self.tmp, "cwd-clean"); os.makedirs(cwd, exist_ok=True)
        sd = os.path.join(self.tmp, "stub-bin")
        if not os.path.isdir(sd):
            stubs(sd)
        log = os.path.join(self.tmp, "stub.log")
        env = {"PATH": sd + ":/usr/bin:/bin", "STUB_LOG": log, **(extra_env or {})}
        r = subprocess.run(["/bin/bash", script], cwd=cwd, env=env, capture_output=True, text=True)
        self.assertEqual(os.listdir(cwd), [], "nothing created in the working directory")
        self.assertEqual(glob.glob(os.path.join(glob.escape(self.tmp), "**", "PWNED*"), recursive=True), [], "no injected command ran")
        return r, stub_calls(log)

    def test_generated_scripts_quote_hostile_paths_and_run_nothing_else(self):
        self.assertIn("$(touch PWNED1)", self.tmp)
        for n in ("codex-archive", ".pixel10"):
            self.ok("inventory-source", "--tree", n)
        self.ok("prepare-image", "--execute")
        st = json.loads(_rt(self.cfg["journal_dir"] + "/state.json"))
        r, calls = self.run_script(self.ok("mount-handoff")["script"], {"STUB_INO": str(st["image"]["ino"]), "STUB_UUID": UUID})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        img, tm = self.cfg["image"]["path"], self.cfg["target_mount"]
        self.assertIn(["mount", "-t", "ext4", "-o", "loop,noatime,nodev,nosuid", "--", img, tm], calls)
        self.assertIn(["install", "-d", "-m", "0755", "-o", "root", "-g", "root", "--", tm], calls)
        self.assertIn(["stat", "-c", "%i", "--", img], calls)
        nxt = shlex.split(r.stdout.strip().splitlines()[-1])
        self.assertEqual(nxt[-3:], ["verify-mount", "--config", os.path.abspath(self.cfgp)])
        # a wrong UUID stops the script before install/mount
        os.unlink(os.path.join(self.tmp, "stub.log"))
        r, calls = self.run_script(self.ok("mount-handoff")["script"], {"STUB_INO": str(st["image"]["ino"]), "STUB_UUID": "x"})
        self.assertEqual(r.returncode, 3); self.assertFalse([c for c in calls if c[0] in ("install", "mount")])
        # the root writer-check script runs ONLY the pinned tool, with hostile tool and config paths intact
        tool = os.path.join(self.tmp, "tool dir $(touch PWNED4)", "relocate.py"); os.makedirs(os.path.dirname(tool))
        shutil.copy(R.__file__, tool)
        orig = R.__file__; R.__file__ = tool
        try:
            ws = self.ok("emit-writer-check")["script"]
        finally:
            R.__file__ = orig
        os.unlink(os.path.join(self.tmp, "stub.log"))
        r, calls = self.run_script(ws)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual([c for c in calls if c[0] == "python3"], [["python3", "-I", tool, "writer-check", "--config", os.path.abspath(self.cfgp)]])
        _a(tool, "# tampered\n")                          # the pinned sha256 refuses a changed tool
        os.unlink(os.path.join(self.tmp, "stub.log"))
        r, calls = self.run_script(ws)
        self.assertNotEqual(r.returncode, 0); self.assertFalse([c for c in calls if c[0] == "python3"])
        # persistence values cannot carry such characters at all: refused, and so cut-over stays blocked
        self.ok("verify-mount")
        self.refused("conservative path characters", "persistence-handoff")


@unittest.skipUnless(RSYNC, "rsync is required")
class NoDeletion(Base):
    def test_full_lifecycle_never_deletes_and_never_runs_a_destructive_rsync(self):
        """Behavioural: every os.unlink/remove/rmdir/removedirs and every rsync argv the TOOL issues across copy, verify,
        cut-over, rollback, a second cut-over, an application write, reverse-copy and rollback --use-return-copy."""
        calls, argvs = [], []
        real = {n: getattr(os, n) for n in ("unlink", "remove", "rmdir", "removedirs")}
        def spy(name):
            def f(path, *a, **k):
                calls.append((name, path, os.path.islink(path), os.readlink(path) if os.path.islink(path) else None))
                return real[name](path, *a, **k)
            return f
        real_run = self.env.run
        self.env.run = lambda argv: (argvs.append(list(argv)), real_run(argv))[1]
        def phase(*a):
            for n in real: setattr(os, n, spy(n))
            try:
                return self.ok(*a)
            finally:
                for n, fn in real.items(): setattr(os, n, fn)
        for n in ("codex-archive", ".pixel10"):
            phase("inventory-source", "--tree", n)
        phase("prepare-image", "--execute"); phase("mount-handoff"); phase("verify-mount"); self.persist()
        for n in ("codex-archive", ".pixel10"):
            phase("copy", "--tree", n); phase("verify", "--tree", n)
        self.writer_check()
        phase("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        phase("rollback", "--tree", "codex-archive")
        phase("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        with open(self.arch + "/2026-10-24/app-write", "w") as f:
            f.write("written through the cut-over symlink")
        phase("reverse-copy", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        phase("rollback", "--tree", "codex-archive", "--use-return-copy")
        dst = self.cfg["target_mount"] + "/enclave-volumes/codex-archive"
        self.assertEqual([c[0] for c in calls], ["unlink", "unlink"], f"only the two symlink removals: {calls}")
        for name, path, was_link, target in calls:
            self.assertEqual((path, was_link, target), (self.arch, True, dst), "only OUR cut-over symlink is ever removed")
        rs = [a for a in argvs if a and a[0] == RSYNC]
        self.assertEqual(len(rs), 3, "two copies and one reverse copy")
        for a in rs:
            self.assertEqual(R.safe_rsync_argv(a), a)
            self.assertFalse([x for x in a if x.startswith("--del") or x in ("--remove-source-files", "--force", "--inplace")])
        for kept in (self.arch + "/2026-10-24/app-write", self.vm + "/.retire-codex-archive/2026-10-24/a/b/data.bin",
                     dst + "/2026-10-24/app-write"):
            self.assertTrue(os.path.exists(kept), kept)


@unittest.skipUnless(RSYNC, "rsync is required")
class Persistence(Base):
    def test_persistence_handoff_script_and_verification_gate_cutover(self):
        self.to_verified_without_persistence()
        self.writer_check()
        self.refused("no verified persistent mount", "cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.refused("no persistent mount unit", "verify-persistence")
        out = self.ok("persistence-handoff")
        name, text = R.persistence_unit(R.load_config(self.cfgp, self.env))
        self.assertEqual(out["unit"], os.path.join(self.env.systemd_dir, name))
        self.assertEqual(R.systemd_escape_path("/mnt/vm-cold") + ".mount", "mnt-vm\\x2dcold.mount")   # the production unit name
        self.assertEqual(name, R.systemd_escape_path(self.cfg["target_mount"]) + ".mount")
        self.assertIn("Options=loop,noatime,nodev,nosuid", text); self.assertIn("What=" + self.cfg["image"]["path"], text)
        sd, log = os.path.join(self.tmp, "stub-bin"), os.path.join(self.tmp, "stub.log"); stubs(sd)
        run = lambda: subprocess.run(["/bin/bash", out["script"]], env={"PATH": sd + ":/usr/bin:/bin", "STUB_LOG": log}, capture_output=True, text=True)
        r = run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = stub_calls(log)
        inst = [c for c in calls if c[0] == "install"]
        self.assertEqual(len(inst), 1); self.assertEqual(inst[0][:7], ["install", "-m", "0644", "-o", "root", "-g", "root"])
        self.assertEqual(inst[0][-1], out["unit"])
        self.assertIn(["systemctl", "daemon-reload"], calls); self.assertIn(["systemctl", "enable", "--", name], calls)
        # an fstab entry for the target, or a different existing unit file: the script refuses before installing
        _a(self.env.fstab, f"/some/img {self.cfg['target_mount']} ext4 loop 0 0\n"); os.unlink(log)
        r = run(); self.assertEqual(r.returncode, 4); self.assertFalse([c for c in stub_calls(log) if c[0] == "install"])
        _w(self.env.fstab, "/dev/x / ext4 rw 0 1\n")
        _w(out["unit"], text.replace("nosuid", "suid")); os.chmod(out["unit"], 0o644); os.unlink(log)
        r = run(); self.assertEqual(r.returncode, 4); self.assertFalse([c for c in stub_calls(log) if c[0] == "install"])
        # verification: byte-identical, root-owned, not writable by others, enabled, no competing fstab entry
        self.refused("differs from the generated unit", "verify-persistence")
        _w(out["unit"], text)
        self.refused("is not enabled", "verify-persistence")
        os.symlink("../" + name, os.path.join(self.env.systemd_dir, "multi-user.target.wants", name))
        os.chmod(out["unit"], 0o666); self.refused("root-owned regular file", "verify-persistence"); os.chmod(out["unit"], 0o644)
        _a(self.env.fstab, f"/some/img {self.cfg['target_mount']} ext4 loop 0 0\n")
        self.refused("fstab also names the target", "verify-persistence")
        _w(self.env.fstab, "# " + self.cfg["target_mount"] + " in a comment is fine\n")
        self.ok("verify-persistence")
        self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        # cut-over re-checks the unit each time: a later edit blocks a re-run (and a second tree's cut-over)
        _a(out["unit"], "# edited\n")
        self.refused("differs from the generated unit", "cutover", "--tree", ".pixel10", "--apps-stopped-attestation", "users stopped")

    def to_verified_without_persistence(self):
        for n in ("codex-archive", ".pixel10"):
            self.ok("inventory-source", "--tree", n)
        self.ok("prepare-image", "--execute"); self.ok("verify-mount")
        for n in ("codex-archive", ".pixel10"):
            self.ok("copy", "--tree", n); self.ok("verify", "--tree", n)


@unittest.skipUnless(RSYNC, "rsync is required")
class SafeRollback(Base):
    def test_rollback_refuses_after_target_writes_and_reverse_copy_preserves_everything(self):
        self.to_verified(); self.writer_check()
        self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        dst = self.cfg["target_mount"] + "/enclave-volumes/codex-archive"
        with open(self.arch + "/2026-10-24/written-after-cutover.txt", "w") as f:     # an application writes via the symlink
            f.write("new work")
        self.refused("target changed since cut-over", "rollback", "--tree", "codex-archive")
        self.assertTrue(os.path.islink(self.arch))
        self.refused("--apps-stopped-attestation", "reverse-copy", "--tree", "codex-archive")
        self.write_guard(free=468719476736 + 10)
        self.refused("guard shutdown threshold", "reverse-copy", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.write_guard()
        self.env.t += 301
        self.refused("stale", "reverse-copy", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.writer_check()
        self.refused("no verified return copy", "rollback", "--tree", "codex-archive", "--use-return-copy")
        r = self.ok("reverse-copy", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped for the return copy")
        self.assertTrue(r["verified"])
        self.assertIn("already", self.ok("reverse-copy", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped"))
        rcopy = self.vm + "/.return-codex-archive"
        self.assertEqual(stat.S_IMODE(os.stat(rcopy).st_mode), 0o700)
        with open(dst + "/2026-10-24/late.txt", "w") as f:                          # a write after the reverse copy
            f.write("late")
        self.refused("target changed after the reverse copy", "rollback", "--tree", "codex-archive", "--use-return-copy")
        self.ok("reverse-copy", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped again")   # re-synced
        out = self.ok("rollback", "--tree", "codex-archive", "--use-return-copy")
        self.assertEqual(out["rolled_back"], "return-copy")
        self.assertTrue(os.path.isdir(self.arch) and not os.path.islink(self.arch))
        self.assertEqual(_rt(self.arch + "/2026-10-24/written-after-cutover.txt"), "new work", "the application's write is kept")
        self.assertEqual(_rt(self.arch + "/2026-10-24/late.txt"), "late")
        self.assertTrue(os.path.isdir(self.vm + "/.retire-codex-archive"), "the retired tree is kept")
        self.assertTrue(os.path.isfile(dst + "/2026-10-24/written-after-cutover.txt"), "the target is kept")
        self.assertFalse(os.path.lexists(rcopy))
        for i in range(3):
            self.assertTrue(os.path.exists(f"{self.home}/link{i}"))

    def test_a_deletion_in_the_target_is_never_silently_mirrored_back(self):
        self.to_verified(); self.writer_check()
        self.ok("cutover", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        dst = self.cfg["target_mount"] + "/enclave-volumes/codex-archive"
        _w(dst + "/2026-10-24/tmpfile", "x")
        self.ok("reverse-copy", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        os.unlink(dst + "/2026-10-24/tmpfile")                        # removed in the target after the return copy
        self.refused("differs from the target", "reverse-copy", "--tree", "codex-archive", "--apps-stopped-attestation", "users stopped")
        self.assertTrue(os.path.exists(self.vm + "/.return-codex-archive/2026-10-24/tmpfile"), "kept for inspection, nothing deleted")
        self.refused("no verified return copy", "rollback", "--tree", "codex-archive", "--use-return-copy")
        self.assertTrue(os.path.islink(self.arch))


if __name__ == "__main__":
    unittest.main(verbosity=2)
