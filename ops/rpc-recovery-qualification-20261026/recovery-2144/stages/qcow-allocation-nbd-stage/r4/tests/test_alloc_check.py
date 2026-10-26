#!/usr/bin/env python3
"""qcow-allocation-nbd-stage/r4 tests (prepared by Claude 1714; NOT run by Claude). r3: the server is identified by its PID (receipt,
or the checker's child list), never by cwd (qemu-nbd chdir("/") after binding: root 1713); waits fail fast if the checker exits.
r2: r1's 3 tests (unchanged assertions) now ALL run in a
run dir whose socket path is LONGER than AF_UNIX's 108 bytes, plus: SIGTERM mid-run (complete receipt, server ended, image unchanged)
and SIGKILL of the checker (PR_SET_PDEATHSIG ends the server). A tiny qcow2 fixture made with the pinned qemu-img/qemu-io; the pinned
qemu-nbd --read-only; libnbd. Unprivileged (not in a user namespace: a 0444 image is really unwritable). No network."""
import glob, hashlib, json, os, signal, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE)); sys.dont_write_bytecode = True
import alloc_check as A  # noqa: E402

QNBD, QNBD_SHA = "/usr/sbin/qemu-nbd", os.environ["ALLOC_QEMU_NBD_SHA256"]
K = 1024


def sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
    assert r.returncode == 0, (cmd, r.stderr); return r.stdout


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def children(ppid):
    """qemu-nbd processes whose parent is ppid"""
    out = []
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                with open(f"/proc/{pid}/stat") as f:
                    rest = f.read().rsplit(")", 1)
                with open(f"/proc/{pid}/comm") as f:
                    comm = f.read().strip()
                if int(rest[1].split()[1]) == ppid and comm == "qemu-nbd":
                    out.append(int(pid))
            except (OSError, ValueError, IndexError):
                pass
    return out


def holders(run):
    """pids whose cwd is the run dir or whose cmdline names it (the checker; a server leaves its cwd: see children())"""
    out = []
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                if os.readlink(f"/proc/{pid}/cwd") == run:
                    out.append(int(pid)); continue
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    if run.encode() in f.read():
                        out.append(int(pid))
            except OSError:
                pass
    return out


def gone(pid, within=10.0):
    end = time.monotonic() + within
    while time.monotonic() < end:
        try:
            with open(f"/proc/{pid}/stat") as f:
                state = f.read().rsplit(")", 1)[1].split()[0]
        except (FileNotFoundError, ProcessLookupError):
            return True
        if state == "Z":
            return True
        time.sleep(0.05)
    return False


