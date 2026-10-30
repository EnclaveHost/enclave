#!/usr/bin/env python3
"""recovery-overlay-stage/r8 DIAGNOSTIC tests (prepared by Claude 1707; NOT run by Claude). 13 tests:
D1-D10 authorization (pure; synthetic files): the diagnostic request is strict, bound, never a GO, and never accepts the recovery;
E1-E3 end to end with REAL tools: a restored REAL MDBX fixture validated by the PINNED mdbx_chk through diag/run_validator.py on
the read-only fuse2fs view (rc 0), a non-MDBX target (rc 6), and a tampered validator wrapper refused (rc 6).
Environment (jobs/tests.sh): RECOVERY_OVERLAY_WORK, RECOVERY_OVERLAY_FUSE2FS(+_SHA256), MDBX_BIN (mdbx_chk, mk_fixture),
MDBX_CHK_SHA256, MDBX_CHECK_PY (+_SHA256)."""
import contextlib, hashlib, io, json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
sys.path.insert(0, STAGE); sys.path.insert(0, os.path.join(STAGE, "fixture"))
import diagnostic_request as D    # noqa: E402
import overlay_plan as P          # noqa: E402
import overlay_session as S       # noqa: E402
import make_fixture as F          # noqa: E402
import make_mdbx_fixture as M     # noqa: E402

E = os.environ
WORK = E["RECOVERY_OVERLAY_WORK"]
FUSE2FS, FUSE2FS_SHA = E["RECOVERY_OVERLAY_FUSE2FS"], E["RECOVERY_OVERLAY_FUSE2FS_SHA256"]
MDBX_BIN, CHK_SHA = E["MDBX_BIN"], E["MDBX_CHK_SHA256"]
CHECK_PY, CHECK_PY_SHA = E["MDBX_CHECK_PY"], E["MDBX_CHECK_PY_SHA256"]
H = lambda s: hashlib.sha256(s).hexdigest()
PLAN, JOURNAL = "a" * 64, "b" * 64


def wjson(path, obj):
    b = json.dumps(obj).encode()
    with open(path, "wb") as f:
        f.write(b)
    return H(b)


def rbytes(path):
    with open(path, "rb") as f:
        return f.read()


def quiet(fn, argv):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        rc = fn(argv)
    return rc, out.getvalue()


