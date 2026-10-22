#!/usr/bin/env python3
"""test_migrate_step.py - LOCAL, MOCKED tests of migrate_step.py.
- Fake systemctl/docker/pgrep (test/fakes.py) and a fake controller (test/fake_controller.py), under MS_TEST_ROOT.
- No VM, no service, no PostgreSQL, no network.
  python3 -u test/test_migrate_step.py -v"""
import ast
import hashlib
import itertools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent
WS = PKG / "migrate_step.py"
W = next(p for p in PKG.parents if p.name == "work")
MIGSRC = W / "claude-resumed-20261022/control-package/storage-migration/controller-profile/migration"
R5 = W / "claude-resumed-20261022/control-package/storage-migration-r5/controller/replicactl.py"
H = lambda b: hashlib.sha256(b).hexdigest()


class Env:
    def __init__(self, version=26, current="ORIG", **db):
        self.t = Path(tempfile.mkdtemp(prefix="ms-"))
        self.root = self.t / "root"; (self.root / "run").mkdir(parents=True); (self.root / "var/lib/enclave-indexd").mkdir(parents=True)
        b = self.t / "bin"; b.mkdir()
        for n in ("systemctl", "docker", "pgrep"):
            (b / n).write_text(f"#!/bin/sh\nexec {sys.executable} -B {HERE / 'fakes.py'} {n} \"$@\"\n"); (b / n).chmod(0o755)
        rel = self.t / "releases"; rel.mkdir()
        self.rel = {}
        for k in ("ORIG", "FENCE", "C2"):
            data = f"fake {k} release\n".encode(); h = H(data); self.rel[k] = h
            (rel / h).mkdir(); (rel / h / "indexd").write_bytes(data)
        (rel / "current").symlink_to(self.rel[current])
        mig = self.t / "migration"; shutil.copytree(MIGSRC, mig)
        (self.t / "state").mkdir(); (self.t / "state/consensus.db").write_bytes(b"x" * 100)
        bk = self.t / "backups"; bk.mkdir(mode=0o700); bk.chmod(0o700)
        pw = self.t / "admin"; pw.write_text("dummy"); pw.chmod(0o600)
        (self.t / "ALLOW").write_text("")
        self.ctl = self.t / "replicactl.py"; shutil.copy(HERE / "fake_controller.py", self.ctl)
        self.prof = self.t / "profile.json"
        self.p = {"runner": "systemd", "unit": "enclave-indexd", "pg_container": "enclave-indexd-postgres", "database": "indexd",
                  "state_dir": str(self.t / "state"), "release_dir": str(rel), "backup_dir": str(bk), "admin_password_file": str(pw),
                  "allow_file": str(self.t / "ALLOW"), "migration_dir": str(mig), "app_url": "http://127.0.0.1:9982",
                  "verify_timeout_seconds": 5, "verify_query_seconds": 6}
        self.write_profile()
        self.state = self.t / "fake-state.json"
        d = {"version": version, "fsync": "on", "sync": "on", "fenced": 0, "enrolled": 0, "size": 1000}; d.update(db)
        self.state.write_text(json.dumps({"unit": {"active": True}, "db": d, "sessions": [], "scratch": []}))
        self.invoked = self.t / "invoked"
        self.cfg = {"state": str(self.state), "invoked": str(self.invoked), "releases": [self.rel["ORIG"], self.rel["FENCE"], self.rel["C2"]], "scenario": None}
        self.env = dict(os.environ, PATH=f"{b}:{os.environ['PATH']}", MS_TEST_ROOT=str(self.root), MS_TEST_CONTROLLER_SHA=H(self.ctl.read_bytes()),
                        MS_TEST_RELEASES=json.dumps([self.rel["ORIG"], self.rel["FENCE"], self.rel["C2"]]), FAKE_STATE=str(self.state), MS_TEST_BOUNDS=json.dumps({"pg_dump": 2, "psql": 2, "restoreSlack": 1, "deadline": 15, "watchEvery": 0.5,
                        "readiness": 3, "sweep": 3, "stop": 1, "copy": 1, "startReady": 1, "checks": 1, "h4Margin": 1, "vtMin": 1}))

    def write_profile(self):
        self.prof.write_text(json.dumps(self.p))

    def st(self):
        return json.loads(self.state.read_text())

    def put(self, f):
        s = self.st(); f(s); self.state.write_text(json.dumps(s))

    def cur(self):
        return os.readlink(Path(self.p["release_dir"]) / "current")

    def ms(self, *a, scenario="success", timeout=120):
        (self.t / "fake-controller.json").write_text(json.dumps(dict(self.cfg, scenario=scenario)))
        r = subprocess.run([sys.executable, "-B", str(WS), *a, "--profile", str(self.prof), "--controller", str(self.ctl)],
                           capture_output=True, text=True, timeout=timeout, env=self.env)
        lines = r.stdout.strip().splitlines()
        try:
            out = json.loads(r.stdout) if r.stdout.strip().startswith("{\n") else json.loads(lines[-1])
        except Exception:
            out = {"raw": r.stdout[-400:], "stderr": r.stderr[-400:]}
        return r.returncode, out, r.stderr

    def result(self):
        f = sorted((self.root / "var/lib/enclave-indexd/migrate-step").glob("*.result.json"))
        return json.loads(f[-1].read_text())

    def calls(self, verb):
        return [c for c in self.st()["log"] if c[0] == "systemctl" and c[1] == verb]

    def close(self):
        shutil.rmtree(self.t, ignore_errors=True)


