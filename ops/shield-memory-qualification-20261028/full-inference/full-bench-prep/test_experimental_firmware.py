#!/usr/bin/env python3
"""Offline fixtures for the opt-in experimental firmware pair (EXPERIMENTAL-FIRMWARE.md). Temp files only; the host
only hashes them. No VM, unit, GPU or process is started."""

import contextlib
import hashlib
import io
import json
import os
import tempfile
import unittest

import fullbench as F
from test_fullbench import U0, plan_fixture, qemu_of


class HashHost:
    def sha256(self, path):
        return F.B.sha256_file(path)


class Untouchable:
    def __getattr__(self, name):
        raise AssertionError(f"host.{name} used before the paired-flag check")


def write(path, data):
    with open(path, "wb") as f:
        f.write(data)
    return hashlib.sha256(data).hexdigest()


class ExperimentalFirmware(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.rel = os.path.join(self.d, "rel")
        os.mkdir(self.rel)
        self.orig_sha = write(os.path.join(self.rel, "firmware.fd"), b"original-release-firmware")
        with open(os.path.join(self.rel, "release.json"), "w") as f:
            json.dump({"files": {"firmware.fd": {"sha256": self.orig_sha, "size": 25}}}, f)
        self.cand = os.path.join(self.d, "fw", "OVMF.candidate.fd")
        os.mkdir(os.path.dirname(self.cand))
        self.cand_sha = write(self.cand, b"new-candidate-firmware")
        self.host = HashHost()

    def plan(self, experimental=True):
        p, arm = plan_fixture(release=self.rel)
        p["pins"]["firmware"] = os.path.join(self.rel, "firmware.fd")
        p["experimental_firmware"] = (F.experimental_firmware_record(self.host, self.cand, self.cand_sha, self.rel)
                                      if experimental else None)
        return p, arm

    def problems(self, p):
        return F.firmware_problems(self.host, p, F.release_manifest(self.rel))

    def test_default_keeps_original_release_pin(self):
        self.assertIsNone(F.experimental_firmware_record(self.host, None, None, self.rel))
        p, arm = self.plan(experimental=False)
        q = qemu_of(p, arm)
        self.assertEqual(q[q.index("-bios") + 1], os.path.join(self.rel, "firmware.fd"))
        self.assertEqual(F.qemu_violations(q, p, arm), [])
        self.assertEqual(self.problems(p), [])
        p0, arm0 = plan_fixture()                    # pre-existing plans carry no key: unchanged -bios
        self.assertEqual(qemu_of(p0, arm0)[qemu_of(p0, arm0).index("-bios") + 1], p0["pins"]["firmware"])

    def test_explicit_candidate_pair_accepted_and_recorded(self):
        p, arm = self.plan()
        x = p["experimental_firmware"]
        self.assertEqual((x["path"], x["sha256"], x["original_release_sha256"]), (self.cand, self.cand_sha, self.orig_sha))
        self.assertIn("not the installed original release", x["scope"])
        self.assertIn("not production", x["scope"])
        self.assertEqual(p["pins"]["firmware"], os.path.join(self.rel, "firmware.fd"))   # standard pin untouched
        q = qemu_of(p, arm)
        self.assertEqual(q[q.index("-bios") + 1], self.cand)
        self.assertEqual(F.qemu_violations(q, p, arm), [])
        self.assertEqual(self.problems(p), [])
        orig_boot = q.copy()
        orig_boot[orig_boot.index("-bios") + 1] = p["pins"]["firmware"]
        self.assertTrue(F.qemu_violations(orig_boot, p, arm))     # the plan boots exactly one firmware

    def test_root_machine_binding_still_enforced_with_candidate(self):
        p, arm = self.plan()
        q = qemu_of(p, arm)
        q[q.index("-machine") + 1] = "q35,accel=kvm"
        self.assertIn("machine must bind the SNP guest and planned memory", F.qemu_violations(q, p, arm))

    def test_candidate_drift_fails(self):
        p, _ = self.plan()
        write(self.cand, b"new-candidate-firmware-rebuilt")
        self.assertIn("experimental firmware identity", self.problems(p))
        os.unlink(self.cand)
        self.assertTrue(any(x.startswith("experimental firmware identity:") for x in self.problems(p)))
        other = os.path.join(self.d, "fw", "other.fd")
        write(other, b"some-other-build")
        with self.assertRaisesRegex(ValueError, "!= approved"):        # plan time refuses a mismatched pair too
            F.experimental_firmware_record(self.host, other, self.cand_sha, self.rel)

    def test_original_firmware_drift_fails_even_with_candidate(self):
        p, _ = self.plan()
        write(os.path.join(self.rel, "firmware.fd"), b"tampered-original")
        probs = self.problems(p)
        self.assertIn("firmware pin", probs)
        self.assertNotIn("experimental firmware identity", probs)  # the candidate alone is still intact
        p2, _ = self.plan(experimental=False)
        self.assertIn("firmware pin", self.problems(p2))

    def test_release_manifest_change_fails(self):
        p, _ = self.plan()
        p["experimental_firmware"]["original_release_sha256"] = "0" * 64
        self.assertIn("experimental firmware: original release firmware.fd changed since plan", self.problems(p))

    def test_standard_pin_cannot_be_silently_replaced(self):
        p, _ = self.plan()
        p["pins"]["firmware"] = self.cand
        probs = self.problems(p)
        self.assertIn("firmware pin path is not the release firmware.fd", probs)
        self.assertIn("firmware pin", probs)
        self.assertIn("experimental firmware record malformed", probs)
        p, _ = self.plan()
        p["experimental_firmware"]["scope"] = "production"
        self.assertIn("experimental firmware record malformed", self.problems(p))

    def test_missing_or_malformed_pair_refused(self):
        for path, sha in ((self.cand, None), (None, self.cand_sha), (self.cand, ""), ("", self.cand_sha)):
            with self.assertRaisesRegex(ValueError, "required together"):
                F.experimental_pair(path, sha)
        for sha in (self.cand_sha.upper(), self.cand_sha[:63], self.cand_sha + "0", "g" * 64):
            with self.assertRaisesRegex(ValueError, "64 lowercase hex"):
                F.experimental_pair(self.cand, sha)
        with self.assertRaisesRegex(ValueError, "unsafe path"):
            F.experimental_pair("/tmp/fw,x.fd", self.cand_sha)
        with self.assertRaisesRegex(ValueError, "original release firmware"):
            F.experimental_firmware_record(self.host, self.cand, self.orig_sha, self.rel)
        with self.assertRaisesRegex(ValueError, "inside the production release"):
            F.experimental_firmware_record(self.host, os.path.join(self.rel, "x.fd"), self.cand_sha, self.rel)

    def test_cli_one_sided_flag_refused_before_any_read(self):
        base = ["plan", "--out", "/nonexistent/o", "--qemu", "q", "--worker", "w", "--worker-sha256", "s",
                "--client", "c", "--fwd", "f", "--node", "n", "--vcek", "v", "--min-tcb", "m", "--app-sha", "a",
                "--allowed-cpus", "1", "--bank-dir", "/b", "--image", "A=/i", "--measurement", "A=x",
                "--gpu-uuid", U0, "--vram-gb", "1", "--worker-memory-max-mib", "1"]
        for extra in (["--experimental-firmware", self.cand], ["--experimental-firmware-sha256", self.cand_sha]):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                self.assertEqual(F.main(base + extra, host=Untouchable()), 2)
            self.assertIn("required together", err.getvalue())


if __name__ == "__main__":
    unittest.main()
