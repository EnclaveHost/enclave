#!/usr/bin/env python3
"""recovery-multipart-stage/r2 UNIT tests (PREPARED by Claude 1748; root runs them via jobs/tests.sh; NOT run by Claude).
Tiny fixtures (< 1 MiB) under $MULTIPART_TEST_TMP (stage-specific; TEST_TMP / TMPDIR / HOME are never repurposed): a 50-block source
with data extents and map holes (part 0 has a hole at 40960..49152; part 2 ends in the sparse tail; part 3 is all hole) and two
target directories. Expected results come from the fixture bytes (direct reads, an independent hashlib sha256), never from the tool.
The copier and the server run as REAL subprocesses where exit codes, signals or RLIMIT_FSIZE matter. The r9-session end-to-end
tests are separate (tests/test_e2e.py, jobs/e2e-tests.sh: they need FUSE and the pinned r9 tools)."""
import contextlib, fcntl, hashlib, io, json, os, resource, signal, socket, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = str(HERE.parent / "multipart.py")
sys.path.insert(0, str(HERE.parent)); sys.dont_write_bytecode = True
import multipart as MP  # noqa: E402
import orchestrate as O  # noqa: E402

BS = 4096
EXTENTS = [[0, 10, 900, False], [12, 19, 950, False], [33, 8, 990, False]]   # holes: blocks 10-11, 31-32, 41-49 (tail)
NBLK = 50
L = NBLK * BS                                                                   # 204800 = 3 x 65536 + 8192
PART = 65536
BASE = os.environ["MULTIPART_TEST_TMP"]


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


def status(f, msha):
    r = cli("status", *f.m(msha)); assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