class Precheck(unittest.TestCase):
    def setUp(self):
        self.e = Env()

    def tearDown(self):
        self.e.close()

    def test_ready_on_the_expected_source_state(self):
        rc, out, err = self.e.ms("precheck", "--step", "upgrade-27")
        self.assertEqual(rc, 0, out); self.assertTrue(out["ready"]); self.assertIn("ms.testRoot=", err)

    def refused(self, needle, mutate=None, step="upgrade-27"):
        if mutate:
            mutate(self.e)
        rc, out, _ = self.e.ms("precheck", "--step", step)
        self.assertEqual(rc, 5, out); self.assertTrue(any(needle in f for f in out["failures"]), out["failures"])
        self.assertFalse(self.e.invoked.exists(), "the controller is never invoked by a precheck")
        self.assertFalse(self.e.calls("stop") or self.e.calls("start"))

    def test_wrong_release(self):
        def m(e):
            c = Path(e.p["release_dir"]) / "current"; c.unlink(); c.symlink_to(e.rel["FENCE"])
        self.refused("is not this step's source", m)

    def test_wrong_schema(self):
        self.refused("db_version 27 != 26", lambda e: e.put(lambda s: s["db"].update(version=27)))

    def test_durability_off(self):
        self.refused("durability", lambda e: e.put(lambda s: s["db"].update(sync="off")))

    def test_tool_session_already_present(self):
        self.refused("sessions already present", lambda e: e.put(lambda s: s["sessions"].append({"pid": 9, "app": "psql", "db": "indexd", "start": "2026-01-01T00:00:00.000000Z"})))

    def test_h4_query_budget_must_cover_restore_plus_margin(self):
        def m(e):
            e.p["verify_query_seconds"] = 5; e.write_profile()
        self.refused("verify_query_seconds >=", m)

    def test_public_app_url_refused(self):
        def m(e):
            e.p["app_url"] = "https://sia.enclave.host"; e.write_profile()
        self.refused("app_url must be the loopback", m)

    def test_root_decides_left(self):
        def m(e):
            e.p["admin_password_file"] = "ROOT_DECIDES: x"; e.write_profile()
        self.refused("admin_password_file not filled", m)

    def test_controller_not_pinned(self):
        self.refused("controller is not the pinned", lambda e: e.ctl.write_text(e.ctl.read_text() + "\n# changed\n"))

    def test_migration_tampered(self):
        self.refused("migration down-28-to-27.sql differs", lambda e: (Path(e.p["migration_dir"]) / "down-28-to-27.sql").write_text("-- x\n"))

    def test_target_release_missing(self):
        self.refused("not installed or hash mismatch", lambda e: (Path(e.p["release_dir"]) / e.rel["FENCE"] / "indexd").write_text("tampered"))

    def test_unit_not_running(self):
        self.refused("unit not active/running", lambda e: e.put(lambda s: s["unit"].update(active=False)))

    def test_lock_held(self):
        import fcntl
        lock = self.e.root / "run/enclave-indexd-snapshot.lock"
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600); fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            self.refused("snapshot lock is held")
        finally:
            os.close(fd)

    def test_rollback27_with_enrolled_needs_ack(self):
        e = self.e
        c = Path(e.p["release_dir"]) / "current"; c.unlink(); c.symlink_to(e.rel["C2"])
        e.put(lambda s: s["db"].update(version=28, enrolled=2))
        rc, out, _ = e.ms("precheck", "--step", "rollback-27")
        self.assertEqual(rc, 5); self.assertTrue(any("--acknowledge-cas-downgrade" in f for f in out["failures"]))
        rc, out, _ = e.ms("precheck", "--step", "rollback-27", "--acknowledge-cas-downgrade")
        self.assertEqual(rc, 0, out)


