#!/usr/bin/env python3
"""Local tests of trace_validate.py: its evaluator, the case-collision lint and the transport size of its two remote
texts. No PowerShell, no network."""
import copy, json, pathlib, sys, unittest
HERE = pathlib.Path(__file__).resolve().parent; sys.path.insert(0, str(HERE))
import trace_validate as V, ps_case_lint as L

ME = "S-1-5-21-1111-2222-3333-1001"
GOOD = {"me": ME, "meName": "NUCBOX_K11\\claude", "mePid": 100, "on": True,
        "child": {"pid": 200, "ppid": 100, "session": 0, "created": "2026-10-21T22:00:00.1234567Z"},
        "owner": {"rc": 0, "name": "NUCBOX_K11\\claude", "alive": True}, "exited": True,
        "starts": [{"pid": 200, "ppid": 100, "session": 0, "created": "2026-10-21T22:00:00.1234560Z", "sid": ME}],
        "errs": [], "cleanup": {"unregistered": True, "subscribers": 0, "childKilled": False}}


def mut(**kw):
    r = copy.deepcopy(GOOD)
    for path, v in kw.items():
        o = r; ks = path.split("__")
        for k in ks[:-1]: o = o[k] if not k.isdigit() else o[int(k)]
        o[ks[-1] if not ks[-1].isdigit() else int(ks[-1])] = v
    return r


class T(unittest.TestCase):
    def test_valid_negative(self): self.assertTrue(V.evaluate(GOOD)["VALID"])
    def test_sid_is_provider_system_is_invalid(self):
        v = V.evaluate(mut(starts__0__sid="S-1-5-18")); self.assertFalse(v["VALID"]); self.assertFalse(v["checks"]["sidIsSessionUser"])
    def test_other_user_sid_invalid(self): self.assertFalse(V.evaluate(mut(starts__0__sid="S-1-5-21-9-9-9-500"))["VALID"])
    def test_time_mismatch_invalid(self): self.assertFalse(V.evaluate(mut(starts__0__created="2026-10-21T22:00:09.0000000Z"))["checks"]["eventTimeMatches"])
    def test_session_mismatch_invalid(self): self.assertFalse(V.evaluate(mut(starts__0__session=1))["VALID"])
    def test_parent_mismatch_invalid(self): self.assertFalse(V.evaluate(mut(starts__0__ppid=4))["VALID"])
    def test_two_events_for_child_invalid(self):
        r = copy.deepcopy(GOOD); r["starts"].append(dict(r["starts"][0])); self.assertFalse(V.evaluate(r)["checks"]["oneEventForChild"])
    def test_no_subscription_invalid(self): self.assertFalse(V.evaluate(mut(on="Microsoft.Management.Infrastructure.CimException"))["VALID"])
    def test_getowner_disagrees_invalid(self): self.assertFalse(V.evaluate(mut(owner__name="NT AUTHORITY\\SYSTEM"))["VALID"])
    def test_cleanup_or_killed_child_invalid(self):
        self.assertFalse(V.evaluate(mut(cleanup__subscribers=1))["VALID"]); self.assertFalse(V.evaluate(mut(cleanup__childKilled=True))["VALID"])
    def test_errors_invalid(self): self.assertFalse(V.evaluate(mut(errs=["event:x"]))["VALID"])
    def test_session_running_as_system_cannot_validate(self):
        self.assertFalse(V.evaluate(mut(me="S-1-5-18", starts__0__sid="S-1-5-18"))["VALID"])
    def test_scripts_lint_clean_and_fit_the_transport(self):
        self.assertEqual(L.collisions(V.SCRIPT), {}); self.assertEqual(L.collisions(V.parse_text()), {})
        m = V.transport(); self.assertLessEqual(V.encoded(m, V.SCRIPT), V.LIMIT); self.assertLessEqual(V.encoded(m, V.parse_text()), V.LIMIT)
    def test_script_launches_only_its_own_bounded_child_and_cleans_in_finally(self):
        s = V.SCRIPT
        self.assertEqual(s.count("Start-Process"), 1); self.assertIn("'Start-Sleep -Seconds 2'", s); self.assertIn("WaitForExit(8000)", s)
        for bad in ("Register-ScheduledTask", "New-Service", "Set-ItemProperty", "New-Item", "Set-Content", "Stop-Process", "taskkill", "wevtutil", "auditpol"):
            self.assertNotIn(bad, s)
        self.assertLess(s.index("finally{"), s.index("Unregister-Event")); self.assertIn("$ch.Kill()", s[s.index("finally{"):])


if __name__ == "__main__":
    unittest.main(verbosity=2)
