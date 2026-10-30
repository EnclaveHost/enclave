#!/usr/bin/env python3
"""reclaim-r3 offline tests on TEMP fixture trees only (no root, no real /vm, /, archive or home paths, no global scan).
Everything reclaim consumes is produced by the REAL frozen r9 code: inventory, copy, verify, record-writer-check and cut-over
phases, and r9's real phase_writer_check/scan_users for scans A and B - over OWNED fixture /proc trees (fake pids with fdinfo
mnt_id+ino, maps dev:ino, fanotify marks, alias mounts, a nested NSpid) and, for A7, over the real /proc of ONE owned child
process holding a retired file open. Synthetic JSON appears only as mutations of real r9 results. Mounts/lane/memory/free space
are FakeEnv values; mountinfo for the scanner's own view is the real one (TEST_TMP must be on a fs whose maj:min == st_dev, as
for r9's own tests); rsync is the real binary."""
import contextlib, hashlib, io, json, os, select, shutil, stat, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.dont_write_bytecode = True
import reclaim as C  # noqa: E402

ST, R = C.ST, C.R
RSYNC = os.environ.get("RSYNC") or shutil.which("rsync")
GIB = 1 << 30
LANE = 268435456
SUBS = ["2026-10-24/home/hf-convert", "2026-10-24/home/gvs5h", "2026-10-24/home/gguf-e2b"]


def mkfile(p, data=b"", mode=0o644):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    os.chmod(p, mode)