class Fixture:
    def __init__(self):
        self.d = Path(tempfile.mkdtemp(prefix="mp", dir=BASE))
        self.src = self.d / "source.img"
        with open(self.src, "wb") as f:
            f.truncate(L)
            for lb, n, _pb, _u in EXTENTS:
                f.seek(lb * BS); f.write(det_bytes(f"data{lb}", n * BS))
        self.map = self.d / "map.json"
        self.map.write_text(json.dumps({"format": "ext4-recovery-checksum-r1/v1", "map": {"extentList": EXTENTS, "extents": len(EXTENTS)}}))
        self.journal = self.d / "journal.bin"; self.journal.write_bytes(det_bytes("journal", 65536))
        self.original = self.d / "original.qcow2"; self.original.write_bytes(det_bytes("qcow2", 12345))
        self.plan = self.d / "plan.json"; self.write_plan()
        self.ta, self.tb = self.d / "target-a", self.d / "target-b"
        for t in (self.ta, self.tb):
            t.mkdir(mode=0o700)
        self.sockdir = self.d / "sock"; self.sockdir.mkdir(mode=0o700)
        self.manifest = self.d / "manifest.json"

    def write_plan(self, patches=None):
        self.plan.write_text(json.dumps({"format": "recovery-overlay-plan/v1", "mode": "fixture",
                                         "inputs": {"captureSha256": "00" * 32},
                                         "target": {"size": L, "path": "/data/db/mdbx.dat"}, "map": {"extents": len(EXTENTS)},
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

    def copy(self, msha, *extra, **kw):
        return cli("copy", *self.m(msha), "--source-file", str(self.src), *extra, **kw)

    def verify(self, msha, *extra):
        return cli("verify", *self.m(msha), "--source-file", str(self.src), *extra)


def serve_fake(sockdir, data, stall_after=None, hung=None):
    """the test plays a source server: connects via /proc/self/fd/N (under the 108-byte AF_UNIX limit)"""
    end = time.monotonic() + 60
    while not (sockdir / "mp.sock").exists() and time.monotonic() < end:
        time.sleep(0.02)
    dfd = os.open(sockdir, os.O_RDONLY | os.O_DIRECTORY)
    s = socket.socket(socket.AF_UNIX); s.connect(f"/proc/self/fd/{dfd}/mp.sock"); os.close(dfd)
    s.sendall((json.dumps({"proto": MP.FMT["proto"], "size": L, "sourceKind": "fixture-file"}) + "\n").encode())
    f, served = s.makefile("rb"), 0
    while True:
        line = f.readline()
        if not line or line == b"Q\n":
            break
        _r, off, n = line.split(); off, n = int(off), int(n)
        if stall_after is not None and served == stall_after:
            hung.set(); f.readline(); break
        s.sendall(f"D {off} {n}\n".encode() + data[off:off + n]); served += 1
    f.close(); s.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()

    def rewrite(self, path, mutate):
        d = json.loads(Path(path).read_text()); mutate(d)
        raw = (json.dumps(d, indent=1, sort_keys=True) + "\n").encode()
        os.chmod(path, 0o600); Path(path).write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()


# ---- r1 behaviour, kept ----------------------------------------------------------------------------------------------------------
class Positive(Base):
    def test_copy_two_targets_then_independent_verify_reassembles_the_source(self):
        msha = self.f.make_plan()
        doc = json.loads(self.f.manifest.read_text())
        self.assertEqual([(p["offset"], p["length"], p["target"]) for p in doc["parts"]],
                         [(0, PART, "a"), (PART, PART, "a"), (2 * PART, PART, "b"), (3 * PART, 8192, "b")])
        self.assertEqual(doc["source"]["holes"], [[40960, 8192], [126976, 8192], [167936, 36864]])
        r = self.f.copy(msha); self.assertEqual(r.returncode, 0, r.stderr)
        st = status(self.f, msha)
        self.assertEqual((st["copyComplete"], st["verificationCompleteRecorded"], st["freshlyMeasured"]), (True, False, False))
        for k in ("productionReady", "raidReset"):
            self.assertNotIn(k, st)
        r = self.f.verify(msha); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(json.loads(r.stdout)["freshlyMeasured"])
        st = status(self.f, msha)
        self.assertEqual((st["copyComplete"], st["verificationCompleteRecorded"], st["partsVerifiedRecorded"]), (True, True, 4))
        self.assertEqual(hashlib.sha256(self.f.reassembled()).hexdigest(), sha_path(self.f.src))
        self.assertEqual(self.f.parts()[3].read_bytes(), bytes(8192))
        self.assertEqual([p.stat().st_size for p in self.f.parts()], [PART, PART, PART, 8192])
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 and p.stat().st_nlink == 1 for p in self.f.parts()))
        rec = json.loads((self.f.ta / "part-0000.json").read_text())
        self.assertEqual(rec["source"]["kind"], "fixture-file")                       # never a production binding
        self.assertEqual(rec["destIdentity"]["ino"], self.f.parts()[0].stat().st_ino)

    def test_sigterm_mid_part_stops_cleanly_and_resumes(self):
        msha = self.f.make_plan()
        p = subprocess.Popen([sys.executable, "-I", "-B", TOOL, "copy", *self.f.m(msha), "--source-socket-dir", str(self.f.sockdir),
                              "--accept-timeout", "60"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        hang = threading.Event()
        t = threading.Thread(target=serve_fake, args=(self.f.sockdir, self.f.src.read_bytes(), 5, hang), daemon=True); t.start()
        self.assertTrue(hang.wait(60)); time.sleep(0.3); p.send_signal(signal.SIGTERM)
        _o, err = p.communicate(timeout=60); t.join(10)
        self.assertEqual(p.returncode, 5, err)
        ck = json.loads((self.f.ta / "part-0000.ckpt.json").read_text())
        self.assertGreaterEqual(ck["committedBytes"], 16384); self.assertFalse((self.f.ta / "part-0000.json").exists())
        self.assertEqual(os.listdir(self.f.sockdir), [])                               # our socket removed
        self.assertEqual(self.f.copy(msha).returncode, 0)
        self.assertEqual(self.f.verify(msha).returncode, 0)
        self.assertEqual(self.f.reassembled(), self.f.src.read_bytes())


class Sparse(Base):
    """P1 (review 1747): a checkpoint at, after or inside a map hole must resume"""
    def test_checkpoints_at_hole_boundaries_resume(self):
        for stop in (40960, 49152, 2 * PART + 36864, 2 * PART + 53248):      # hole start, just after a hole, tail-hole start, inside it
            with self.subTest(stop=stop):
                f = Fixture(); m = f.make_plan()
                r = f.copy(m, "--max-bytes", str(stop) if stop < PART else str(stop))
                self.assertEqual(r.returncode, 5, r.stderr)
                idx = stop // PART
                d = f.ta if idx < 2 else f.tb
                ck = json.loads((d / f"part-{idx:04d}.ckpt.json").read_text())
                rel = stop - idx * PART
                self.assertEqual(ck["committedBytes"], rel)
                self.assertEqual((d / f"part-{idx:04d}.bin.partial").stat().st_size, rel)      # extended sparsely to the checkpoint
                r = f.copy(m); self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(f.reassembled(), f.src.read_bytes())
                self.assertEqual(f.verify(m).returncode, 0)


class Integrity(Base):
    def copied(self):
        msha = self.f.make_plan()
        r = self.f.copy(msha); self.assertEqual(r.returncode, 0, r.stderr)
        return msha

    def test_corrupt_destination_detected_and_kept(self):
        msha = self.copied(); p = self.f.parts()[1]
        b = bytearray(p.read_bytes()); b[100] ^= 1
        with open(p, "r+b") as fh:                                                  # same inode, same size
            fh.write(bytes(b))
        bad = p.read_bytes()
        self.assertEqual(self.f.verify(msha).returncode, 4)
        self.assertEqual(self.f.copy(msha).returncode, 4)
        self.assertEqual(p.read_bytes(), bad)
        st = status(self.f, msha)
        self.assertIn(1, st["stale"]); self.assertFalse(st["copyComplete"])         # mtime/ctime changed: stale, not committed

    def test_verification_rereads_the_source_and_never_accepts_copy_hashes_alone(self):
        msha = self.copied()
        with open(self.f.src, "r+b") as fh:
            fh.seek(70000); fh.write(b"\x01")                                       # the source changed after the copy
        self.assertEqual(self.f.verify(msha).returncode, 4)
        self.assertEqual(cli("verify", *self.f.m(msha), "--source-file", str(self.f.d / "missing.img")).returncode, 3)
        self.assertFalse(status(self.f, msha)["verificationCompleteRecorded"])

    def test_truncated_part_refused_and_kept(self):
        msha = self.copied(); p = self.f.parts()[2]
        os.truncate(p, 4096)
        self.assertEqual(self.f.copy(msha).returncode, 4)
        self.assertEqual(self.f.verify(msha).returncode, 4)
        self.assertEqual(p.stat().st_size, 4096)
        self.assertFalse(status(self.f, msha)["copyComplete"])

    def test_nonzero_source_inside_a_map_hole_refused(self):
        msha = self.f.make_plan()
        with open(self.f.src, "r+b") as fh:
            fh.seek(41 * BS + 7); fh.write(b"\x09")
        r = self.f.copy(msha)
        self.assertEqual(r.returncode, 4); self.assertIn("map hole", r.stderr)
        self.assertFalse((self.f.tb / "part-0002.json").exists())

    def test_write_failure_then_resume(self):
        msha = self.f.make_plan()

        def cap():
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE, (20000, 20000))
        r = self.f.copy(msha, preexec=cap)
        self.assertEqual(r.returncode, 4, r.stderr); self.assertFalse((self.f.ta / "part-0000.json").exists())
        r = self.f.copy(msha); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.f.verify(msha).returncode, 0)
        self.assertEqual(self.f.reassembled(), self.f.src.read_bytes())


# ---- r2: P3 stale / historical vs fresh, P5 links and crash windows, P4 pre-pass ----------------------------------------------
class Records(Base):
    def verified(self):
        msha = self.f.make_plan()
        self.assertEqual(self.f.copy(msha).returncode, 0); self.assertEqual(self.f.verify(msha).returncode, 0)
        self.assertTrue(status(self.f, msha)["verificationCompleteRecorded"])
        return msha

    def test_replaced_or_touched_part_after_pass_is_stale_not_verified(self):
        msha = self.verified(); p = self.f.parts()[0]
        same = p.read_bytes(); os.unlink(p); p.write_bytes(same); os.chmod(p, 0o600)   # identical bytes, NEW inode
        st = status(self.f, msha)
        self.assertIn(0, st["stale"]); self.assertFalse(st["copyComplete"]); self.assertFalse(st["verificationCompleteRecorded"])
        f2 = Fixture(); m2 = f2.make_plan()
        self.assertEqual(f2.copy(m2).returncode, 0); self.assertEqual(f2.verify(m2).returncode, 0)
        os.utime(f2.parts()[2], None)                                                 # only the times change
        self.assertIn(2, status(f2, m2)["stale"])

    def test_malformed_or_forged_verify_records_never_count(self):
        msha = self.verified()
        (self.f.ta / "part-0000.verify-20261026T000000Z-1.json").write_text('{"format": "recovery-multipart-verify/v2"}')
        st = status(self.f, msha)
        self.assertIn(0, st["invalidRecords"]); self.assertFalse(st["verificationCompleteRecorded"])
        f2 = Fixture(); m2 = f2.make_plan(); self.assertEqual(f2.copy(m2).returncode, 0)
        rec = json.loads((f2.ta / "part-0001.json").read_text())
        forged = {"format": MP.FMT["verify"], "manifestSha256": m2, "index": 1, "status": "PASS", "reason": None, "sourceSha256": rec["logicalSha256"],
                  "destinationSha256": rec["logicalSha256"], "recordSha256": rec["logicalSha256"], "run": "20261026T000000Z-2",
                  "destIdentity": {**rec["destIdentity"], "ino": rec["destIdentity"]["ino"] + 1}, "source": rec["source"],
                  "measuredAtNs": rec["committedAtNs"] + 1, "method": "forged"}
        (f2.ta / "part-0001.verify-20261026T000000Z-2.json").write_text(json.dumps(forged))
        self.assertEqual(status(f2, m2)["partsVerifiedRecorded"], 0)                 # identity does not match the file
        out = json.loads(cli("status", *f2.m(m2)).stdout)
        self.assertIs(out["freshlyMeasured"], False)                                  # status never claims fresh evidence

    def test_external_hardlink_refused_everywhere_and_kept(self):
        msha = self.verified(); outside = self.f.d / "outside-link.bin"
        os.link(self.f.parts()[1], outside)
        st = status(self.f, msha)
        self.assertIn(1, st["stale"]); self.assertFalse(st["verificationCompleteRecorded"])
        self.assertEqual(self.f.copy(msha).returncode, 4)
        self.assertEqual(self.f.verify(msha).returncode, 4)
        self.assertEqual(os.stat(outside).st_nlink, 2)                               # nothing unlinked

    def test_crash_windows_link_before_unlink_and_record(self):
        msha = self.f.make_plan(); self.assertEqual(self.f.copy(msha).returncode, 0)
        a = self.f.ta
        # (1) crash after link(.partial -> part) and BEFORE unlink(.partial) and the record (one critical section in the real flow):
        #     no record yet, a SAME-inode .partial: dropped, then adopted after a full source re-read
        os.unlink(a / "part-0000.json"); os.link(a / "part-0000.bin", a / "part-0000.bin.partial")
        # (2) crash after the unlink but before the record was linked (a stale record temp left behind): adopted
        os.unlink(a / "part-0001.json"); (a / "part-0001.json.tmp").write_text("{"); os.chmod(a / "part-0001.json.tmp", 0o600)
        r = self.f.copy(msha); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["copied"], [{"index": 0, "state": "adopted"}, {"index": 1, "state": "adopted"},
                                                          {"index": 2, "state": "present"}, {"index": 3, "state": "present"}])
        self.assertEqual(os.stat(a / "part-0000.bin").st_nlink, 1)
        self.assertFalse((a / "part-0000.bin.partial").exists()); self.assertFalse((a / "part-0001.bin.partial").exists())
        self.assertFalse((a / "part-0001.json.tmp").exists())
        self.assertEqual(self.f.verify(msha).returncode, 0)
        self.assertEqual(self.f.reassembled(), self.f.src.read_bytes())
        # (3) a .partial of a DIFFERENT inode next to a committed part: refused, both kept
        (self.f.tb / "part-0002.bin.partial").write_bytes(b"other"); os.chmod(self.f.tb / "part-0002.bin.partial", 0o600)
        self.assertEqual(self.f.copy(msha).returncode, 4)
        self.assertEqual((self.f.tb / "part-0002.bin.partial").read_bytes(), b"other")

    def test_rehash_prepass_runs_before_the_source_is_opened(self):
        msha = self.f.make_plan(); self.assertEqual(self.f.copy(msha).returncode, 0)
        # every part committed: a resume re-hashes them all and needs NO source at all (no socket is ever created)
        r = cli("copy", *self.f.m(msha), "--source-socket-dir", str(self.f.sockdir), "--accept-timeout", "2")
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(os.listdir(self.f.sockdir), [])
        # one part missing: the pre-pass (parts 0..2 re-hashed) completes before the socket appears
        f2 = Fixture(); m2 = f2.make_plan(); self.assertEqual(f2.copy(m2, "--parts", "0-2").returncode, 0)
        p = subprocess.Popen([sys.executable, "-I", "-B", TOOL, "copy", *f2.m(m2), "--source-socket-dir", str(f2.sockdir), "--accept-timeout", "60"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        serve_fake(f2.sockdir, f2.src.read_bytes())
        _o, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 0, err); self.assertEqual(f2.reassembled(), f2.src.read_bytes())

    def test_cancel_while_waiting_for_the_source_removes_our_socket(self):
        msha = self.f.make_plan()
        p = subprocess.Popen([sys.executable, "-I", "-B", TOOL, "copy", *self.f.m(msha), "--source-socket-dir", str(self.f.sockdir),
                              "--accept-timeout", "60"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        end = time.monotonic() + 60
        while not (self.f.sockdir / "mp.sock").exists() and time.monotonic() < end:
            time.sleep(0.02)
        p.send_signal(signal.SIGTERM); _o, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 5, err); self.assertEqual(os.listdir(self.f.sockdir), [])
        # a pre-existing socket name that is NOT ours is refused and left alone
        (self.f.sockdir / "mp.sock").write_text("not ours")
        r = cli("copy", *self.f.m(msha), "--source-socket-dir", str(self.f.sockdir), "--accept-timeout", "2")
        self.assertEqual(r.returncode, 3); self.assertEqual((self.f.sockdir / "mp.sock").read_text(), "not ours")


class Integration(Base):
    def test_server_under_the_sessions_fsize_cap_feeds_parts_larger_than_the_cap(self):
        msha = self.f.make_plan()
        lim = lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (16384, 16384))
        for verb in ("copy", "verify"):
            c = subprocess.Popen([sys.executable, "-I", "-B", TOOL, verb, *self.f.m(msha), "--source-socket-dir", str(self.f.sockdir),
                                  "--accept-timeout", "60"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
            end = time.monotonic() + 60
            while not (self.f.sockdir / "mp.sock").exists() and time.monotonic() < end:
                time.sleep(0.02)
            s = cli("serve", "--socket-dir", str(self.f.sockdir), "--expect-size", str(L), preexec=lim,
                    env={"PATH": "/usr/bin:/bin", "RECOVERY_TARGET": str(self.f.src)})
            _o, err = c.communicate(timeout=60)
            self.assertEqual((c.returncode, s.returncode), (0, 0), (verb, err, s.stderr))
        self.assertEqual(self.f.reassembled(), self.f.src.read_bytes())
        f2 = Fixture(); m2 = f2.make_plan()

        def cap():
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE, (16384, 16384))
        self.assertEqual(f2.copy(m2, preexec=cap).returncode, 4)

    def test_serve_session_mode_refuses_source_wrong_target_and_writable_mounts(self):
        srun = self.f.d / "session"; (srun / "work/mnt/data/db").mkdir(parents=True, mode=0o700)
        tgt = srun / "work/mnt/data/db/mdbx.dat"; tgt.write_bytes(self.f.src.read_bytes())
        base = ["serve", "--socket-dir", str(self.f.sockdir), "--expect-size", str(L), "--session-run-dir", str(srun)]
        env = lambda t: {"PATH": "/usr/bin:/bin", "RECOVERY_TARGET": str(t)}
        r = cli(*base, "--source", str(self.f.src), env=env(tgt)); self.assertEqual(r.returncode, 3); self.assertIn("--source", r.stderr)
        r = cli(*base, env=env(self.f.src)); self.assertEqual(r.returncode, 3); self.assertIn("not exactly", r.stderr)
        r = cli(*base, env=env(tgt)); self.assertEqual(r.returncode, 3); self.assertIn("ST_RDONLY", r.stderr)   # a writable fs
        self.assertEqual(os.listdir(self.f.sockdir), [])


class Bindings(Base):
    def test_changed_original_map_plan_patches_journal_or_manifest_refused(self):
        cases = [("map", lambda f: f.map.write_text(f.map.read_text() + " ")),
                 ("journal", lambda f: f.journal.write_bytes(det_bytes("journal2", 65536))),
                 ("patch", lambda f: f.write_plan([{"kind": "inode", "fsBlock": 7, "byteOffset": 1024, "length": 256, "sha256": "ef" * 32, "source": "000.bin"}])),
                 ("original", lambda f: os.utime(f.original, ns=(1, 1)))]
        for name, mutate in cases:
            with self.subTest(name):
                f = Fixture(); m = f.make_plan(); mutate(f)
                r = f.copy(m); self.assertEqual(r.returncode, 3, r.stderr); self.assertEqual(os.listdir(f.ta), [])
        f = Fixture(); m = f.make_plan()
        os.chmod(f.manifest, 0o600); f.manifest.write_text(f.manifest.read_text().replace('"part-0001.bin"', '"part-0001.bin" '))
        self.assertEqual(f.copy(m).returncode, 3)

    def test_manifest_coverage_gaps_overlaps_duplicates_and_holes(self):
        bad = {"gap": lambda d: d["parts"][1].update(offset=PART + 4096), "overlap": lambda d: d["parts"][2].update(offset=2 * PART - 4096),
               "duplicate": lambda d: d["parts"].insert(1, dict(d["parts"][0])), "missing-last": lambda d: d["parts"].pop(),
               "short-middle": lambda d: d["parts"][1].update(length=PART - 4096), "hole-dropped": lambda d: d["parts"][3].update(holes=[]),
               "global-hole-moved": lambda d: d["source"]["holes"][0].__setitem__(0, 45056), "extra-key": lambda d: d.update(productionReady=True),
               "unknown-target": lambda d: d["parts"][0].update(target="z"), "renamed-file": lambda d: d["parts"][0].update(file="../part-0000.bin")}
        for name, mutate in bad.items():
            with self.subTest(name):
                f = Fixture(); f.make_plan(); m = self.rewrite(f.manifest, mutate)
                self.assertEqual(inproc("validate", *f.m(m))[0], 3, name)


class Paths(Base):
    def test_symlinked_target_or_ancestor_refused(self):
        link = self.f.d / "link-a"; link.symlink_to(self.f.ta)
        self.assertEqual(inproc(*self.f.plan_args(ta=link))[0], 3)
        real = self.f.d / "realparent"; (real / "t").mkdir(parents=True, mode=0o700)
        alias = self.f.d / "aliasparent"; alias.symlink_to(real)
        self.assertEqual(inproc(*self.f.plan_args(ta=alias / "t", out=self.f.d / "m2.json"))[0], 3)

    def test_part_replaced_by_symlink_and_foreign_files_untouched(self):
        msha = self.f.make_plan(); self.assertEqual(self.f.copy(msha).returncode, 0)
        outside = self.f.d / "outside.bin"; outside.write_bytes(self.f.parts()[0].read_bytes())
        os.unlink(self.f.parts()[0]); os.symlink(outside, self.f.parts()[0])
        self.assertEqual(self.f.verify(msha).returncode, 4); self.assertEqual(self.f.copy(msha).returncode, 4)
        self.assertTrue(self.f.parts()[0].is_symlink()); self.assertEqual(outside.read_bytes(), self.f.src.read_bytes()[:PART])
        f = Fixture(); m = f.make_plan(); (f.tb / "unrelated.txt").write_text("keep me")
        self.assertEqual(f.copy(m).returncode, 3)
        self.assertEqual(sorted(os.listdir(f.tb)), ["unrelated.txt"]); self.assertEqual(os.listdir(f.ta), [])   # nothing created anywhere


class Admission(Base):
    def test_wrong_filesystem_capacity_and_memory_floors_refused_on_copy_and_verify(self):
        self.f.make_plan()
        m = self.rewrite(self.f.manifest, lambda d: d["targets"]["a"].update(majmin="1:99"))
        r = self.f.copy(m); self.assertEqual(r.returncode, 3); self.assertIn("filesystem", r.stderr)
        for name, extra in (("capacity", ["--floor-bytes", str(1 << 60)]), ("memory", ["--host-mem-floor", str(1 << 60)])):
            with self.subTest(name):
                f = Fixture(); mm = f.make_plan(*extra)
                r = f.copy(mm); self.assertEqual(r.returncode, 3, r.stderr); self.assertEqual(os.listdir(f.ta), [])
        f = Fixture(); mm = f.make_plan("--host-mem-floor", str(1 << 60))
        r = f.verify(mm); self.assertEqual(r.returncode, 3); self.assertIn("MemAvailable", r.stderr)          # the read path too

    def test_concurrency_one_per_target(self):
        msha = self.f.make_plan()
        self.assertEqual(self.f.copy(msha, "--max-bytes", "8192").returncode, 5)
        fd = os.open(self.f.ta / MP.MARKER, os.O_RDONLY); fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            self.assertEqual(self.f.copy(msha).returncode, 3)
        finally:
            os.close(fd)

    def test_production_pins_layout_and_fixture_paths_refused(self):
        self.assertEqual(-(-MP.PROD["logicalSize"] // MP.PROD["partSize"]), 265)
        self.assertEqual(120 * MP.PROD["partSize"], 515396075520)
        self.assertEqual(MP.PROD["logicalSize"] - 120 * MP.PROD["partSize"], 622770257920)
        self.assertEqual(inproc(*self.f.plan_args("--production"))[0], 3)
        self.f.make_plan()
        m = self.rewrite(self.f.manifest, lambda d: d.update(kind="production"))
        self.assertEqual(inproc("validate", *self.f.m(m))[0], 3)
        self.assertEqual(self.f.copy(m).returncode, 3)


class Request(unittest.TestCase):
    def test_preservation_request_is_purpose_bound_and_exact(self):
        good = {"format": O.REQ_FORMAT, "purpose": O.PURPOSE, "kind": "fixture", "mode": "copy", "recoveryAccepted": False,
                "productionUse": False, "raidReset": False, "manifestSha256": "1" * 64, "planSha256": "2" * 64, "parentPath": "/p",
                "multipartSha256": "3" * 64, "orchestrateSha256": "4" * 64, "overlaySessionSha256": "5" * 64}
        args = ("fixture", "copy", "1" * 64, "2" * 64, "/p", "3" * 64, "4" * 64, "5" * 64)
        self.assertEqual(O.validate_request(dict(good), *args), good)
        bad = [dict(good, recoveryAccepted=True), dict(good, raidReset=0), dict(good, productionUse=None), dict(good, purpose="full-readonly-mdbx-validation"),
               dict(good, kind="production"), dict(good, mode="verify"), dict(good, planSha256="9" * 64), dict(good, parentPath="/other"),
               dict(good, multipartSha256="0" * 64), dict(good, extra=1), {k: v for k, v in good.items() if k != "raidReset"}]
        for i, r in enumerate(bad):
            with self.subTest(i=i), self.assertRaises(MP.Refuse):
                O.validate_request(r, *args)


class Devices(unittest.TestCase):
    def test_usb_detection_on_a_synthetic_sysfs(self):
        s = Path(tempfile.mkdtemp(prefix="sys", dir=BASE)); dev = s / "devices"
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
            MP.is_usb("9:9", str(s))

    def test_findmnt_uuid_parser_fail_closed(self):
        self.assertEqual(MP.parse_uuid_majmin("1c7c5336-9d52-4858-828a-823c31189c59 253:0  \n"), ("1c7c5336-9d52-4858-828a-823c31189c59", "253:0"))
        for bad in ("", "1c7c5336-9d52-4858-828a-823c31189c59\n", "u 253:0 extra\n", "a 253:0\nb 253:1\n", "UPPER 253:0\n"):
            with self.subTest(bad=bad), self.assertRaises(MP.Refuse):
                MP.parse_uuid_majmin(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
