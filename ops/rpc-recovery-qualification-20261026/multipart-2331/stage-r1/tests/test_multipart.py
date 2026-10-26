#!/usr/bin/env python3
"""recovery-multipart-stage/r1 tests (PREPARED by Claude 1746; root runs them via jobs/tests.sh; NOT run by Claude).
Tiny fixtures only (< 1 MiB each, under TEST_TMP): a 50-block logical source with data extents and map holes, including a sparse
tail that makes the last part a pure hole; two separate target directories. Expected results come from the fixture itself (the
source bytes read directly, an independent hashlib sha256 of their concatenation), never from the code under test. The copier and
the server run as REAL subprocesses wherever exit codes, signals or RLIMIT_FSIZE matter."""
import contextlib, hashlib, io, json, os, resource, signal, socket, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = str(HERE.parent / "multipart.py")
sys.path.insert(0, str(HERE.parent)); sys.dont_write_bytecode = True
import multipart as MP  # noqa: E402

BS = 4096
EXTENTS = [[0, 10, 900, False], [12, 19, 950, False], [33, 8, 990, False]]   # blocks 10-11, 31-32 and 41-49 (tail) are holes
NBLK = 50
L = NBLK * BS                                                                   # 204800 = 3 x 65536 + 8192: part 3 is all hole
PART = 65536


def det_bytes(seed, n):
    out, i = bytearray(), 0
    while len(out) < n:
        out += hashlib.sha256(f"{seed}-{i}".encode()).digest(); i += 1
    return bytes(out[:n])


def cli(*args, preexec=None, env=None):
    return subprocess.run([sys.executable, "-I", "-B", TOOL, *args], capture_output=True, text=True, timeout=120,
                          preexec_fn=preexec, env=env or {"PATH": "/usr/bin:/bin"})


def inproc(*args):
    with contextlib.redirect_stdout(io.StringIO()) as o, contextlib.redirect_stderr(io.StringIO()) as e:
        rc = MP.main(list(args))
    return rc, o.getvalue(), e.getvalue()