class FakeEnv(C.Env):
    production = False

    def __init__(self, tmp):
        self.tmp, self.uid, self.t = tmp, 4242, 1_000_000.0
        self.fake_proc = self.proc = os.path.join(tmp, "proc"); os.makedirs(f"{self.proc}/self", exist_ok=True)
        self.set_nspid("4242")
        self.sys_block = os.path.join(tmp, "sysblock"); os.makedirs(self.sys_block, exist_ok=True)
        self.shared = {}
        self.lane, self.avail_mem, self.free_dest, self.free_src = str(LANE), 20 * GIB, 10 ** 13, 10 ** 9
        self.mounts_ok, self.dest_on_source = True, False
        self.mount_table = [{"majmin": "8:1", "root": "/", "point": f"{tmp}/vm", "fstype": "ext4", "source": "/dev/fakevm", "opts": [], "super": []},
                            {"majmin": "8:2", "root": "/", "point": f"{tmp}/root", "fstype": "ext4", "source": "/dev/fakeroot", "opts": [], "super": []}]

    def set_nspid(self, v):
        with open(f"{self.fake_proc}/self/status", "w") as f:
            f.write(f"Name:\tpython3\nNSpid:\t{v}\n")

    def euid(self): return self.uid
    def now(self): return self.t
    def same_files(self, pid, tid): return self.shared.get(tid, True)
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
        r = subprocess.run(argv, capture_output=True)
        return r.returncode, r.stderr[-4096:].decode("utf-8", "replace")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rec3", dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, self.tmp, True)
        t = self.tmp
        self.arch = f"{t}/vm/enclave-volumes/codex-archive"; os.makedirs(os.path.dirname(self.arch)); os.mkdir(self.arch, 0o700)
        a = f"{self.arch}/2026-10-24"
        for s in SUBS:
            mkfile(f"{self.arch}/{s}/model/w.bin", os.urandom(200_000)); mkfile(f"{self.arch}/{s}/README", b"r")
            mkfile(f"{self.arch}/{s}/deep/x/y.bin", os.urandom(5000), 0o600)
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
        self.c8p = f"{t}/cfg9.json"; self.put(self.c8p, self.c8)
        self.rjd = f"{t}/root/home/steven/.local/state/nvme-cold-reclaim-r3"
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

    def run9(self, *args):
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

    def scan(self, mod=None):
        """the REAL frozen r9 root scan (phase_writer_check via r9 main) of the current env, captured into an owner file"""
        self.env.t += 5; self.env.uid = 0
        try:
            res = json.loads(self.run9("writer-check"))
        finally:
            self.env.uid = 4242
        if mod:
            mod(res)                                                   # a mutation of a REAL result (never invented JSON)
        self.n += 1; p = f"{self.tmp}/scan-{self.n}.json"; self.put(p, res); return p

    def paths(self, sub):
        src = f"{self.arch}/{sub}"
        return src, f"{self.dest_root}/{sub}", f"{os.path.dirname(src)}/.retire-{os.path.basename(sub)}"

    def r9_state(self):
        p = f"{self.c8['journal_dir']}/state.json"
        return json.load(open(p))["trees"] if os.path.exists(p) else {}

    def rstate(self, sub):
        p = f"{self.rjd}/state.json"
        return json.load(open(p))["trees"].get(sub, {}) if os.path.exists(p) else {}

    def cut_over(self, *subs):
        st = self.r9_state()
        for s in SUBS:
            if "source_inventory" not in st.get(s, {}):
                self.run9("inventory-source", "--subtree", s)
        for s in subs:
            self.run9("copy", "--subtree", s); self.run9("verify", "--subtree", s)
            self.run9("record-writer-check", "--result", self.scan())
            self.run9("cutover", "--subtree", s, "--apps-stopped-attestation", f"{os.path.basename(s)} users stopped")

    def prepared(self, *subs):
        subs = subs or (SUBS[2],)
        self.cut_over(*subs)
        return [self.ok("verify", "--subtree", s) for s in subs][0]

    def reclaim(self, sub=SUBS[2], result=None, confirm=None):
        return self.ph("reclaim", "--subtree", sub, "--result", result or self.scan(), "--reclaim-retired", confirm or self.paths(sub)[2])

    def confirm(self, sub=SUBS[2], result=None):
        return self.ph("confirm", "--subtree", sub, "--result", result or self.scan())

    def count(self, root):
        return sum(len(ds) + len(fs) for _, ds, fs in os.walk(root))

    # owned fixture processes in the fake /proc (the r9 test idiom)
    def fake_pid(self, pid="4001", extra_mounts="", ns="mnt:[1]"):
        b = f"{self.env.fake_proc}/{pid}"
        for d in ("fd", "fdinfo", f"task/{pid}", "ns"):
            os.makedirs(f"{b}/{d}", exist_ok=True)
        for n in ("cwd", "root"):
            os.symlink("/", f"{b}/{n}"); os.symlink("/", f"{b}/task/{pid}/{n}")
        os.symlink(sys.executable, f"{b}/exe"); os.symlink(ns, f"{b}/ns/mnt")
        with open("/proc/self/mountinfo") as src, open(f"{b}/mountinfo", "w") as f:
            f.write(src.read() + extra_mounts)
        with open(f"{b}/comm", "w") as f:
            f.write("fixture\n")
        open(f"{b}/maps", "w").close()
        self.addCleanup(shutil.rmtree, b, True)
        return b

    @staticmethod
    def fd(b, n, target, info=None):
        os.symlink(target, f"{b}/fd/{n}")
        if info is not None:
            with open(f"{b}/fdinfo/{n}", "w") as f:
                f.write(info)

    def own_mount_id(self):
        """the real mount id of the mount holding the fixture (fdinfo mnt_id refers to it)"""
        best = None
        for m in ST.parse_mounts(open("/proc/self/mountinfo").read()):
            if R._under(self.tmp, m["point"]) and (best is None or len(m["point"]) >= len(best["point"])):
                best = m
        return best["id"], best["majmin"]

    @staticmethod
    def kdev(dev):
        return format((os.major(dev) << 20) | os.minor(dev), "x")


