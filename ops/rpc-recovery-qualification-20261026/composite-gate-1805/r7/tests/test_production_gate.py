#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r7 production-gate tests (prepared by Claude 1802; NOT run by Claude). 6 tests, tiny and cheap:
no FUSE, no mount, no qemu, no MDBX, no view build, no session - only the gate's checks against the REAL pinned r6 stage and receipt
(read-only) and synthetic temp files. The r6 lifecycle is NOT re-run (it is qualified: cmv-r6-tests 4 + 12 PASS).
Environment: GATE_TEST_TMP."""
import copy, json, os, shutil, subprocess, sys, tempfile, unittest

TMP = os.environ.get("GATE_TEST_TMP", "")
if not (os.path.isabs(TMP) and os.path.isdir(TMP)):
    raise SystemExit("GATE_TEST_TMP must name an existing absolute directory")
tempfile.tempdir = TMP
STAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, STAGE)
import production_gate as G  # noqa: E402

GATE = os.path.join(STAGE, "production_gate.py")
MiB = 1 << 20
OK_MEM = f"MemTotal: 64000000 kB\nMemAvailable: {(G.FLOOR_MIB + G.LANE_MIB + G.HEADROOM_MIB) * 1024} kB\n"


class Gate(unittest.TestCase):
    def test_1_the_actual_qualified_r6_stage_and_receipt_pass(self):
        self.assertEqual(G.check_stage()["sums"], G.R6_SUMS)
        self.assertEqual(G.check_receipt()["sha256"], G.R6_RECEIPT_SHA)

    def test_2_any_other_receipt_bytes_or_any_failed_skipped_or_short_run_is_refused(self):
        with open(G.R6_RECEIPT) as f:
            good = json.load(f)
        self.assertTrue(G.check_receipt_fields(good))
        d = tempfile.mkdtemp(dir=TMP); p = os.path.join(d, "receipt.json")
        with open(p, "w") as f:
            json.dump(good, f)                                                # same fields, different bytes
        with self.assertRaises(G.Refused):
            G.check_receipt(p)

        def bad(fn):
            r = copy.deepcopy(good); fn(r); return r
        cs, gs = "test_composite_session", "test_session_guard"
        variants = [lambda r: r.__setitem__("pass", False), lambda r: r["suites"][cs].update(ran=["11"]),
                    lambda r: r["suites"][gs].update(badMarkers=["skipped"]), lambda r: r["suites"][cs]["checks"].update(rc0=False),
                    lambda r: r["suites"][cs].update(rc=1), lambda r: r.update(stageSums="0" * 64),
                    lambda r: r.update(sessionSha256="1" * 64), lambda r: r["suites"].update(extra={}),
                    lambda r: r["suites"].pop(gs), lambda r: r["environment"].update(peersUnchanged=False),
                    lambda r: r["suites"][gs].update(testsSha256="2" * 64), lambda r: r.update(format="composite-mdbx-validation-test-receipt/r5")]
        for i, v in enumerate(variants):
            with self.assertRaises(G.Refused, msg=i):
                G.check_receipt_fields(bad(v))

    def test_3_a_changed_or_differently_pinned_stage_is_refused(self):
        d = tempfile.mkdtemp(dir=TMP); copyd = os.path.join(d, "r6copy")
        shutil.copytree(G.R6, copyd, ignore=shutil.ignore_patterns("runs"))
        self.assertEqual(G.check_stage(copyd)["files"], 9)                   # an exact copy passes: the check is content-based
        with self.assertRaises(G.Refused):
            G.check_stage(copyd, sums_pin="3" * 64)
        p = os.path.join(copyd, "jobs", "session_guard.py"); os.chmod(p, 0o600)
        with open(p, "a") as f:
            f.write("\n# changed\n")
        with self.assertRaises(G.Refused):
            G.check_stage(copyd)

    def test_4_only_the_exact_incident_production_view_is_accepted(self):
        rec = {"kind": "production", "manifestSha256": G.MANIFEST_SHA, "logicalSize": G.LOGICAL, "sectors": G.LOGICAL // 512,
               "parts": [{}] * G.PARTS}
        self.assertEqual(G.check_view_record(rec)["parts"], 265)
        for k, v in (("kind", "fixture"), ("manifestSha256", "4" * 64), ("logicalSize", G.LOGICAL - 512), ("sectors", 1),
                     ("parts", [{}] * 264), ("parts", None)):
            with self.assertRaises(G.Refused, msg=k):
                G.check_view_record({**rec, k: v})
        # the REUSED r6 importer itself refuses a fixture view as production (before any descriptor, part or record is read)
        v = tempfile.mkdtemp(dir=TMP)
        with open(os.path.join(v, "receipt.json"), "w") as f:
            json.dump({"format": "multipart-view-receipt/v2-records", "kind": "fixture", "r3MultipartSha256":
                       "3159890b5bddcb763f578fa87b833931d695f4181dd447395bb40c2dff1c4381", "parts": []}, f)
        PI = G.load_r6_importer()
        with self.assertRaises(Exception) as cm:
            G.check_view(v)
        self.assertIn("not the expected 'production'", str(cm.exception))
        self.assertTrue(hasattr(PI, "recheck"))

    def test_5_only_the_2560_mib_lane_above_the_16_gib_floor_is_accepted(self):
        cg = "0::/user.slice/x.scope\n"
        self.assertEqual(G.check_lane(cg, str(2560 * MiB), OK_MEM)["memoryMaxMiB"], 2560)
        for cgt, mm, mem in ((cg, "max", OK_MEM), (cg, str(512 * MiB), OK_MEM), (cg, str(4096 * MiB), OK_MEM),
                             (cg, str(2560 * MiB), "MemAvailable: 1000 kB\n"), ("", str(2560 * MiB), OK_MEM),
                             (cg + "0::/other\n", str(2560 * MiB), OK_MEM)):
            with self.assertRaises(G.Refused, msg=(mm, mem[:20])):
                G.check_lane(cgt, mm, mem)

    def test_6_the_cli_refuses_outside_the_lane_writes_only_its_refusal_and_never_starts_a_session(self):
        run = tempfile.mkdtemp(dir=TMP); view = tempfile.mkdtemp(dir=TMP)
        r = subprocess.run([sys.executable, "-I", "-B", GATE, "--view-dir", view, "--run-dir", run, "--max-hours", "1"],
                           capture_output=True, text=True, timeout=120, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)                 # this test job runs in the 256 MiB lane, never 2560
        self.assertEqual(sorted(os.listdir(run)), ["gate-refused.json"])
        with open(os.path.join(run, "gate-refused.json")) as f:
            g = json.load(f)
        self.assertIn("memory.max", g["refused"]); self.assertNotIn("session", g)
        r = subprocess.run([sys.executable, "-I", "-B", GATE, "--view-dir", view, "--run-dir", run, "--max-hours", "1"],
                           capture_output=True, text=True, timeout=120, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(r.returncode, 3)                                     # a used run dir is refused before anything else
        self.assertEqual(sorted(os.listdir(run)), ["gate-refused.json"])


if __name__ == "__main__":
    unittest.main()