class Run(unittest.TestCase):
    def tearDown(self):
        self.e.close()

    def go(self, scenario, step="upgrade-27", **env):
        self.e = getattr(self, "e", None) or Env(**env)
        return self.e.ms("run", "--step", step, "--confirm", step, scenario=scenario)

    def test_success_is_verified(self):
        rc, out, _ = self.go("success")
        res = self.e.result()
        self.assertEqual(rc, 0, res); self.assertEqual(res["outcome"], "STEP_DONE_VERIFIED")
        self.assertTrue(all(res["postcheck"]["checks"].values()), res["postcheck"]["checks"])
        self.assertEqual(self.e.cur(), self.e.rel["FENCE"])

    def test_die_before_switch_resumes_unchanged_source(self):
        rc, out, _ = self.go("die-before-switch")
        res = self.e.result()
        self.assertEqual(rc, 1, res); self.assertEqual(res["outcome"], "STEP_NOT_DONE_SOURCE_RESUMED")
        self.assertEqual(res["recovery"]["decision"], "START"); self.assertEqual(self.e.cur(), self.e.rel["ORIG"])
        self.assertEqual(len(self.e.calls("start")), 1); self.assertTrue(self.e.st()["unit"]["active"])

    def test_pg_dump_hang_is_terminated_by_identity_then_source_resumed(self):
        self.e = Env()
        self.e.put(lambda s: s["sessions"].append({"pid": 55, "app": "", "db": "indexd", "start": "2026-01-01T00:00:00.000000Z"}))   # indexd's own: never a tool
        rc, out, _ = self.go("pgdump-hang")
        res = self.e.result()
        self.assertEqual(rc, 1, res); self.assertEqual([w["session"]["pid"] for w in res["watchdog"]], [777])
        self.assertTrue(res["watchdog"][0]["terminated"]); self.assertGreaterEqual(res["watchdog"][0]["session"]["age"], 3)
        self.assertEqual([s["pid"] for s in self.e.st()["terminated"]], [777], "only the controller-era pg_dump")
        self.assertIn(55, [s["pid"] for s in self.e.st()["sessions"]])
        self.assertEqual(res["outcome"], "STEP_NOT_DONE_SOURCE_RESUMED")

    def test_deadline_kills_the_controller_group_and_resumes(self):
        t0 = time.monotonic()
        rc, out, _ = self.go("hang")
        res = self.e.result()
        self.assertLess(time.monotonic() - t0, 60)
        self.assertEqual(res["controllerKilled"], "deadline"); self.assertEqual(rc, 1, res)
        self.assertEqual(res["recovery"]["decision"], "START")

    def test_switched_but_not_migrated_reverts_to_the_unchanged_source(self):
        rc, out, _ = self.go("switched-not-migrated")
        res = self.e.result()
        self.assertEqual(rc, 1, res); self.assertEqual(res["recovery"]["decision"], "SWITCH_THEN_START")
        self.assertEqual(res["recovery"]["release"], self.e.rel["ORIG"]); self.assertEqual(self.e.cur(), self.e.rel["ORIG"])
        self.assertTrue(self.e.st()["unit"]["active"])

    def test_rollback_down_applied_not_switched_completes_to_the_matching_release(self):
        self.e = Env(version=27, current="FENCE")
        rc, out, _ = self.go("down-applied-not-switched", step="rollback-26")
        res = self.e.result()
        self.assertEqual(res["recovery"]["decision"], "SWITCH_THEN_START"); self.assertEqual(res["recovery"]["release"], self.e.rel["ORIG"])
        self.assertEqual(self.e.cur(), self.e.rel["ORIG"]); self.assertEqual(self.e.st()["db"]["version"], 26)
        self.assertEqual(rc, 4, res); self.assertEqual(res["outcome"], "STEP_DONE_AFTER_RECOVERY")

    def test_mismatch_with_a_running_writer_is_never_touched(self):
        rc, out, _ = self.go("mismatch-running")
        res = self.e.result()
        self.assertEqual(rc, 3, res); self.assertEqual(res["outcome"], "RECOVERY_REQUIRED")
        self.assertEqual(self.e.calls("start"), []); self.assertEqual(self.e.cur(), self.e.rel["FENCE"], "no switch")

    def test_failed_start_is_recovery_required(self):
        self.e = Env()
        self.e.put(lambda s: s.update(startFails=True))
        rc, out, _ = self.go("die-before-switch")
        self.assertEqual(rc, 3, self.e.result()); self.assertEqual(self.e.result()["outcome"], "RECOVERY_REQUIRED")

    def test_verify_failure_with_r5_resume_is_consistent_and_names_kept_scratch(self):
        rc, out, _ = self.go("verify-failed-resumed")
        res = self.e.result()
        self.assertEqual(rc, 1, res); self.assertEqual(res["recovery"]["decision"], "CONSISTENT")
        self.assertEqual(res["scratchKept"][0]["scratch"], "indexd_verify_fedcba9876543210")
        self.assertEqual(self.e.calls("start"), [], "already resumed by r5; the wrapper does not start twice")

    def test_refused_precheck_never_runs_the_controller(self):
        self.e = Env(version=27)
        rc, out, _ = self.go("success")
        self.assertEqual(rc, 5); self.assertFalse(self.e.invoked.exists())


