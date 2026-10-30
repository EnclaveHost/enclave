#!/usr/bin/env python3
"""qcow-allocation-nbd-stage/r1 tests (prepared by Claude 1705; NOT run by Claude). A TINY qcow2 fixture with KNOWN allocated, hole,
zero-cluster and zero-content-but-allocated regions (made with the pinned qemu-img/qemu-io), checked through the real pinned qemu-nbd
--read-only and the libnbd client. Unprivileged (not under a user namespace, so a 0444 image is really not writable). No network."""
import json, os, subprocess, sys, tempfile, unittest, hashlib, glob

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


class Alloc(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp(prefix="alloc-"); cls.img = os.path.join(cls.d, "fixture.qcow2")
        sh("qemu-img", "create", "-q", "-f", "qcow2", "-o", "cluster_size=65536", cls.img, "4M")
        for c in ("write -q -P 0xaa 0 128k", "write -q -z 256k 64k", "write -q -P 0 320k 64k", "write -q -P 0x55 1M 64k"):
            sh("qemu-io", "-f", "qcow2", "-c", c, cls.img)
        os.chmod(cls.img, 0o444); cls.sha = sha(cls.img)

    def run_check(self, ranges, *extra, image=None, sha256=QNBD_SHA):
        run = tempfile.mkdtemp(prefix="run-", dir=self.d); os.chmod(run, 0o700)
        rp = os.path.join(run, "ranges.json")
        with open(rp, "w") as f:
            json.dump({"ranges": ranges}, f)
        img = image or self.img
        rc = A.main(["--image", img, "--ranges", rp, "--run-dir", run, "--qemu-nbd", QNBD, "--qemu-nbd-sha256", sha256,
                     "--timeout", "120", "--image-sha256", sha(img), *extra])
        res = [json.load(open(p)) for p in glob.glob(os.path.join(run, "result-*.json"))]
        self.assertEqual(len(res), 1); self.assertFalse(os.path.exists(os.path.join(run, "nbd.sock")))
        for pid in os.listdir("/proc"):                               # nothing of ours may still run
            if pid.isdigit():
                try:
                    self.assertNotIn(run.encode(), open(f"/proc/{pid}/cmdline", "rb").read())
                except OSError:
                    pass
        return rc, res[0]

    def test_1_known_regions_are_classified_exactly_and_the_image_is_unchanged(self):
        rc, r = self.run_check([[0, 384 * K], [1024 * K, 1088 * K]])
        self.assertEqual(rc, 0, r); t = r["totals"]
        self.assertEqual(t["allocatedData"], 128 * K + 64 * K + 64 * K, t)            # 0xaa, zero-CONTENT data, 0x55 are allocated
        self.assertEqual(t["hole"] + t["holeZero"] + t["zeroNotHole"], 192 * K, t)     # the unwritten hole + the write -z zero cluster
        self.assertTrue(all(s["flags"] & A.ZERO for s in r["nonDataSamples"]), r["nonDataSamples"])
        self.assertEqual((r["rangesWithHoleOrZero"], r["rangesFullyAllocatedData"]), (1, 1))
        self.assertTrue(r["imageUnchanged"] and r["cleanupComplete"]); self.assertEqual(sha(self.img), self.sha)
        self.assertIn("NOT content integrity", r["meaning"])

    def test_2_chunking_and_clipping_over_a_range_larger_than_one_extent(self):
        old = A.CHUNK; A.CHUNK = 64 * K                                         # force many bounded requests
        try:
            rc, r = self.run_check([[0, 4096 * K]])
        finally:
            A.CHUNK = old
        self.assertEqual(rc, 0, r); self.assertEqual(sum(r["totals"].values()), 4096 * K)
        self.assertEqual(r["totals"]["allocatedData"], 256 * K); self.assertGreaterEqual(r["calls"], 64)

    def test_3_refusals_write_no_result_claim(self):
        for ranges, needle in (([[0, 5 * 1024 * K]], "beyond the export size"), ([[0, 128 * K], [64 * K, 256 * K]], "overlap"),
                               ([[10, 10]], "integer pairs")):
            rc, r = self.run_check(ranges)
            self.assertEqual(rc, 3); self.assertIn(needle, r["refused"])
        rc, r = self.run_check([[0, 64 * K]], sha256="0" * 64)
        self.assertEqual(rc, 3); self.assertIn("pinned", r["refused"])
        w = os.path.join(self.d, "writable.qcow2"); sh("qemu-img", "create", "-q", "-f", "qcow2", w, "1M"); os.chmod(w, 0o644)
        rc, r = self.run_check([[0, 64 * K]], image=w)
        self.assertEqual(rc, 3); self.assertIn("cannot write", r["refused"])


if __name__ == "__main__":
    unittest.main()