class EndToEnd(Base):
    def test_real_r9_flow_reclaim_then_confirm_with_rehash_top_never_renamed(self):
        v = self.prepared(); src, dst, ret = self.paths(SUBS[2])
        self.assertEqual((v["hashed_fresh"], v["plan_files"], v["plan_dirs"]), (3, 3, 4))
        others = {s: R.identity_now(f"{self.arch}/{s}") for s in SUBS[:2]}; dest_before = R.walk_meta(dst)
        scan_a = self.scan()
        calls = []; real = (os.unlink, os.rmdir, os.rename, shutil.rmtree)
        os.unlink = lambda p, *a, **k: (calls.append(("unlink", p, k.get("dir_fd"))), real[0](p, *a, **k))[1]
        os.rmdir = lambda p, *a, **k: (calls.append(("rmdir", p, k.get("dir_fd"))), real[1](p, *a, **k))[1]
        os.rename = lambda p, q, *a, **k: (calls.append(("rename", (p, q), k.get("src_dir_fd"))), real[2](p, q, *a, **k))[1]
        shutil.rmtree = lambda *a, **k: self.fail("recursive rm used")
        try:
            rc, out, err = self.reclaim(result=scan_a)
        finally:
            os.unlink, os.rmdir, os.rename, shutil.rmtree = real
        self.assertEqual(rc, 0, err); self.assertEqual(self.rstate(SUBS[2])["reclaim"], "deleted-unconfirmed")
        self.assertFalse(os.path.exists(f"{self.rjd}/reclaimed-gguf-e2b.json"))                   # not green yet
        fdc = [c for c in calls if c[2] is not None]
        ren = [c[1] for c in fdc if c[0] == "rename"]
        self.assertEqual(len(ren), 6); self.assertTrue(all(q.startswith(C.TMP) for p, q in ren))   # 3 files + 3 inner dirs
        self.assertNotIn(os.path.basename(ret), [p for p, q in ren])                            # D1: the top is never renamed
        self.assertEqual(sorted(c[1] for c in fdc if c[0] == "rmdir")[-1], os.path.basename(ret))
        self.assertEqual((len([c for c in fdc if c[0] == "unlink"]), len([c for c in fdc if c[0] == "rmdir"])), (3, 4))
        self.assertEqual([c for c in calls if c[2] is None and c[0] != "rename"], [])
        self.assertTrue(C.absent(ret)); self.assertEqual((os.readlink(src), R.walk_meta(dst)), (dst, dest_before))
        self.assertEqual({s: R.identity_now(f"{self.arch}/{s}") for s in SUBS[:2]}, others)
        out = self.ok("confirm", "--subtree", SUBS[2], "--result", self.scan())                 # real scan B: .retire absent
        self.assertEqual((out["state"], out["hashed_fresh"], out["deleted_journalled"]["files"], out["deleted_journalled"]["dirs"]), ("complete", 3, 3, 4))
        self.assertTrue(all(out["post_checks"].values())); self.assertEqual(len(out["scans"]), 2)
        self.assertEqual(self.ok("check-retained", "--subtree", SUBS[2])["hashed_fresh"], 3)
        self.assertEqual(open(f"{self.home}/link1", "rb").read(), b"r")
        with self.assertRaises(AssertionError):
            self.run9("rollback", "--subtree", SUBS[2])                                         # fails closed, changes nothing
        self.assertEqual(os.readlink(src), dst)