class Alloc(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp(prefix="alloc-")
        cls.deep = os.path.join(cls.d, "d" * 100, "e" * 60); os.makedirs(cls.deep)      # every run dir is deeper than sun_path allows
        cls.img = os.path.join(cls.d, "fixture.qcow2")
        sh("qemu-img", "create", "-q", "-f", "qcow2", "-o", "cluster_size=65536", cls.img, "4M")
        for c in ("write -q -P 0xaa 0 128k", "write -q -z 256k 64k", "write -q -P 0 320k 64k", "write -q -P 0x55 1M 64k"):
            sh("qemu-io", "-f", "qcow2", "-c", c, cls.img)
        os.chmod(cls.img, 0o444); cls.sha = sha(cls.img)

    def newrun(self, ranges):
        run = tempfile.mkdtemp(prefix="run-", dir=self.deep); os.chmod(run, 0o700)
        self.assertGreater(len(os.path.join(run, A.SOCK).encode()), 108, "the fixture must exceed AF_UNIX sun_path")
        rp = os.path.join(run, "ranges.json")
        with open(rp, "w") as f:
            json.dump({"ranges": ranges}, f)
        return run, rp

    def argv(self, run, rp, image=None, sha256=QNBD_SHA, timeout="120"):
        img = image or self.img
        return ["--image", img, "--ranges", rp, "--run-dir", run, "--qemu-nbd", QNBD, "--qemu-nbd-sha256", sha256,
                "--timeout", timeout, "--image-sha256", sha(img)]

    def receipt(self, run):
        res = []
        for p in glob.glob(os.path.join(run, "result-*.json")):
            with open(p) as f:
                res.append(json.load(f))
        self.assertEqual(len(res), 1); self.assertFalse(os.path.lexists(os.path.join(run, A.SOCK)))
        self.assertEqual(holders(run), [], "a process still uses the run dir")
        if "server" in res[0]:
            self.assertTrue(gone(res[0]["server"]["pid"]), "the server outlived the check")
        return res[0]

    def run_check(self, ranges, **kw):
        run, rp = self.newrun(ranges)
        rc = A.main(self.argv(run, rp, **kw))
        return rc, self.receipt(run)

    def test_1_long_socket_path_known_regions_classified_exactly_image_unchanged(self):
        rc, r = self.run_check([[0, 384 * K], [1024 * K, 1088 * K]])
        self.assertEqual(rc, 0, r); t = r["totals"]
        self.assertEqual(t["allocatedData"], 128 * K + 64 * K + 64 * K, t)
        self.assertEqual(t["hole"] + t["holeZero"] + t["zeroNotHole"], 192 * K, t)
        self.assertTrue(all(s["flags"] & A.ZERO for s in r["nonDataSamples"]), r["nonDataSamples"])
        self.assertEqual((r["rangesWithHoleOrZero"], r["rangesFullyAllocatedData"]), (1, 1))
        self.assertTrue(r["imageUnchanged"] and r["cleanupComplete"] and r["complete"]); self.assertEqual(sha(self.img), self.sha)
        self.assertIn("not necessarily lost useful content", r["meaning"]); self.assertTrue(r["server"]["bind"].startswith("/proc/self/cwd/nbd.sock"))
        c = r["server"]["client"].split("/")                  # exactly /proc/self/fd/<N>/nbd.sock: never /proc/<child>/cwd
        self.assertEqual((c[:4], len(c), c[4].isdigit(), c[5]), (["", "proc", "self", "fd"], 6, True, "nbd.sock"), r["server"])

    def test_2_chunking_and_clipping(self):
        old = A.CHUNK; A.CHUNK = 64 * K
        try:
            rc, r = self.run_check([[0, 4096 * K]])
        finally:
            A.CHUNK = old
        self.assertEqual(rc, 0, r); self.assertEqual(sum(r["totals"].values()), 4096 * K)
        self.assertEqual(r["totals"]["allocatedData"], 256 * K); self.assertGreaterEqual(r["calls"], 64)

    def test_3_refusals_write_a_complete_receipt(self):
        for ranges, needle in (([[0, 5 * 1024 * K]], "beyond the export size"), ([[0, 128 * K], [64 * K, 256 * K]], "overlap"),
                               ([[10, 10]], "integer pairs")):
            rc, r = self.run_check(ranges)
            self.assertEqual(rc, 3); self.assertIn(needle, r["refused"]); self.assertFalse(r["complete"])
            self.assertTrue(r["cleanupComplete"]); self.assertIs(r.get("imageUnchanged", True), True)
        rc, r = self.run_check([[0, 64 * K]], sha256="0" * 64)
        self.assertEqual(rc, 3); self.assertIn("pinned", r["refused"])
        w = os.path.join(self.d, "writable.qcow2"); sh("qemu-img", "create", "-q", "-f", "qcow2", w, "1M"); os.chmod(w, 0o644)
        rc, r = self.run_check([[0, 64 * K]], image=w)
        self.assertEqual(rc, 3); self.assertIn("cannot write", r["refused"])

    def spawn(self):
        """a separate checker process doing ~100000 small block-status calls; returns it once ITS server is listening"""
        run, rp = self.newrun([[i * 40, i * 40 + 32] for i in range(100000)])
        p = subprocess.Popen([sys.executable, "-I", "-B", os.path.join(os.path.dirname(HERE), "alloc_check.py"), *self.argv(run, rp, timeout="600")],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             env={"PATH": "/usr/bin:/bin:/usr/sbin", "LC_ALL": "C"})
        end = time.monotonic() + 30
        while time.monotonic() < end and not (os.path.exists(os.path.join(run, A.SOCK)) and children(p.pid)):
            if p.poll() is not None:                          # fail fast: the checker already ended
                self.fail(f"the checker exited ({p.returncode}) before its server listened")
            time.sleep(0.05)
        self.assertTrue(children(p.pid), "the checker's server never started"); time.sleep(0.5)
        return p, run

    def test_4_sigterm_mid_run_ends_the_server_and_writes_the_complete_receipt(self):
        p, run = self.spawn(); server = children(p.pid)
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=60), 3)
        r = self.receipt(run)
        self.assertEqual(r["stopReason"], f"signal {int(signal.SIGTERM)}"); self.assertFalse(r["complete"])
        self.assertTrue(r["cleanupComplete"] and r["imageUnchanged"], r); self.assertEqual(sha(self.img), self.sha)
        self.assertTrue(all(gone(x) for x in server))

    def test_5_sigkill_of_the_checker_ends_its_server_by_pdeathsig(self):
        p, run = self.spawn(); server = children(p.pid)
        self.assertTrue(server)
        p.kill(); p.wait(timeout=30)
        self.assertTrue(all(gone(x) for x in server), "the server outlived its killed parent")
        self.assertEqual(sha(self.img), self.sha)


if __name__ == "__main__":
    unittest.main()
