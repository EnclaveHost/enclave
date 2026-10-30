#!/usr/bin/env python3
"""Unit fixtures for jobs/root-multipart-batches-1764.py (PREPARED by Claude 1764; NOT run by Claude). Tiny synthetic target dirs
under $MULTIPART_BATCH_TEST_TMP with records written in the frozen r3 schema (part/v2, verify/v2, session/v2); no original, no session,
no queue, no wrapper. 9 tests: batch plan, fresh copy admission (prefix verified; partial / foreign / stale refused), previous parts
need a CONFIRMED fresh PASS, exact remaining reservation + floors, verify admission, post-copy and post-verify new-session checks,
signal target = only our own pidfd-pinned orchestrate descendant, one-view-at-a-time busy detection."""
import hashlib, importlib.util, json, os, signal, subprocess, sys, tempfile, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("batches1764", HERE / "root-multipart-batches-1764.py")
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)   # verifies the frozen r3 SUMS before importing its core
MP = R.MP
BASE = os.environ["MULTIPART_BATCH_TEST_TMP"]
PLEN, MSHA, FLOOR = 8192, "a" * 64, 1000


class Fx:
    def __init__(self):
        self.base = Path(tempfile.mkdtemp(prefix="b", dir=BASE))
        self.dirs = {"root": self.base / "root", "vm": self.base / "vm"}
        for p in self.dirs.values():
            p.mkdir(mode=0o700); (p / MP.MARKER).write_text("{}")
        self.d = {"kind": "production", "targets": {n: {"dir": str(p), "majmin": MP.majmin(os.stat(p).st_dev), "uuid": "x", "floorBytes": FLOOR}
                                                     for n, p in self.dirs.items()},
                  "parts": [{"index": i, "offset": i * PLEN, "length": PLEN, "target": "root" if i < 3 else "vm", "file": f"part-{i:04d}.bin",
                             "holes": [], "dataBytes": PLEN} for i in range(6)]}
        self.n = 0

    def dir(self, i):
        return self.dirs[self.d["parts"][i]["target"]]

    def session(self, sid, status="CONFIRMED"):
        b = {"kind": "session", "sessionId": sid}
        for p in self.dirs.values():
            (p / f"session-{sid}.json").write_text(json.dumps({"format": MP.FMT["session"], "sessionId": sid, "status": status, "binding": b}))
        return b

    def commit(self, i, sid):
        p, d = self.d["parts"][i], self.dir(i)
        data = hashlib.sha256(b"%d" % i).digest() * (PLEN // 32)
        (d / p["file"]).write_bytes(data); os.chmod(d / p["file"], 0o600)
        st = os.lstat(d / p["file"])
        rec = {"format": MP.FMT["part"], "manifestSha256": MSHA, "index": i, "offset": p["offset"], "length": PLEN, "file": p["file"],
               "logicalSha256": hashlib.sha256(data).hexdigest(), "fileSize": PLEN, "originalIdentity": {}, "destIdentity": MP.dident(st),
               "source": {"kind": "session", "sessionId": sid}, "committedAtNs": time.time_ns()}
        (d / f"part-{i:04d}.json").write_text(json.dumps(rec))
        return rec

    def verify(self, i, sid, status="PASS"):
        d = self.dir(i); rec = json.loads((d / f"part-{i:04d}.json").read_text())
        self.n += 1; run = f"20261027T0000{self.n:02d}Z-1"
        h = rec["logicalSha256"]
        v = {"format": MP.FMT["verify"], "manifestSha256": MSHA, "index": i, "status": status, "reason": None, "sourceSha256": h,
             "destinationSha256": h, "recordSha256": h, "run": run, "destIdentity": rec["destIdentity"], "source": {"kind": "session", "sessionId": sid},
             "measuredAtNs": rec["committedAtNs"] + 1, "method": "fixture"}
        (d / f"part-{i:04d}.verify-{run}.json").write_text(json.dumps(v))

    def admit(self, lo, hi, mode, free=None):
        return R.admit(self.d, MSHA, lo, hi, mode, free=free or (lambda fd: 1 << 60), check_uuid=False)

    def post(self, lo, hi, mode, adm):
        return R.post_check(self.d, MSHA, lo, hi, mode, adm, check_uuid=False)


S1, S2, S3, S4, S5 = (f"20261027T00{m:02d}00Z-{m}" for m in (1, 2, 3, 4, 5))


def part0_done(f):
    f.session(S1); f.session(S2); f.commit(0, S1); f.verify(0, S2)


class Batches(unittest.TestCase):
    def assertCode(self, code, fn, *a, **kw):
        with self.assertRaises(SystemExit) as cm:
            fn(*a, **kw)
        self.assertEqual(cm.exception.code, code)

    def test_batch_plan_covers_1_to_264_in_at_most_8(self):
        b = R.batches()
        self.assertEqual((len(b), b[0], b[-1]), (33, (1, 8), (257, 264)))
        self.assertEqual([i for lo, hi in b for i in range(lo, hi + 1)], list(range(1, 265)))
        self.assertEqual(R.batches(1, 20), [(1, 8), (9, 16), (17, 20)]); self.assertEqual(R.batches(9, 9), [(9, 9)])
        for bad in ((0, 8), (1, 265), (9, 8)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                R.batches(*bad)

    def test_fresh_copy_admission_accepts_a_verified_prefix_and_refuses_partial_foreign_stale(self):
        f = Fx(); part0_done(f)
        adm = f.admit(1, 2, "copy")
        self.assertEqual(sorted(adm["sessionsBefore"]["root"]), sorted([S1, S2]))
        for name, make, undo in (("partial", lambda: (f.dirs["root"] / "part-0002.bin.partial").write_bytes(b"x"),
                                  lambda: os.unlink(f.dirs["root"] / "part-0002.bin.partial")),
                                 ("later part", lambda: (f.dirs["vm"] / "part-0005.json").write_text("{}"), lambda: os.unlink(f.dirs["vm"] / "part-0005.json")),
                                 ("foreign", lambda: (f.dirs["vm"] / "notes.txt").write_text("x"), lambda: os.unlink(f.dirs["vm"] / "notes.txt"))):
            with self.subTest(name):
                make(); self.assertCode(3, f.admit, 1, 2, "copy"); undo()
        f.admit(1, 2, "copy")
        os.utime(f.dirs["root"] / "part-0000.bin", None)                            # stale: identity changed after the PASS
        self.assertCode(3, f.admit, 1, 2, "copy")

    def test_previous_parts_need_a_confirmed_fresh_pass_not_a_saved_hash(self):
        for name, setup in (("no verify", lambda f: (f.session(S1), f.commit(0, S1))),
                            ("unconfirmed verify session", lambda f: (f.session(S1), f.session(S2, "UNCONFIRMED"), f.commit(0, S1), f.verify(0, S2))),
                            ("FAIL record", lambda f: (f.session(S1), f.session(S2), f.commit(0, S1), f.verify(0, S2), f.verify(0, S2, "FAIL")))):
            with self.subTest(name):
                f = Fx(); setup(f); self.assertCode(3, f.admit, 1, 2, "copy")

    def test_reservation_is_the_exact_remaining_logical_bytes_plus_floor_plus_root_extra(self):
        f = Fx(); part0_done(f)
        ino = {os.stat(p).st_ino: n for n, p in f.dirs.items()}
        need = {"root": 2 * PLEN + FLOOR + (8 << 30), "vm": 3 * PLEN + FLOOR}      # part 0 committed: 2 root + 3 vm parts remain
        adm = f.admit(1, 2, "copy", free=lambda fd: need[ino[os.fstat(fd).st_ino]])
        self.assertEqual({n: (c["remainingLogicalBytes"], c["neededBytes"], c["marginBytes"]) for n, c in adm["capacity"].items()},
                         {"root": (2 * PLEN, need["root"], 0), "vm": (3 * PLEN, need["vm"], 0)})
        for short in ("root", "vm"):
            with self.subTest(short=short):
                self.assertCode(3, f.admit, 1, 2, "copy", free=lambda fd, s=short: need[ino[os.fstat(fd).st_ino]] - (ino[os.fstat(fd).st_ino] == s))

    def test_verify_admission_needs_the_batch_committed_confirmed_and_unverified(self):
        f = Fx(); part0_done(f); f.session(S3); f.commit(1, S3); f.commit(2, S3)
        f.admit(1, 2, "verify")
        f.verify(1, S3); self.assertCode(3, f.admit, 1, 2, "verify")                 # already has a verify record
        f2 = Fx(); part0_done(f2); f2.session(S3); f2.session(S4, "UNCONFIRMED"); f2.commit(1, S3); f2.commit(2, S4)
        self.assertCode(3, f2.admit, 1, 2, "verify")                                 # part 2 copied in an UNCONFIRMED session
        f3 = Fx(); part0_done(f3); f3.session(S3); f3.commit(1, S3)
        self.assertCode(3, f3.admit, 1, 2, "verify")                                 # part 2 not committed

    def test_post_copy_needs_one_new_confirmed_session_for_the_whole_range(self):
        f = Fx(); part0_done(f); adm = f.admit(1, 2, "copy")
        f.session(S3); f.commit(1, S3); f.commit(2, S3)
        self.assertEqual(f.post(1, 2, "copy", adm)["newSession"], S3)
        g = Fx(); part0_done(g); adm = g.admit(1, 2, "copy"); g.commit(1, S1); g.commit(2, S1)
        self.assertCode(4, g.post, 1, 2, "copy", adm)                                # an OLD session
        h = Fx(); part0_done(h); adm = h.admit(1, 2, "copy"); h.session(S3); h.session(S4); h.commit(1, S3); h.commit(2, S4)
        self.assertCode(4, h.post, 1, 2, "copy", adm)                                # two sessions
        k = Fx(); part0_done(k); adm = k.admit(1, 2, "copy"); k.session(S3); k.commit(1, S3); k.commit(2, S3); k.commit(3, S3)
        self.assertCode(4, k.post, 1, 2, "copy", adm)                                # a part outside the batch was written

    def test_post_verify_needs_a_new_session_distinct_from_the_copy_session(self):
        def prepared():
            f = Fx(); part0_done(f); f.session(S3); f.commit(1, S3); f.commit(2, S3)
            return f, f.admit(1, 2, "verify")
        f, adm = prepared(); f.session(S5); f.verify(1, S5); f.verify(2, S5)
        out = f.post(1, 2, "verify", adm)
        self.assertEqual((out["newSession"], out["status"]["partsVerifiedRecorded"]), (S5, 3))
        f, adm = prepared(); f.verify(1, S3); f.verify(2, S3)
        self.assertCode(4, f.post, 1, 2, "verify", adm)                              # verified by the copy session itself
        f, adm = prepared(); f.verify(1, S2); f.verify(2, S2)
        self.assertCode(4, f.post, 1, 2, "verify", adm)                              # an old session

    def test_signal_target_is_only_our_own_pidfd_pinned_orchestrate(self):
        argv = [sys.executable, "-c", "import time; time.sleep(60)", str(R.STAGE / "orchestrate.py"), "run"]
        mine = subprocess.Popen(["bash", "-c", '"$@" & wait', "bash", *argv])          # our child -> its background grandchild
        other = subprocess.Popen(argv)                                                 # the same cmdline, NOT under `mine`
        pid = None
        try:
            hit = None
            for _ in range(100):
                hit = R.find_descendant(mine.pid, R.is_orchestrate)
                if hit:
                    break
                time.sleep(0.05)
            self.assertIsNotNone(hit)
            fd, pid = hit; os.close(fd)
            self.assertNotEqual(pid, other.pid); self.assertIn(pid, R.descendants(mine.pid))
            self.assertIsNone(R.find_descendant(os.getpid(), R.is_orchestrate))     # two candidates under us: ambiguous, refused
        finally:
            if pid is not None:
                with __import__("contextlib").suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGKILL)                                     # the grandchild first (never orphaned)
            for p in (other, mine):
                p.kill(); p.wait()

    def test_one_view_at_a_time(self):
        mi = "36 25 0:44 / /x/recovery-multipart-stage/r3/runs/prod-copy-1/session/work/mnt ro - fuse.fuse2fs /x/nbd ro\n" \
             "37 25 0:45 / /srv/peer/base-files ro - fuse /dev/nbd0 ro\n"
        procs = [(10, ["/usr/bin/python3", "-I", "-B", "/r/recovery-overlay-stage/r9/overlay_session.py"]), (11, ["/usr/bin/python3", "x.py"]),
                 (12, ["/usr/bin/python3", "-I", "-B", "/s/orchestrate.py", "run"])]
        why = R.busy_reasons(mi, procs, me=11)
        self.assertEqual(len(why), 3); self.assertIn("/recovery-multipart-stage/", why[0])
        self.assertEqual(R.busy_reasons("37 25 0:45 / /srv/peer/base-files ro - fuse /dev/nbd0 ro\n", [(11, ["python3"])], me=11), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