class A7(Base):
    def test_actual_deleted_fd_holder_is_attributed_by_the_real_r9_scan_after_the_tree_is_gone(self):
        """a REAL owned child opens a retired file after scan A (the race window); after reclaim the real r9 scan of that child's
        real /proc entries must report it under the .retire prefix with ' (deleted)', confirm must refuse, and the data must be
        rescuable through /proc/<pid>/fd/<n>"""
        self.prepared(); src, dst, ret = self.paths(SUBS[2])
        scan_a = self.scan()                                                                   # zero users at A
        code = "import sys, time\nf = open(sys.argv[1], 'rb')\nprint('ready', flush=True)\ntime.sleep(120)\n"
        p = subprocess.Popen([sys.executable, "-I", "-B", "-c", code, f"{ret}/README"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(p.wait); self.addCleanup(p.kill)
        ready = select.select([p.stdout], [], [], 30)[0]
        self.assertEqual((p.stdout.readline() if ready else "").strip(), "ready")
        rc, out, err = self.reclaim(result=scan_a); self.assertEqual(rc, 0, err); self.assertTrue(C.absent(ret))
        self.env.proc = "/proc"; self.env.pids = lambda: [str(p.pid)]                           # real /proc, our child only
        try:
            path_b = self.scan()
        finally:
            self.env.proc = self.env.fake_proc; del self.env.pids
        res = json.load(open(path_b))
        held = [h for h in res["hits"] if h["how"] == "path" and h["target"].endswith(" (deleted)") and R._under(h["target"][:-len(" (deleted)")], ret)]
        self.assertTrue(held, res["hits"])                                                     # A7 on the actual kernel
        self.assertEqual({h["pid"] for h in held}, {str(p.pid)})
        self.assertEqual(self.confirm(result=path_b)[0], 3)
        self.assertEqual(self.rstate(SUBS[2])["reclaim"], "deleted-unconfirmed")               # never green with a holder
        fdn = [n for n in os.listdir(f"/proc/{p.pid}/fd") if os.readlink(f"/proc/{p.pid}/fd/{n}").endswith(" (deleted)")][0]
        with open(f"/proc/{p.pid}/fd/{fdn}", "rb") as f:
            self.assertEqual(f.read(), b"r")                                                   # the rescue path works
        p.kill(); p.wait()
        self.assertEqual(self.ok("confirm", "--subtree", SUBS[2], "--result", self.scan())["state"], "complete")


class RealScanner(Base):
    def test_inode_users_of_this_subtree_retired_or_destination_block_only_it(self):
        self.prepared(SUBS[2], SUBS[1]); _, dst2, ret2 = self.paths(SUBS[2]); _, _, ret1 = self.paths(SUBS[1])
        mid, _ = self.own_mount_id(); d = os.stat(f"{dst2}/README"); w = os.stat(f"{ret2}/model/w.bin")
        b = self.fake_pid()
        self.fd(b, 3, "/elsewhere/README", f"pos:\t0\nflags:\t0100000\nmnt_id:\t{mid}\nino:\t{d.st_ino}\n")      # a foreign path string
        with open(f"{b}/maps", "w") as f:
            f.write(f"7f0000000000-7f0000001000 r--p 00000000 {os.major(w.st_dev):02x}:{os.minor(w.st_dev):02x} {w.st_ino}    /elsewhere/w.bin\n")
        res_p = self.scan(); res = json.load(open(res_p))
        got = {(h["where"], h["how"], h["class"], h["subtree"]) for h in res["hits"]}
        self.assertTrue({("fd/3", "inode", "dest", SUBS[2]), ("maps", "inode", "retire", SUBS[2])} <= got, got)
        self.assertTrue(res["complete"], res["incomplete"])
        self.assertIn("users of", self.reclaim(SUBS[2], result=res_p)[2]); self.assertEqual(self.count(ret2), 6)
        rc, out, err = self.reclaim(SUBS[1], result=res_p); self.assertEqual(rc, 0, err)            # gvs5h is unaffected
        self.assertTrue(C.absent(ret1)); self.assertEqual(self.count(ret2), 6)

    def test_alias_watcher_and_missed_visibility_from_the_real_scanner_block(self):
        self.prepared(); ret = self.paths(SUBS[2])[2]
        mid, mm = self.own_mount_id()
        b = self.fake_pid(extra_mounts=f"999999 1 {mm} / /elsewhere rw - ext4 /dev/fake rw\n")
        res = json.load(open(p := self.scan()))
        self.assertTrue([a for a in res["aliases"] if a["class"] == "retire" and a["subtree"] == SUBS[2]], res["aliases"])
        self.assertIn("mount alias", self.reclaim(result=p)[2]); shutil.rmtree(b)
        b = self.fake_pid(pid="4002")
        self.fd(b, 4, "anon_inode:[fanotify]", f"pos:\t0\nflags:\t02\nmnt_id:\t15\nino:\t1057\n"
                f"fanotify sdev:{self.kdev(os.stat(ret).st_dev)} mflags:0 mask:3b ignored_mask:0\n")
        res = json.load(open(p := self.scan())); self.assertTrue(res["fsWatchers"], res)
        self.assertIn("watchers", self.reclaim(result=p)[2]); shutil.rmtree(b)
        self.env.set_nspid("7\t1")                                                               # a nested PID namespace
        res = json.load(open(p := self.scan())); self.assertFalse(res["complete"])
        self.assertIn("incomplete", self.reclaim(result=p)[2]); self.env.set_nspid("4242")
        self.assertEqual(self.count(ret), 6)
        rc, out, err = self.reclaim(); self.assertEqual(rc, 0, err)

    def test_real_results_are_bound_fresh_ordered_authentic_and_single_use(self):
        self.prepared(); src, dst, ret = self.paths(SUBS[2])
        tg = lambda r, cls: [t for t in r["targets"] if t["class"] == cls and t["subtree"] == SUBS[2]][0]
        for mod, needle in ((lambda r: tg(r, "retire").update(entries=tg(r, "retire")["entries"] + 1), "retired walk"),
                            (lambda r: tg(r, "retire").update(majmin="0:0"), "retired walk"),
                            (lambda r: tg(r, "dest").update(entries=1), "destination walk"),
                            (lambda r: tg(r, "dest").update(dev=0), "destination walk"),
                            (lambda r: tg(r, "source").update(state="dir"), "cut-over symlink"),
                            (lambda r: r["targets"].remove(tg(r, "retire")), "no single retire target"),
                            (lambda r: r.update(t=1.0), "stale"), (lambda r: r.update(tEnd=r["t"] - 1), "stale"),
                            (lambda r: r.update(t=r["t"] + 10, tEnd=r["t"] + 10), "stale"),
                            (lambda r: r.update(hitsTotal=r["hitsTotal"] + 1), "truncated"),
                            (lambda r: r.update(prefixes=[]), "do not cover"),
                            (lambda r: r["tools"].update({"jobs/root-writer-check.sh": "0" * 64}), "frozen r9 tool bytes"),
                            (lambda r: r.update(euid=1000), "frozen r9 tool bytes"),
                            (lambda r: r.update(format="nvme-cold-subtree-writer-check/r8"), "not an r9"),
                            (lambda r: r.update(extra=1), "keys must be exactly"),
                            (lambda r: r.pop("destAliases"), "keys must be exactly"),
                            (lambda r: r.update(destAliases=[{"subtree": SUBS[2], "exposesAt": "/sandbox"}]), "mount alias")):
            self.assertIn(needle, self.reclaim(result=self.scan(mod))[2])
        old = self.scan(); self.env.t += 301; self.assertIn("stale", self.reclaim(result=old)[2])
        early = self.scan(); self.ok("verify", "--subtree", SUBS[2])
        self.assertIn("not taken after the verify receipt", self.reclaim(result=early)[2])
        loose = self.scan(); os.chmod(loose, 0o666); self.assertIn("group/world-writable", self.reclaim(result=loose)[2])
        self.assertEqual(self.count(ret), 6)


class Crash(Base):
    def test_crash_after_rename_resumes_unknown_tool_names_refuse_scans_single_use(self):
        self.prepared(); ret = self.paths(SUBS[2])[2]
        real = os.unlink
        os.unlink = lambda p, *a, **k: (_ for _ in ()).throw(OSError(5, "simulated EIO")) if k.get("dir_fd") is not None else real(p, *a, **k)
        try:
            used = self.scan(); self.assertIn("interrupted", self.reclaim(result=used)[2])
        finally:
            os.unlink = real
        self.assertEqual(self.rstate(SUBS[2])["reclaim"], "deleting")
        self.assertEqual([n for n in os.listdir(ret) if n.startswith(C.TMP)], [f"{C.TMP}1"])       # README (plan index 1), moved
        self.assertIn("already used", self.reclaim(result=used)[2])
        for bad in (f"{C.TMP}999", f"{C.TMP}0", f"{C.TMP}x"):
            mkfile(f"{ret}/{bad}", b"?"); self.assertIn("unrecognized entry", self.reclaim()[2])
            self.assertTrue(os.path.exists(f"{ret}/{bad}")); real(f"{ret}/{bad}")
        rc, out, err = self.reclaim(); self.assertEqual(rc, 0, err)                              # real scan sees the remaining tree
        self.assertEqual(self.ok("confirm", "--subtree", SUBS[2], "--result", self.scan())["state"], "complete")

    def test_swap_between_check_and_unlink_never_deletes_the_unplanned_inode(self):
        self.prepared(); ret = self.paths(SUBS[2])[2]
        real, done = os.rename, []
        def racing(p, q, *a, **k):
            if p == "README" and q.startswith(C.TMP) and not done:
                done.append(1); mkfile(f"{ret}/README.new", b"other"); real(f"{ret}/README.new", f"{ret}/README")
            return real(p, q, *a, **k)
        os.rename = racing
        try:
            self.assertIn("not the planned one", self.reclaim()[2])
        finally:
            os.rename = real
        self.assertEqual(open(f"{ret}/README", "rb").read(), b"other")
        self.assertFalse([n for n in os.listdir(ret) if n.startswith(C.TMP)])
        self.assertIn("differs from the verified plan", self.reclaim()[2]); self.assertTrue(os.path.exists(f"{ret}/README"))

    def test_crash_at_the_top_keeps_its_name_resumes_and_confirm_needs_proof(self):
        self.prepared(); ret = self.paths(SUBS[2])[2]
        real = os.rmdir
        os.rmdir = lambda p, *a, **k: (_ for _ in ()).throw(OSError(16, "busy")) if p == os.path.basename(ret) else real(p, *a, **k)
        try:
            self.assertIn("interrupted", self.reclaim()[2])
        finally:
            os.rmdir = real
        self.assertEqual(self.rstate(SUBS[2])["reclaim"], "rmdir-top"); self.assertEqual(os.listdir(ret), [])   # still .retire-<name>
        self.assertIn("nothing to confirm", self.confirm()[2])
        mkfile(f"{ret}/late", b"l"); self.assertEqual(self.reclaim()[0], 3); self.assertTrue(os.path.exists(f"{ret}/late"))
        os.unlink(f"{ret}/late")
        rc, out, err = self.reclaim(); self.assertEqual(rc, 0, err); self.assertTrue(C.absent(ret))
        real_lstat = os.lstat
        os.lstat = lambda p, *a, **k: (_ for _ in ()).throw(PermissionError(13, "denied")) if p == ret else real_lstat(p, *a, **k)
        try:
            self.assertIn("cannot prove", self.confirm()[2])                                     # EACCES is never absence
        finally:
            os.lstat = real_lstat
        self.assertEqual(self.rstate(SUBS[2])["reclaim"], "deleted-unconfirmed")
        self.assertEqual(self.ok("confirm", "--subtree", SUBS[2], "--result", self.scan())["state"], "complete")

    def test_destination_change_during_reclaim_is_never_green(self):
        self.prepared(); src, dst, ret = self.paths(SUBS[2])
        rc, out, err = self.reclaim(); self.assertEqual(rc, 0, err)
        mkfile(f"{dst}/written-during", b"w")
        self.assertIn("NOT complete", self.confirm()[2])
        self.assertEqual(self.rstate(SUBS[2])["reclaim"], "post-check-failed")
        self.assertIn("nothing to confirm", self.confirm()[2]); self.assertIn("already finished", self.reclaim()[2])
        self.assertEqual(json.load(open(f"{self.rjd}/reclaimed-gguf-e2b.json"))["state"], "post-check-failed")


class Bindings(Base):
    def test_late_writer_r4_and_receipt_bindings_refuse_nothing_deleted(self):
        self.cut_over(SUBS[2]); ret = self.paths(SUBS[2])[2]
        with open(f"{ret}/README", "ab") as f:                       # a write through an fd opened before the rename (R4)
            f.write(b"+")
        self.refused("not the tree that was verified", "verify", "--subtree", SUBS[2])
        self.tearDown(); self.setUp(); self.prepared(); ret = self.paths(SUBS[2])[2]
        with open(f"{ret}/deep/x/y.bin", "r+b") as f:
            f.write(b"Z")
        self.assertIn("a late writer", self.reclaim()[2])
        self.tearDown(); self.setUp(); self.prepared(); ret = self.paths(SUBS[2])[2]
        p = f"{self.c8['journal_dir']}/state.json"; raw = open(p).read(); st = json.loads(raw)
        st["trees"][SUBS[2]]["note"] = "changed"
        with open(p, "w") as f:
            json.dump(st, f)
        self.assertIn("changed since the verify receipt", self.reclaim()[2])
        with open(p, "w") as f:
            f.write(raw)
        self.rc["verify_max_age_seconds"] = 3599; self.put(self.rcp, self.rc)
        self.assertIn("changed since the verify receipt", self.reclaim()[2])
        self.rc["verify_max_age_seconds"] = 3600; self.put(self.rcp, self.rc)
        lf = [n for n in os.listdir(self.rjd) if n.startswith("dest-gguf-e2b-") and n.endswith(".logical.json")][0]
        with open(f"{self.rjd}/{lf}", "a") as f:
            f.write(" ")
        self.assertIn("logical file changed", self.reclaim()[2])
        self.assertEqual(self.count(ret), 6)


class Stage(unittest.TestCase):
    def test_frozen_r9_pins_api_and_banned_operations(self):
        with open(os.path.join(C.R9_DIR, "SHA256SUMS"), "rb") as f:
            sums = f.read()
        self.assertEqual(hashlib.sha256(sums).hexdigest(), C.R9_SUMS_SHA256)
        listed = dict(reversed(l.split("  ", 1)) for l in sums.decode().splitlines())
        self.assertEqual({k: listed[k] for k in C.R9_TOOLS}, C.R9_TOOLS); self.assertEqual(ST.tool_shas(), C.R9_TOOLS)
        self.assertEqual((ST.WC_FORMAT, list(ST.WC_KEYS)), (C.R9_FORMAT, C.R9_KEYS))
        txt = open(os.path.join(os.path.dirname(HERE), "reclaim.py")).read()
        for banned in ("rmtree", "os.system", "subprocess", "glob", "shell=True", "os.walk(", "sudo "):
            self.assertNotIn(banned, txt, banned)


if __name__ == "__main__":
    unittest.main()