class Recover(unittest.TestCase):
    def setUp(self):
        self.e = Env()

    def tearDown(self):
        self.e.close()

    def test_without_apply_it_only_reports(self):
        self.e.put(lambda s: s["unit"].update(active=False))
        rc, out, _ = self.e.ms("recover", "--step", "upgrade-27")
        self.assertEqual(out["decision"], "START"); self.assertEqual(self.e.calls("start"), [])

    def test_unreadable_schema_is_recovery_required(self):
        self.e.put(lambda s: (s["unit"].update(active=False), s["db"].update(unreadable=True)))
        rc, out, _ = self.e.ms("recover", "--step", "upgrade-27", "--apply")
        self.assertEqual(rc, 3); self.assertEqual(out["decision"], "RECOVERY_REQUIRED"); self.assertEqual(self.e.calls("start"), [])


class DropScratch(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.b = Path(self.e.p["backup_dir"]) / "b1"; self.b.mkdir()
        self.n = "indexd_verify_fedcba9876543210"
        self.e.put(lambda s: s["scratch"].append(self.n))

    def tearDown(self):
        self.e.close()

    def drop(self, name=None):
        return self.e.ms("drop-scratch", "--backup", str(self.b), "--name", name or self.n, "--confirm", "drop-scratch")

    def test_unrecorded_name_refused(self):
        rc, out, _ = self.drop()
        self.assertEqual(rc, 5); self.assertIn(self.n, self.e.st()["scratch"])

    def test_connected_backend_refused(self):
        (self.b / f"verify-{self.n}.json").write_text(json.dumps({"scratch": self.n, "cleanupOk": False}))
        self.e.put(lambda s: s["sessions"].append({"pid": 3, "app": "psql", "db": self.n, "start": "2026-01-01T00:00:00.000000Z"}))
        rc, out, _ = self.drop()
        self.assertEqual(rc, 5); self.assertIn(self.n, self.e.st()["scratch"])

    def test_recorded_unused_scratch_is_dropped_by_exact_name(self):
        (self.b / f"verify-{self.n}.json").write_text(json.dumps({"scratch": self.n, "cleanupOk": False}))
        rc, out, _ = self.drop()
        self.assertEqual(rc, 0, out); self.assertEqual(self.e.st()["dropped"], [self.n])

    def test_foreign_or_legacy_names_refused(self):
        for n in ("indexd_verify", "other_verify_fedcba9876543210", "indexd_verify_FEDCBA9876543210"):
            rc, out, _ = self.drop(n)
            self.assertEqual(rc, 5, n)


class Pure(unittest.TestCase):
    def test_decide_never_starts_a_release_whose_schema_differs(self):
        sys.path.insert(0, str(PKG))
        import importlib.util
        sp = importlib.util.spec_from_file_location("ms", WS); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
        rels = list(m.RELEASES)
        units = [{"ActiveState": a, "SubState": b, "MainPID": p} for a, b, p in (("active", "running", "1"), ("inactive", "dead", "0"),
                 ("failed", "failed", "0"), ("activating", "start", "1"), ("active", "exited", "0"), ("deactivating", "stop-sigterm", "1"))] + [{"error": "x"}]
        n = 0
        for step, cur, db, u, w in itertools.product(m.STEPS.values(), rels + [None, "ff" * 32], [26, 27, 28, None, "x"], units, [True, False, "unknown"]):
            act, rel, _ = m.decide(cur, db, u, w, step)
            n += 1
            if act in ("START", "SWITCH_THEN_START"):
                self.assertEqual(m.RELEASES[rel], db); self.assertIs(w, False); self.assertNotEqual(u.get("ActiveState"), "active")
                if act == "SWITCH_THEN_START":
                    self.assertIn(rel, (step["from"], step["to"]))
        self.assertGreater(n, 500)


class Static(unittest.TestCase):
    def test_production_pins(self):
        t = ast.parse(WS.read_text())
        consts = {}
        for node in t.body:
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Tuple) and [e.id for e in node.targets[0].elts] == ["ORIG", "FENCE", "C2"]:
                consts["rel"] = ast.literal_eval(node.value)
        self.assertEqual(consts["rel"], ("2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc",
                                         "c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568",
                                         "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7"))
        src = WS.read_text()
        self.assertIn(f'else "{H(R5.read_bytes())}"', src, "controller pin = the r5 rev2 controller file")
        for f in MIGSRC.iterdir():
            self.assertIn(f'"{f.name}": "{H(f.read_bytes())}"', src, f.name)

    def test_no_broad_kills_no_if_exists_one_drop(self):
        src = WS.read_text()
        for bad in ("pkill", "killall", "docker rm", "IF EXISTS", "WITH (FORCE)", "pg_cancel_backend"):
            self.assertNotIn(bad, src, bad)
        self.assertEqual(src.count("DROP DATABASE"), 1)                 # only drop-scratch's statement
        self.assertEqual(src.count("pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid ="), 1)
        self.assertIn("os.killpg(proc.pid, sig)", src); self.assertIn("start_new_session=True", src)


if __name__ == "__main__":
    unittest.main()