def sha_path(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class Fixture:
    def __init__(self, base):
        self.d = Path(tempfile.mkdtemp(prefix="mp", dir=base))
        self.src = self.d / "source.img"
        with open(self.src, "wb") as f:
            f.truncate(L)
            for lb, n, _pb, _u in EXTENTS:
                f.seek(lb * BS); f.write(det_bytes(f"data{lb}", n * BS))
        self.map = self.d / "map.json"
        self.map.write_text(json.dumps({"format": "ext4-recovery-checksum-r1/v1", "map": {"extentList": EXTENTS, "extents": len(EXTENTS)}}))
        self.journal = self.d / "journal.bin"; self.journal.write_bytes(det_bytes("journal", 65536))
        self.original = self.d / "original.qcow2"; self.original.write_bytes(det_bytes("qcow2", 12345))
        self.plan = self.d / "plan.json"
        self.write_plan()
        self.ta, self.tb = self.d / "target-a", self.d / "target-b"
        for t in (self.ta, self.tb):
            t.mkdir(mode=0o700)
        self.sockdir = self.d / "sock"; self.sockdir.mkdir(mode=0o700)
        self.manifest = self.d / "manifest.json"

    def write_plan(self, patches=None):
        self.plan.write_text(json.dumps({"format": "recovery-overlay-plan/v1",
                                         "inputs": {"candidatesSha256": sha_path(self.map), "journalSha256": sha_path(self.journal)},
                                         "target": {"size": L}, "map": {"extents": len(EXTENTS)},
                                         "patches": patches or [{"kind": "inode", "fsBlock": 7, "byteOffset": 1024, "length": 256, "sha256": "ab" * 32, "source": "000.bin"},
                                                                {"kind": "tree", "fsBlock": 9, "byteOffset": 36864, "length": 4096, "sha256": "cd" * 32, "source": "001.bin"}]}))

    def plan_args(self, *extra, out=None, ta=None):
        return ["plan", "--original", str(self.original), "--map", str(self.map), "--overlay-plan", str(self.plan), "--journal", str(self.journal),
                "--out", str(out or self.manifest), "--target", f"a={ta or self.ta}", "--target", f"b={self.tb}", "--assign", "a:0-1", "--assign", "b:2-3",
                "--logical-size", str(L), "--part-size", str(PART), "--chunk-bytes", "8192", "--checkpoint-bytes", "16384", *extra]

    def make_plan(self, *extra):
        rc, out, err = inproc(*self.plan_args(*extra))
        assert rc == 0, err
        return json.loads(out)["manifestSha256"]

    def m(self, msha):
        return ["--manifest", str(self.manifest), "--manifest-sha256", msha]

    def parts(self):
        return [self.ta / "part-0000.bin", self.ta / "part-0001.bin", self.tb / "part-0002.bin", self.tb / "part-0003.bin"]

    def reassembled(self):
        return b"".join(p.read_bytes() for p in self.parts())


class Base(unittest.TestCase):
    def setUp(self):
        self.f = Fixture(os.environ.get("TEST_TMP"))

    def rewrite_manifest(self, mutate):
        d = json.loads(self.f.manifest.read_text()); mutate(d)
        raw = (json.dumps(d, indent=1, sort_keys=True) + "\n").encode()
        self.f.manifest.chmod(0o600); self.f.manifest.write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()


class Positive(Base):
    def test_copy_two_targets_then_independent_verify_reassembles_the_source(self):
        msha = self.f.make_plan()
        doc = json.loads(self.f.manifest.read_text())
        self.assertEqual([(p["offset"], p["length"], p["target"]) for p in doc["parts"]],
                         [(0, PART, "a"), (PART, PART, "a"), (2 * PART, PART, "b"), (3 * PART, 8192, "b")])
        self.assertEqual(doc["source"]["holes"], [[40960, 8192], [126976, 8192], [167936, 36864]])     # from EXTENTS, by hand
        r = cli("copy", *self.f.m(msha), "--source-file", str(self.f.src))
        self.assertEqual(r.returncode, 0, r.stderr)
        st = json.loads(cli("status", *self.f.m(msha)).stdout)
        self.assertEqual((st["copyComplete"], st["verificationComplete"]), (True, False))   # copied is NOT verified
        self.assertNotIn("productionReady", st); self.assertNotIn("raidReset", st)
        r = cli("verify", *self.f.m(msha), "--source-file", str(self.f.src))
        self.assertEqual(r.returncode, 0, r.stderr)
        st = json.loads(cli("status", *self.f.m(msha)).stdout)
        self.assertEqual((st["copyComplete"], st["verificationComplete"], st["partsVerified"]), (True, True, 4))
        self.assertEqual(hashlib.sha256(self.f.reassembled()).hexdigest(), sha_path(self.f.src))       # independent of the tool
        self.assertEqual(self.f.parts()[3].read_bytes(), bytes(8192))                                     # the sparse-tail part
        self.assertEqual([p.stat().st_size for p in self.f.parts()], [PART, PART, PART, 8192])
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in self.f.parts()))

    def test_resume_after_budget_stop_inside_a_part(self):
        msha = self.f.make_plan()
        r = cli("copy", *self.f.m(msha), "--source-file", str(self.f.src), "--max-bytes", "24576")    # stops inside part 0
        self.assertEqual(r.returncode, 5, r.stderr)
        ck = json.loads((self.f.ta / "part-0000.ckpt.json").read_text())
        self.assertEqual(ck["committedBytes"], 24576); self.assertFalse((self.f.ta / "part-0000.json").exists())
        partial = (self.f.ta / "part-0000.bin.partial").read_bytes()[:24576]
        self.assertEqual(hashlib.sha256(partial).hexdigest(), ck["prefixSha256"])
        self.assertEqual(partial, self.f.src.read_bytes()[:24576])
        r = cli("copy", *self.f.m(msha), "--source-file", str(self.f.src))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.f.reassembled(), self.f.src.read_bytes())
        self.assertFalse((self.f.ta / "part-0000.ckpt.json").exists()); self.assertFalse((self.f.ta / "part-0000.bin.partial").exists())

    def test_sigterm_mid_part_stops_cleanly_and_resumes(self):
        msha = self.f.make_plan()
        p = subprocess.Popen([sys.executable, "-I", "-B", TOOL, "copy", *self.f.m(msha), "--source-socket-dir", str(self.f.sockdir),
                              "--accept-timeout", "60"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        served, hang = [0], threading.Event()

        def server():                       # the test plays `serve`, answering 5 requests, then stalling
            end = time.monotonic() + 60
            while not (self.f.sockdir / "mp.sock").exists() and time.monotonic() < end:
                time.sleep(0.05)
            dfd = os.open(self.f.sockdir, os.O_RDONLY | os.O_DIRECTORY)            # /proc/self/fd/N: under the 108-byte AF_UNIX limit
            s = socket.socket(socket.AF_UNIX); s.connect(f"/proc/self/fd/{dfd}/mp.sock"); os.close(dfd)
            s.sendall((json.dumps({"proto": MP.FMT["proto"], "size": L}) + "\n").encode())
            f, data = s.makefile("rb"), self.f.src.read_bytes()
            while True:
                line = f.readline()
                if not line or line == b"Q\n":
                    break
                _r, off, n = line.split(); off, n = int(off), int(n)
                if served[0] == 5:
                    hang.set(); f.readline(); break
                s.sendall(f"D {off} {n}\n".encode() + data[off:off + n]); served[0] += 1
            s.close()
        t = threading.Thread(target=server, daemon=True); t.start()
        self.assertTrue(hang.wait(60))
        time.sleep(0.3); p.send_signal(signal.SIGTERM)
        _o, err = p.communicate(timeout=60); t.join(10)
        self.assertEqual(p.returncode, 5, err)
        ck = json.loads((self.f.ta / "part-0000.ckpt.json").read_text())
        self.assertGreaterEqual(ck["committedBytes"], 16384); self.assertFalse((self.f.ta / "part-0000.json").exists())
        r = cli("copy", *self.f.m(msha), "--source-file", str(self.f.src))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(cli("verify", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 0)
        self.assertEqual(self.f.reassembled(), self.f.src.read_bytes())


class Integrity(Base):
    def copied(self):
        msha = self.f.make_plan()
        r = cli("copy", *self.f.m(msha), "--source-file", str(self.f.src)); self.assertEqual(r.returncode, 0, r.stderr)
        return msha

    def test_corrupt_destination_is_detected_and_kept(self):
        msha = self.copied(); p = self.f.parts()[1]
        b = bytearray(p.read_bytes()); b[100] ^= 1; p.chmod(0o600); p.write_bytes(bytes(b)); bad = bytes(b)
        self.assertEqual(cli("verify", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 4)
        self.assertEqual(cli("copy", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 4)   # resume refuses too
        self.assertEqual(p.read_bytes(), bad)                                                             # evidence untouched
        st = json.loads(cli("status", *self.f.m(msha)).stdout)
        self.assertFalse(st["verificationComplete"])

    def test_verification_rereads_the_source_and_never_accepts_copy_hashes_alone(self):
        msha = self.copied()
        # forge consistent copy-time evidence: tamper part 0 AND rewrite its record's hash to match the tampered bytes
        p, rec = self.f.parts()[0], self.f.ta / "part-0000.json"
        b = bytearray(p.read_bytes()); b[5] ^= 0xff; p.chmod(0o600); p.write_bytes(bytes(b))
        r = json.loads(rec.read_text()); r["logicalSha256"] = hashlib.sha256(bytes(b)).hexdigest(); rec.chmod(0o600); rec.write_text(json.dumps(r))
        self.assertEqual(cli("verify", *self.f.m(msha), "--source-file", str(self.f.src), "--parts", "0").returncode, 4)
        # a changed SOURCE after the copy is also caught (copy records alone are consistent)
        f2 = Fixture(os.environ.get("TEST_TMP")); f2_msha = f2.make_plan()
        self.assertEqual(cli("copy", *f2.m(f2_msha), "--source-file", str(f2.src)).returncode, 0)
        with open(f2.src, "r+b") as fh:
            fh.seek(70000); fh.write(b"\x01")
        self.assertEqual(cli("verify", *f2.m(f2_msha), "--source-file", str(f2.src)).returncode, 4)
        # no source -> no verification at all
        self.assertEqual(cli("verify", *f2.m(f2_msha), "--source-file", str(f2.d / "missing.img")).returncode, 3)
        self.assertFalse(json.loads(cli("status", *f2.m(f2_msha)).stdout)["verificationComplete"])

    def test_truncated_part_refused_and_kept(self):
        msha = self.copied(); p = self.f.parts()[2]
        os.truncate(p, 4096)
        self.assertEqual(cli("copy", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 4)
        self.assertEqual(cli("verify", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 4)
        self.assertEqual(p.stat().st_size, 4096)
        self.assertFalse(json.loads(cli("status", *self.f.m(msha)).stdout)["copyComplete"])

    def test_nonzero_source_inside_a_map_hole_refused(self):
        msha = self.f.make_plan()
        with open(self.f.src, "r+b") as fh:
            fh.seek(41 * BS + 7); fh.write(b"\x09")                   # block 41 is a map hole (sparse tail)
        r = cli("copy", *self.f.m(msha), "--source-file", str(self.f.src))
        self.assertEqual(r.returncode, 4); self.assertIn("map hole", r.stderr)
        self.assertFalse((self.f.tb / "part-0002.json").exists())

    def test_write_failure_then_resume(self):
        msha = self.f.make_plan()

        def cap():                                                     # EFBIG instead of SIGXFSZ: a write failure
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE, (20000, 20000))
        r = cli("copy", *self.f.m(msha), "--source-file", str(self.f.src), preexec=cap)
        self.assertEqual(r.returncode, 4, r.stderr)
        self.assertFalse((self.f.ta / "part-0000.json").exists())
        r = cli("copy", *self.f.m(msha), "--source-file", str(self.f.src))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(cli("verify", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 0)
        self.assertEqual(self.f.reassembled(), self.f.src.read_bytes())


class Integration(Base):
    def test_server_under_the_sessions_fsize_cap_feeds_a_copy_larger_than_the_cap(self):
        """the r9 session gives EVERY child RLIMIT_FSIZE = the overlay cap; serve writes no file, so parts larger than the cap work"""
        msha = self.f.make_plan()
        lim = lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (16384, 16384))    # far below one 65536-byte part
        for verb in ("copy", "verify"):
            c = subprocess.Popen([sys.executable, "-I", "-B", TOOL, verb, *self.f.m(msha), "--source-socket-dir", str(self.f.sockdir),
                                  "--accept-timeout", "60"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
            end = time.monotonic() + 60
            while not (self.f.sockdir / "mp.sock").exists() and time.monotonic() < end:
                time.sleep(0.05)
            s = cli("serve", "--socket-dir", str(self.f.sockdir), "--expect-size", str(L), preexec=lim,
                    env={"PATH": "/usr/bin:/bin", "RECOVERY_TARGET": str(self.f.src)})
            _o, err = c.communicate(timeout=60)
            self.assertEqual((c.returncode, s.returncode), (0, 0), (verb, err, s.stderr))
        self.assertEqual(self.f.reassembled(), self.f.src.read_bytes())
        # negative control: the copier itself under the same cap cannot write a part (why the copier must stay outside)
        f2 = Fixture(os.environ.get("TEST_TMP")); m2 = f2.make_plan()

        def cap():
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE, (16384, 16384))
        self.assertEqual(cli("copy", *f2.m(m2), "--source-file", str(f2.src), preexec=cap).returncode, 4)


class Bindings(Base):
    def test_changed_original_map_plan_patches_journal_or_manifest_refused(self):
        msha = self.f.make_plan()
        cases = []
        cases.append(("map", lambda: self.f.map.write_text(self.f.map.read_text() + " ")))
        cases.append(("journal", lambda: self.f.journal.write_bytes(det_bytes("journal2", 65536))))
        cases.append(("patch", lambda: self.f.write_plan([{"kind": "inode", "fsBlock": 7, "byteOffset": 1024, "length": 256, "sha256": "ef" * 32, "source": "000.bin"}])))
        cases.append(("original", lambda: os.utime(self.f.original, ns=(1, 1))))
        for name, mutate in cases:
            with self.subTest(name):
                f = Fixture(os.environ.get("TEST_TMP")); self.f = f; m = f.make_plan(); mutate()
                r = cli("copy", *f.m(m), "--source-file", str(f.src))
                self.assertEqual(r.returncode, 3, r.stderr)
                self.assertEqual(sorted(os.listdir(f.ta)), [])                 # nothing created
        f = Fixture(os.environ.get("TEST_TMP")); m = f.make_plan()
        f.manifest.chmod(0o600); f.manifest.write_text(f.manifest.read_text().replace('"part-0001.bin"', '"part-0001.bin" '))
        self.assertEqual(cli("copy", *f.m(m), "--source-file", str(f.src)).returncode, 3)    # manifest sha no longer matches

    def test_manifest_coverage_gaps_overlaps_duplicates_and_holes(self):
        self.f.make_plan()
        bad = {
            "gap": lambda d: d["parts"][1].update(offset=PART + 4096),
            "overlap": lambda d: d["parts"][2].update(offset=2 * PART - 4096),
            "duplicate": lambda d: d["parts"].insert(1, dict(d["parts"][0])),
            "missing-last": lambda d: d["parts"].pop(),
            "short-middle": lambda d: d["parts"][1].update(length=PART - 4096),
            "hole-dropped": lambda d: d["parts"][3].update(holes=[]),
            "global-hole-moved": lambda d: d["source"]["holes"][0].__setitem__(0, 45056),
            "extra-key": lambda d: d.update(productionReady=True),
            "unknown-target": lambda d: d["parts"][0].update(target="z"),
            "renamed-file": lambda d: d["parts"][0].update(file="../part-0000.bin"),
        }
        for name, mutate in bad.items():
            with self.subTest(name):
                f = Fixture(os.environ.get("TEST_TMP")); self.f = f; f.make_plan()
                m = self.rewrite_manifest(mutate)
                rc, _o, err = inproc("validate", *f.m(m))
                self.assertEqual(rc, 3, (name, err))


class Paths(Base):
    def test_symlinked_target_or_ancestor_refused(self):
        link = self.f.d / "link-a"; link.symlink_to(self.f.ta)
        self.assertEqual(inproc(*self.f.plan_args(ta=link))[0], 3)
        real = self.f.d / "realparent"; (real / "t").mkdir(parents=True, mode=0o700)
        alias = self.f.d / "aliasparent"; alias.symlink_to(real)
        self.assertEqual(inproc(*self.f.plan_args(ta=alias / "t", out=self.f.d / "m2.json"))[0], 3)

    def test_part_replaced_by_symlink_and_foreign_files_untouched(self):
        msha = self.f.make_plan()
        self.assertEqual(cli("copy", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 0)
        outside = self.f.d / "outside.bin"; outside.write_bytes(self.f.parts()[0].read_bytes())
        os.unlink(self.f.parts()[0]); os.symlink(outside, self.f.parts()[0])
        self.assertEqual(cli("verify", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 4)
        self.assertEqual(cli("copy", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 4)
        self.assertTrue(self.f.parts()[0].is_symlink()); self.assertEqual(outside.read_bytes(), self.f.src.read_bytes()[:PART])
        # a non-empty target directory that is not ours is refused and left alone
        f = Fixture(os.environ.get("TEST_TMP")); m = f.make_plan()
        (f.tb / "unrelated.txt").write_text("keep me")
        self.assertEqual(cli("copy", *f.m(m), "--source-file", str(f.src)).returncode, 3)
        self.assertEqual(sorted(os.listdir(f.tb)), ["unrelated.txt"]); self.assertEqual((f.tb / "unrelated.txt").read_text(), "keep me")


class Admission(Base):
    def test_wrong_filesystem_capacity_and_memory_floors_refused(self):
        self.f.make_plan()
        m = self.rewrite_manifest(lambda d: d["targets"]["a"].update(majmin="1:99"))
        r = cli("copy", *self.f.m(m), "--source-file", str(self.f.src)); self.assertEqual(r.returncode, 3); self.assertIn("filesystem", r.stderr)
        for name, extra in (("capacity", ["--floor-bytes", str(1 << 60)]), ("memory", ["--host-mem-floor", str(1 << 60)])):
            with self.subTest(name):
                f = Fixture(os.environ.get("TEST_TMP")); mm = f.make_plan(*extra)
                r = cli("copy", *f.m(mm), "--source-file", str(f.src))
                self.assertEqual(r.returncode, 3, r.stderr); self.assertEqual(os.listdir(f.ta), [])

    def test_concurrency_one_per_target(self):
        msha = self.f.make_plan()
        self.assertEqual(cli("copy", *self.f.m(msha), "--source-file", str(self.f.src), "--max-bytes", "8192").returncode, 5)
        import fcntl
        fd = os.open(self.f.ta / MP.MARKER, os.O_RDONLY); fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            self.assertEqual(cli("copy", *self.f.m(msha), "--source-file", str(self.f.src)).returncode, 3)
        finally:
            os.close(fd)

    def test_production_pins_and_layout(self):
        self.assertEqual((PROD_PARTS := -(-MP.PROD["logicalSize"] // MP.PROD["partSize"])), 265)
        self.assertEqual(120 * MP.PROD["partSize"], 515396075520)                   # the owner's split, by hand
        self.assertEqual(MP.PROD["logicalSize"] - 120 * MP.PROD["partSize"], 622770257920)
        self.assertEqual(MP.PROD["assign"], {"root": [0, 119], "vm": [120, PROD_PARTS - 1]})
        rc, _o, err = inproc(*self.f.plan_args("--production"))                     # fixture inputs are not the pinned ones
        self.assertEqual(rc, 3, err)
        self.f.make_plan()
        m = self.rewrite_manifest(lambda d: d.update(kind="production"))
        self.assertEqual(inproc("validate", *self.f.m(m))[0], 3)
        self.assertEqual(cli("copy", *self.f.m(m), "--source-file", str(self.f.src)).returncode, 3)


class Devices(unittest.TestCase):
    def test_usb_detection_on_a_synthetic_sysfs(self):
        s = Path(tempfile.mkdtemp(prefix="sys", dir=os.environ.get("TEST_TMP")))
        dev = s / "devices"
        usb = dev / "pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host6/target6:0:0/6:0:0:0/block/sdb"
        nvme = dev / "pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1"
        dm_usb, dm_nvme = dev / "virtual/block/dm-5", dev / "virtual/block/dm-0"
        for p in (usb, nvme, dm_usb / "slaves", dm_nvme / "slaves"):
            p.mkdir(parents=True)
        (usb / "dev").write_text("8:16\n"); (nvme / "dev").write_text("259:0\n")
        (dm_usb / "slaves" / "sdb").symlink_to(usb); (dm_nvme / "slaves" / "nvme0n1").symlink_to(nvme)
        (s / "dev/block").mkdir(parents=True)
        for mm, target in (("8:16", usb), ("259:0", nvme), ("253:5", dm_usb), ("253:0", dm_nvme)):
            (s / "dev/block" / mm).symlink_to(target)
        self.assertEqual([MP.is_usb(mm, str(s)) for mm in ("8:16", "259:0", "253:5", "253:0")], [True, False, True, False])
        with self.assertRaises(MP.Refuse):
            MP.is_usb("9:9", str(s))                                                  # unknown device: fail closed

    def test_findmnt_uuid_parser_fail_closed(self):
        self.assertEqual(MP.parse_uuid_majmin("1c7c5336-9d52-4858-828a-823c31189c59 253:0  \n"), ("1c7c5336-9d52-4858-828a-823c31189c59", "253:0"))
        for bad in ("", "1c7c5336-9d52-4858-828a-823c31189c59\n", "u 253:0 extra\n", "a 253:0\nb 253:1\n", "UPPER 253:0\n"):
            with self.subTest(bad=bad), self.assertRaises(MP.Refuse):
                MP.parse_uuid_majmin(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
