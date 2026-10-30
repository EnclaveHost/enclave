#!/usr/bin/env python3
"""Unit fixtures for jobs/root-multipart-batches-1773.py (PREPARED by Claude 1764/1773; NOT run by Claude). 14 tests (1764's 9 + 5). Tiny synthetic target dirs
under $MULTIPART_BATCH_TEST_TMP with records written in the frozen r3 schema (part/v2, verify/v2, session/v2); no original, no session,
no queue, no wrapper. 9 tests: batch plan, fresh copy admission (prefix verified; partial / foreign / stale refused), previous parts
need a CONFIRMED fresh PASS, exact remaining reservation + floors, verify admission, post-copy and post-verify new-session checks,
signal target = only our own pidfd-pinned orchestrate descendant, one-view-at-a-time busy detection."""
import hashlib, importlib.util, json, os, signal, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("batches1773", HERE / "root-multipart-batches-1773.py")
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
            alias = Path(tempfile.mkdtemp(prefix="al", dir=BASE)) / "stage"; alias.symlink_to(R.STAGE)
            self.assertTrue(R.is_orchestrate([argv[0], "-I", "-B", str(alias / "orchestrate.py"), "run"]))        # 1772 P3-2: realpath
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


    # ---- 1773 ---------------------------------------------------------------------------------------------------------------
    def test_wrong_target_or_unknown_index_part_names_are_foreign(self):
        f = Fx(); part0_done(f)
        for d, name in (("vm", "part-0001.json"), ("root", "part-0099.bin"), ("root", "part-0004.bin.partial"),     # 1 and 4: other dir; 99: none
                        ("root", "part-0001.verify-garbage.json")):                                              # 1772: not a run id
            with self.subTest(name):
                (f.dirs[d] / name).write_text("{}"); self.assertCode(3, f.admit, 1, 2, "copy"); os.unlink(f.dirs[d] / name)
        adm = f.admit(1, 2, "copy"); f.session(S3); f.commit(1, S3); f.commit(2, S3)
        (f.dirs["vm"] / "part-0002.verify-20261027T000000Z-9.json").write_text("{}")
        self.assertCode(4, f.post, 1, 2, "copy", adm)

    def test_stop_intent_is_ordered_against_the_final_launch_check(self):
        out = Path(tempfile.mkdtemp(prefix="stop", dir=BASE)); (out / "stop.lock").write_text("{}")
        launched = []
        self.assertEqual(R.guarded_launch(str(out), lambda: False, lambda: launched.append(1) or "started"), "started")
        self.assertIsNone(R.guarded_launch(str(out), lambda: True, lambda: launched.append(2)))     # the job's own stop flag
        R.write_stop(str(out), "test")
        self.assertTrue((out / "STOP").exists())
        self.assertIsNone(R.guarded_launch(str(out), lambda: False, lambda: launched.append(3)))    # a durable STOP
        self.assertEqual(launched, [1])
        out2 = Path(tempfile.mkdtemp(prefix="stop", dir=BASE)); (out2 / "stop.lock").write_text("{}")
        held = threading.Event()

        def hold():
            with R.stop_lock(str(out2)):
                held.set(); time.sleep(0.6)
        t = threading.Thread(target=hold); t.start(); held.wait(5)
        t0 = time.monotonic(); R.write_stop(str(out2), "test")                                       # waits for the launch window
        self.assertGreaterEqual(time.monotonic() - t0, 0.4); t.join()

    def test_driver_forward_retries_until_the_registered_batch_exists(self):
        out = Path(tempfile.mkdtemp(prefix="fwd", dir=BASE))
        root = subprocess.Popen(["bash", "-c", '"$@" & wait', "bash", sys.executable, "-c", "import time; time.sleep(60)", str(R.SCRIPT), "batch"])
        try:
            self.assertFalse(R.forward_to_batch(str(out), root.pid))                                # not registered yet
            pid = None
            for _ in range(100):
                kids = [k for k in R.descendants(root.pid) if R.is_batch_of(R.cmdline(k))]
                if kids:
                    pid = kids[0]; break
                time.sleep(0.05)
            self.assertIsNotNone(pid)
            (out / "active.json").write_text(json.dumps({"pid": pid + 100000, "startTime": R.starttime(pid)}))
            self.assertFalse(R.forward_to_batch(str(out), root.pid))                                # registered pid != the descendant
            (out / "active.json").write_text(json.dumps({"pid": pid, "startTime": R.starttime(pid)}))
            self.assertTrue(R.forward_to_batch(str(out), root.pid))
            self.assertEqual(root.wait(timeout=10), 0)                                              # bash waited for its TERMed child
        finally:
            if root.poll() is None:
                for k in R.descendants(root.pid):
                    os.kill(k, signal.SIGKILL)
                root.kill(); root.wait()

    def test_stop_while_queued_never_starts_admission_or_a_wrapper(self):
        base = Path(tempfile.mkdtemp(prefix="drv", dir=BASE)); out = base / "out"
        fakeq = base / "fake-queue.sh"
        fakeq.write_text('#!/bin/bash\n# NAME MIB CMD...: a delayed queue that finally starts the job, like q-exit-status.sh\nshift 2\nsleep 3\nexec "$@"\n')
        drv = subprocess.Popen([sys.executable, "-I", "-B", str(R.SCRIPT), "drive", "--out", str(out), "--stop", "8", "--queue-cmd", str(fakeq)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        end = time.monotonic() + 30
        while not (out / "batches.jsonl").exists() and time.monotonic() < end:
            time.sleep(0.05)
        time.sleep(0.5); drv.send_signal(signal.SIGTERM)                                            # while the job waits in the queue
        o, e = drv.communicate(timeout=60)
        self.assertEqual(drv.returncode, 5, o + e)
        self.assertTrue((out / "STOP").exists())
        self.assertEqual(sorted(n for n in os.listdir(out) if n.startswith(("admission", "active"))), [])
        ev = [json.loads(l)["event"] for l in (out / "batches.jsonl").read_text().splitlines()]
        self.assertIn("stopped before admission (STOP present)", ev)
        self.assertEqual(ev.count("queue job exited"), 1)                                           # no verify job, no next batch

    def test_batch_refuses_a_changed_runner_or_a_foreign_run_lock(self):
        out = Path(tempfile.mkdtemp(prefix="pin", dir=BASE)); sha = R.file_sha(R.SCRIPT)
        (out / "run.lock").write_text(json.dumps({"runId": "X", "runnerSha256": sha})); (out / "stop.lock").write_text("{}")
        run = lambda rid, h: subprocess.run([sys.executable, "-I", "-B", str(R.SCRIPT), "batch", "--mode", "copy", "--lo", "1", "--hi", "8",
                                             "--out", str(out), "--run-id", rid, "--runner-sha256", h], capture_output=True, text=True, timeout=60,
                                            env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(run("X", "0" * 64).returncode, 3); self.assertEqual(run("Y", sha).returncode, 3)
        R.write_stop(str(out), "test")
        self.assertEqual(run("X", sha).returncode, 5)                                               # pins pass; STOP stops it
        self.assertFalse((out / "active.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