class Diagnostic(unittest.TestCase):
    n = 0

    def newdir(self, name):
        type(self).n += 1
        d = os.path.join(WORK, f"d{type(self).n:02d}-{name}")
        os.mkdir(d, 0o700)
        return d

    def setUp(self):
        self.d = self.newdir("auth")
        self.hist = os.path.join(self.d, "history.json")
        self.hist_sha = wjson(self.hist, {"format": "enclave-postdelete-bitmap/r1", "verdict": "BLOCKED", "blockers": ["coalesced"]})

    def request(self, **over):
        r = {"format": D.FORMAT, "purpose": D.PURPOSE, "recoveryAccepted": False, "productionUse": False, "planSha256": PLAN,
             "journalSha256": JOURNAL, "history": {"path": self.hist, "sha256": self.hist_sha, "verdict": "BLOCKED"},
             "validator": {"chkSha256": CHK_SHA, "wrapperSha256": CHECK_PY_SHA}, "requestedBy": "root", "note": "diagnostic only"}
        drop = over.pop("_drop", None)
        r.update(over)
        if drop:
            del r[drop]
        p = os.path.join(self.d, f"req-{len(os.listdir(self.d))}.json")
        return p, wjson(p, r)

    def check(self, p, s, **pins):
        kw = dict(plan_sha=PLAN, journal_sha=JOURNAL, history_path=self.hist, history_sha=self.hist_sha, chk_sha=CHK_SHA, wrapper_sha=CHECK_PY_SHA)
        kw.update(pins)
        return D.check_request(p, s, **kw)

    def refused(self, needle, p, s, **pins):
        with self.assertRaises(D.Refused) as cm:
            self.check(p, s, **pins)
        self.assertIn(needle, str(cm.exception))

    # ---- authorization -----------------------------------------------------------------------------------------------------------
    def test_d01_a_bound_request_authorizes_a_diagnostic_view_only(self):
        r = self.check(*self.request())
        self.assertEqual((r["authorized"], r["diagnostic"], r["recoveryAccepted"], r["productionUse"], r["historyVerdict"]),
                         (True, True, False, False, "BLOCKED"))
        self.assertIn("no data-integrity, recovery or production claim", r["label"])

    def test_d02_recovery_accepted_must_be_json_false(self):
        for v in (True, "false", 0, None, []):
            self.refused("recoveryAccepted must be JSON false", *self.request(recoveryAccepted=v))

    def test_d03_production_use_must_be_json_false(self):
        for v in (True, "false", 0):
            self.refused("productionUse must be JSON false", *self.request(productionUse=v))

    def test_d04_purpose_and_format_are_exact(self):
        self.refused("purpose must be exactly", *self.request(purpose="production"))
        self.refused("not a recovery-overlay-diagnostic-request/v1", *self.request(format="recovery-overlay-diagnostic-request/v2"))

    def test_d05_exact_keys(self):
        self.refused("exactly the keys", *self.request(extra=1))
        self.refused("exactly the keys", *self.request(_drop="note"))

    def test_d06_bound_to_the_pinned_plan_and_journal(self):
        self.refused("pinned plan and journal", *self.request(planSha256="c" * 64))
        self.refused("pinned plan and journal", *self.request(journalSha256="c" * 64))
        self.refused("pinned plan and journal", *self.request(), plan_sha="d" * 64)

    def test_d07_only_the_pinned_blocked_history(self):
        self.refused("does not name the pinned history", *self.request(history={"path": "/elsewhere.json", "sha256": self.hist_sha, "verdict": "BLOCKED"}))
        self.refused("verdict", *self.request(history={"path": self.hist, "sha256": self.hist_sha, "verdict": "PASS"}))
        p, s = self.request()
        passed = os.path.join(self.d, "passed.json")
        psha = wjson(passed, {"format": "enclave-postdelete-bitmap/r1", "verdict": "PASS"})
        p2, s2 = self.request(history={"path": passed, "sha256": psha, "verdict": "PASS"})
        self.refused("binds ONLY a BLOCKED history", p2, s2, history_path=passed, history_sha=psha)     # accepted -> the GO path
        wjson(self.hist, {"verdict": "BLOCKED", "changed": True})                                       # the history file changed
        self.refused("not its pinned sha256", p, s)

    def test_d08_bound_to_the_pinned_validator(self):
        self.refused("pinned validator", *self.request(validator={"chkSha256": "e" * 64, "wrapperSha256": CHECK_PY_SHA}))
        self.refused("pinned validator", *self.request(), wrapper_sha="f" * 64)

    def test_d09_the_request_itself_is_pinned(self):
        p, _s = self.request()
        self.refused("not the pinned sha256", p, "0" * 64)

    def test_d10_go_and_diagnostic_are_mutually_exclusive_and_the_go_job_is_unchanged(self):
        go = os.path.join(self.d, "go.json")
        gsha = wjson(go, {"format": D.GO_FORMAT, "pass": True, "planSha256": PLAN, "journalSha256": JOURNAL, "gateReceiptSha256": "9" * 64})
        self.assertTrue(D.check_go(go, PLAN, JOURNAL))
        self.refused("exactly the keys", go, gsha)                                    # a GO is never a diagnostic request
        p, _s = self.request()
        self.assertFalse(D.check_go(p, PLAN, JOURNAL))                                # a diagnostic request is never a GO
        r7 = rbytes(os.path.join(os.path.dirname(STAGE), "r7", "jobs", "root-expose-real.sh")).decode()
        r8 = rbytes(os.path.join(STAGE, "jobs", "root-expose-real.sh")).decode()
        self.assertEqual(r8, r7.replace("recovery-overlay-stage/r7", "recovery-overlay-stage/r8").replace("rov-r7-", "rov-r8-"),
                         "the acceptance GO job must stay exactly r7's")
        for must in ('g.get("pass") is True', 'g.get("format") == "recovery-overlay-go/v1"', "--require-ro-mount"):
            self.assertIn(must, r8)

    # ---- end to end (real tools) -------------------------------------------------------------------------------------------------
    @classmethod
    def setUpClass(cls):
        cls.mx = M.build(os.path.join(WORK, "mdbx-fixture"), os.path.join(MDBX_BIN, "mk_fixture"))

    def e2e(self, capture, parent, parent_sha, check_py=CHECK_PY, timeout="600"):
        out = os.path.join(WORK, f"plan-e2e-{type(self).n}")
        rc, text = quiet(P.main, ["fixture", "--capture", capture, "--name", "mdbx.dat", "--path", "/data/db/mdbx.dat", "--out", out])
        self.assertEqual(rc, 0, text)
        run = self.newdir("e2e")
        report = os.path.join(run, "mdbx-report.json")
        args = ["--plan-dir", out, "--plan-sha256", H(rbytes(os.path.join(out, "plan.json"))), "--parent", parent, "--parent-sha256", parent_sha,
                "--run-dir", run, "--fuse2fs", FUSE2FS, "--fuse2fs-sha256", FUSE2FS_SHA, "--exec-timeout", "900",
                "--exec", sys.executable, "-I", "-B", os.path.join(STAGE, "diag", "run_validator.py"), "--check-py", check_py,
                "--check-py-sha256", CHECK_PY_SHA, "--chk", os.path.join(MDBX_BIN, "mdbx_chk"), "--chk-sha256", CHK_SHA,
                "--timeout", timeout, "--out", report]
        rc, _ = quiet(S.main, args)
        r = json.loads(rbytes(os.path.join(run, "receipt.json")))
        self.assertIs(r["cleanupComplete"], True, r); self.assertIs(r["parentUnchanged"], True); self.assertEqual(r["leftoverProcesses"], [])
        return rc, r, (json.loads(rbytes(report)) if os.path.exists(report) else None)

    def test_e1_the_restored_real_mdbx_view_is_validated_by_the_pinned_mdbx_chk(self):
        rc, r, rep = self.e2e(self.mx["capture"], self.mx["parent"], self.mx["parentSha256"])
        self.assertEqual(rc, 0, (r.get("exec"), rep))
        self.assertIs(r["checks"]["targetExact"]["ok"], True)
        self.assertEqual((rep["rc"], rep["structurallyClean"], rep["unchangedIdentity"], rep["timedOut"]), (0, True, True, False))
        self.assertEqual(rep["chk"]["sha256"], CHK_SHA)

    def test_e2_a_non_mdbx_target_is_not_clean_and_gives_rc_6(self):
        fx = F.build(os.path.join(WORK, "plain-fixture"))
        rc, r, rep = self.e2e(fx["capture"], os.path.join(WORK, "plain-fixture", "parent-clean.qcow2"), fx["parents"]["parent-clean.qcow2"])
        self.assertEqual(rc, 6, r.get("exec"))
        self.assertIsNotNone(rep); self.assertIs(rep["structurallyClean"], False)

    def test_e3_a_tampered_validator_wrapper_is_refused(self):
        d = self.newdir("tampered-wrapper")
        bad = os.path.join(d, "mdbx_check.py")
        with open(bad, "wb") as f:
            f.write(rbytes(CHECK_PY) + b"\n# tampered\n")
        rc, r, rep = self.e2e(self.mx["capture"], self.mx["parent"], self.mx["parentSha256"], check_py=bad)
        self.assertEqual(rc, 6, r.get("exec")); self.assertIsNone(rep)


if __name__ == "__main__":
    unittest.main()
