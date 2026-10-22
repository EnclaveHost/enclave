#!/usr/bin/env python3
"""test_verify.py - LOCAL, MOCKED tests of storage-migration-r5's backup verification and pre-switch verification.
- No docker daemon and no PostgreSQL: test/fake_pg_docker.py is put first on PATH as `docker`.
- No indexd: Node.start/stop/wait_ready/app_status are replaced with recorders.
- r4 (ref/replicactl.r4.py) runs the same scenarios as the NEGATIVE CONTROL.
  python3 -u test/test_verify.py -v"""
import ast
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
PKG = Path(__file__).resolve().parent.parent
R5, R4 = Path(os.environ.get("R5_CONTROLLER", PKG / "controller/replicactl.py")), PKG / "ref/replicactl.r4.py"   # R5_CONTROLLER: the fixture-r5 candidate
FAKE = Path(__file__).resolve().parent / "fake_pg_docker.py"
DIGEST = {"objects": [10, "a" * 32], "slabs": [4, "b" * 32], "accounts": [2, "c" * 32]}


def load(path, name):
    sp = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    return m


class Env:
    """a temp node: fake docker on PATH, a production db "indexd" at version v, releases, backups"""
    def __init__(self, mod, v=27, extra_dbs=None):
        self.t = Path(tempfile.mkdtemp(prefix="r5-"))
        (self.t / "bin").mkdir()
        dk = self.t / "bin" / "docker"
        dk.write_text(f"#!/bin/sh\nexec {sys.executable} -B {FAKE} \"$@\"\n"); dk.chmod(0o755)
        self.state, self.log = self.t / "state.json", self.t / "log.jsonl"
        dbs = {"indexd": {"v": v, "digest": DIGEST}, "postgres": {"v": None, "digest": {}}}
        dbs.update(extra_dbs or {})
        self.state.write_text(json.dumps({"dbs": dbs, "sessions": {}}))
        mig = self.t / "migration"; mig.mkdir()
        (mig / "digest.sql").write_text("-- test digest\nSELECT 'digest';\n")
        self.env = {"PATH": f"{self.t / 'bin'}:{os.environ['PATH']}", "FPG_STATE": str(self.state), "FPG_LOG": str(self.log),
                    "FPG_FAULT": "", "FPG_DIGEST_SQL": (mig / "digest.sql").read_text()}
        self.saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        rel = self.t / "releases"
        for h in ("aa" * 32, "bb" * 32):
            (rel / h).mkdir(parents=True)
        (rel / ("aa" * 32) / "indexd").write_bytes(b"old release")
        (rel / ("bb" * 32) / "indexd").write_bytes(b"new release")
        (rel / "current").symlink_to("aa" * 32)
        self.new_sha = mod.sha256(rel / ("bb" * 32) / "indexd")
        os.rename(rel / ("bb" * 32), rel / self.new_sha)
        (self.t / "backups").mkdir(mode=0o700); (self.t / "state").mkdir()
        prof = {"runner": "process", "pg_container": "pg", "database": "indexd", "state_dir": str(self.t / "state"),
                "release_dir": str(rel), "backup_dir": str(self.t / "backups"), "migration_dir": str(mig)}
        (self.t / "profile.json").write_text(json.dumps(prof))
        self.mod = mod
        self.node = mod.Node(self.t / "profile.json")
        self.calls = []
        n = self.node
        n.stop = lambda *a, **k: self.calls.append("stop")
        n.start = lambda *a, **k: self.calls.append("start")
        n.wait_ready = lambda v, *a, **k: self.calls.append(f"ready{v}")
        n.app_status = lambda path: 401

    def fault(self, f):
        os.environ["FPG_FAULT"] = f

    def st(self):
        return json.loads(self.state.read_text())

    def ops(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def current(self):
        return os.readlink(Path(self.node["release_dir"]) / "current")

    def backup(self):
        return self.mod.cmd_backup(self.node, None, quiet=True)

    def close(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.t, ignore_errors=True)


def run_cmd(fn, *a):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            fn(*a)
            code = 0
        except SystemExit as e:
            code = e.code
    lines = out.getvalue().strip().splitlines()
    return code, (json.loads(lines[-1]) if lines else None)


class Verify(unittest.TestCase):
    def setUp(self):
        self.m = load(R5, "r5")
        self.e = Env(self.m)

    def tearDown(self):
        self.e.close()

    def scratch_names(self):
        return [m for o in self.e.ops() if o["op"] == "psql" for m in re.findall(r'CREATE DATABASE "([^"]+)"', o["sql"])]

    def test_verified_backup_creates_a_unique_scratch_and_drops_only_it(self):
        b = self.e.backup()
        r1, r2 = self.m.verify_backup(self.e.node, b), self.m.verify_backup(self.e.node, b)
        for r in (r1, r2):
            self.assertTrue(r["ok"] and r["cleanupOk"] and r["digestMatches"], r); self.assertEqual(r["scratchState"], "dropped")
            self.assertEqual(r["restoredDbVersion"], 27)
            self.assertRegex(r["scratch"], r"^indexd_verify_[0-9a-f]{16}$")
        self.assertNotEqual(r1["scratch"], r2["scratch"])
        self.assertEqual(set(self.e.st()["dbs"]), {"indexd", "postgres"}, "only the scratch databases came and went")
        psqls = [o["sql"].strip() for o in self.e.ops() if o["op"] == "psql"]
        self.assertFalse([s for s in psqls if "IF EXISTS" in s], "no DROP ... IF EXISTS")
        for s in psqls:
            if "DATABASE" in s:
                self.assertEqual(s.count(";"), 1, f"CREATE/DROP sent alone: {s}")
        self.assertTrue(all(o["bounded"] and o["tmo"] == "3600" for o in self.e.ops() if o["op"] == "pg_restore"))
        rec = json.loads((b / f"verify-{r1['scratch']}.json").read_text())
        self.assertEqual(rec["scratchState"], "dropped")

    def test_legacy_fixed_verify_database_is_never_touched(self):
        st = self.e.st(); st["dbs"]["indexd_verify"] = {"v": 99, "digest": {"other": [1, "d" * 32]}}; self.e.state.write_text(json.dumps(st))
        r = self.m.verify_backup(self.e.node, self.e.backup())
        self.assertTrue(r["ok"]); self.assertEqual(self.e.st()["dbs"]["indexd_verify"]["v"], 99)

    def test_scratch_name_is_bounded_and_valid_for_any_database_name(self):
        for db in ("indexd", "Weird-Name.With Spaces" * 4, "x" * 200, "ü", ""):
            n = self.m.scratch_name(db)
            self.assertLessEqual(len(n.encode()), 63); self.assertRegex(n, r"^[a-z0-9_]+_verify_[0-9a-f]{16}$")

    def test_a_preexisting_scratch_name_is_not_ours_and_never_dropped(self):
        b = self.e.backup()
        self.m.secrets = types.SimpleNamespace(token_hex=lambda n: "0" * 16)
        st = self.e.st(); st["dbs"]["indexd_verify_" + "0" * 16] = {"v": 5, "digest": {}}; self.e.state.write_text(json.dumps(st))
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertTrue(r["cleanupOk"]); self.assertIn("already existed", r["scratchState"])
        self.assertEqual(self.e.st()["dbs"]["indexd_verify_" + "0" * 16]["v"], 5)
        self.assertFalse([o for o in self.e.ops() if o["op"] == "psql" and o["sql"].startswith("DROP")])

    def test_an_ambiguous_create_is_preserved_never_dropped(self):
        b = self.e.backup()
        self.e.fault("create-lost")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertFalse(r["cleanupOk"]); self.assertTrue(r["scratchState"].startswith("AMBIGUOUS"))
        self.assertIn(r["scratch"], self.e.st()["dbs"], "preserved")
        self.assertFalse([o for o in self.e.ops() if o["op"] in ("pg_restore",) or (o["op"] == "psql" and o["sql"].startswith("DROP"))])
        self.assertTrue((b / f"verify-{r['scratch']}.json").exists(), "the name is recorded for recovery")

    def test_a_lost_create_answer_timeout_is_ambiguous_too(self):
        b = self.e.backup()
        real = self.e.node.psql_rc
        def lost(sql, db="postgres", timeout=120):
            if sql.startswith("CREATE DATABASE"):
                real(sql, db, timeout)            # the server created it ...
                return None, "", "timeout"         # ... but the answer was lost
            return real(sql, db, timeout)
        self.e.node.psql_rc = lost
        r = self.m.verify_backup(self.e.node, b)
        self.assertTrue(r["scratchState"].startswith("AMBIGUOUS")); self.assertIn(r["scratch"], self.e.st()["dbs"])

    def test_a_failed_create_that_created_nothing_is_clean(self):
        b = self.e.backup()
        self.e.fault("create-error")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertTrue(r["cleanupOk"]); self.assertTrue(r["scratchState"].startswith("not created"), r["scratchState"])

    def test_a_killed_restore_waits_for_its_backend_then_drops(self):
        b = self.e.backup()
        self.e.fault("restore-killed")
        r = self.m.verify_backup(self.e.node, b, sessions_wait=5)
        self.assertFalse(r["ok"]); self.assertTrue(r["cleanupOk"]); self.assertEqual(r["scratchState"], "dropped")
        sess = [o for o in self.e.ops() if o["op"] == "psql" and "pg_stat_activity" in o["sql"]]
        self.assertEqual(len(sess), 3, "dropped only after the lingering backend left")

    def test_a_backend_that_never_leaves_keeps_the_scratch(self):
        b = self.e.backup()
        self.e.fault("linger-forever")
        r = self.m.verify_backup(self.e.node, b, sessions_wait=3)
        self.assertFalse(r["cleanupOk"]); self.assertTrue(r["scratchState"].startswith("KEPT")); self.assertIn(r["scratch"], self.e.st()["dbs"])
        self.assertTrue(r["ok"], "the backup itself verified")

    def test_a_host_timeout_of_the_restore_is_bounded_and_still_safe(self):
        b = self.e.backup()
        real = subprocess.run
        def run(cmd, *a, **k):
            if "pg_restore" in " ".join(map(str, cmd)):
                raise subprocess.TimeoutExpired(cmd, k.get("timeout"))
            return real(cmd, *a, **k)
        self.m.subprocess = types.SimpleNamespace(run=run, TimeoutExpired=subprocess.TimeoutExpired)
        r = self.m.verify_backup(self.e.node, b, sessions_wait=3)
        self.assertFalse(r["ok"]); self.assertIn("did not answer within 3660 s", " ".join(r["problems"]))
        self.assertEqual(r["scratchState"], "dropped")

    def test_digest_mismatch_fails_and_still_cleans(self):
        b = self.e.backup()
        self.e.fault("restore-mismatch")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertFalse(r["digestMatches"]); self.assertTrue(r["cleanupOk"])

    def test_failed_restore_and_failed_drop(self):
        b = self.e.backup()
        self.e.fault("restore-fails")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertEqual(r["scratchState"], "dropped")
        self.e.fault("drop-fails")
        r = self.m.verify_backup(self.e.node, b)
        self.assertTrue(r["ok"]); self.assertFalse(r["cleanupOk"]); self.assertTrue(r["scratchState"].startswith("DROP not confirmed"))

    def test_hash_mismatch_or_unbounded_container_creates_nothing(self):
        b = self.e.backup()
        (b / "indexd.pgdump").write_bytes(b"tampered")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertNotIn("scratch", r)
        self.assertFalse(self.scratch_names())

    def test_no_timeout_binary_refuses_before_create(self):
        b = self.e.backup()
        self.e.fault("no-timeout")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertFalse(self.scratch_names())

    def test_cmd_verify_backup_exit_code(self):
        b = self.e.backup()
        code, out = run_cmd(self.m.cmd_verify_backup, self.e.node, types.SimpleNamespace(backup=str(b)))
        self.assertEqual(code, 0); self.assertTrue(out["ok"])
        self.e.fault("drop-fails")
        code, out = run_cmd(self.m.cmd_verify_backup, self.e.node, types.SimpleNamespace(backup=str(b)))
        self.assertEqual(code, 1, "verified but a scratch database of ours is left")


class Upgrade(unittest.TestCase):
    def setUp(self):
        self.m = load(R5, "r5u")

    def args(self, e, action):
        return types.SimpleNamespace(sha256=e.new_sha, confirm=action)

    def check_order(self, e):
        ops = [o["op"] if o["op"] != "psql" else o["sql"].split()[0] for o in e.ops()]
        i_restore = ops.index("pg_restore")
        drops = [k for k, o in enumerate(ops) if o == "DROP"]
        self.assertTrue(drops and drops[-1] > i_restore)
        return ops

    def test_upgrade_verifies_before_the_switch(self):
        for fn, v, action in ((self.m.cmd_upgrade, 26, "upgrade"), (self.m.cmd_upgrade_c2, 27, "upgrade-c2")):
            e = Env(self.m, v=v)
            try:
                seen = []
                real_switch = self.m.switch_current
                self.m.switch_current = lambda node, h: (seen.append(("switch", [o["op"] for o in e.ops()].count("pg_restore"))), real_switch(node, h))
                code, out = run_cmd(fn, e.node, self.args(e, action))
                self.m.switch_current = real_switch
                self.assertEqual(seen, [("switch", 1)], "the switch happens after exactly one verification restore")
                self.assertEqual(e.current(), e.new_sha); self.assertTrue(out["backupVerified"])
                self.check_order(e)
            finally:
                e.close()

    def test_failed_verification_does_not_switch_and_resumes_the_unchanged_source(self):
        for fn, v, action in ((self.m.cmd_upgrade, 26, "upgrade"), (self.m.cmd_upgrade_c2, 27, "upgrade-c2")):
            e = Env(self.m, v=v)
            try:
                e.fault("restore-mismatch")
                code, out = run_cmd(fn, e.node, self.args(e, action))
                self.assertEqual(code, 1); self.assertFalse(out["ok"])
                self.assertEqual(e.current(), "aa" * 32, "nothing switched")
                self.assertEqual(out["resume"], {"resumed": True, "release": "aa" * 32, "dbVersion": v})
                self.assertEqual(e.calls, ["stop", "start", f"ready{v}"])
                b = Path(out["backup"])
                self.assertTrue((b / "manifest.json").exists() and (b / f"verify-{out['verify']['scratch']}.json").exists(), "evidence kept")
            finally:
                e.close()

    def test_resume_failure_is_reported_and_nothing_switched(self):
        e = Env(self.m, v=26)
        try:
            e.fault("restore-fails")
            def bad(v, *a, **k):
                raise RuntimeError("not ready within 120s")
            e.node.wait_ready = bad
            code, out = run_cmd(self.m.cmd_upgrade, e.node, self.args(e, "upgrade"))
            self.assertEqual(code, 1); self.assertFalse(out["resume"]["resumed"]); self.assertIn("not ready", out["resume"]["resumeFailed"])
            self.assertEqual(e.current(), "aa" * 32)
        finally:
            e.close()

    def test_resume_is_refused_when_unsafe(self):
        e = Env(self.m, v=26)
        try:
            e.fault("restore-fails")
            real = self.m.verify_backup
            def verify_then_change(node, b, **k):
                r = real(node, b, **k)
                cur = Path(node["release_dir"]) / "current"; cur.unlink(); cur.symlink_to(e.new_sha)   # someone switched meanwhile
                return r
            self.m.verify_backup = verify_then_change
            code, out = run_cmd(self.m.cmd_upgrade, e.node, self.args(e, "upgrade"))
            self.m.verify_backup = real
            self.assertEqual(code, 1); self.assertFalse(out["resume"]["resumed"]); self.assertIn("not restarted", out["resume"]["reason"])
            self.assertNotIn("start", e.calls)
        finally:
            e.close()

    def test_ambiguous_scratch_blocks_the_upgrade(self):
        e = Env(self.m, v=27)
        try:
            e.fault("create-lost")
            code, out = run_cmd(self.m.cmd_upgrade_c2, e.node, self.args(e, "upgrade-c2"))
            self.assertEqual(code, 1); self.assertTrue(out["verify"]["scratchState"].startswith("AMBIGUOUS"))
            self.assertEqual(e.current(), "aa" * 32); self.assertIn(out["verify"]["scratch"], e.st()["dbs"])
        finally:
            e.close()


class Revision2(unittest.TestCase):
    """root review notes 1-4 on the first r5 candidate (ref/r5-initial)"""
    def setUp(self):
        self.m = load(R5, "r5rev2")
        self.e = Env(self.m)

    def tearDown(self):
        self.e.close()

    def prof(self, **k):
        p = json.loads((self.e.t / "profile.json").read_text()); p.update(k)
        (self.e.t / "profile.json").write_text(json.dumps(p)); self.e.node.p.update(k)

    def drops(self):
        return [o for o in self.e.ops() if o["op"] == "psql" and o["sql"].startswith("DROP")]

    def patched_run(self, match, exc):
        real = subprocess.run
        def run(cmd, *a, **k):
            if match in " ".join(map(str, cmd)):
                raise exc(cmd)
            return real(cmd, *a, **k)
        self.m.subprocess = types.SimpleNamespace(**{**{k: getattr(subprocess, k) for k in dir(subprocess) if not k.startswith("_")}, "run": run})

    # ---- note 2: an ambiguous CREATE is never reported clean, and never dropped
    def test_create_timeout_then_count_zero_stays_ambiguous_and_a_late_create_is_never_dropped(self):
        b = self.e.backup()
        real = self.e.node.psql_rc
        late = {}
        def lost(sql, db="postgres", timeout=120):
            if sql.startswith("CREATE DATABASE"):
                late["name"] = re.search(r'"([^"]+)"', sql).group(1)
                return None, "", "timeout"            # answer lost; the server has NOT created it yet
            return real(sql, db, timeout)
        self.e.node.psql_rc = lost
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["cleanupOk"]); self.assertTrue(r["scratchState"].startswith("AMBIGUOUS: CREATE answer lost"), r["scratchState"])
        st = self.e.st(); st["dbs"][late["name"]] = {"v": None, "digest": {}}; self.e.state.write_text(json.dumps(st))   # the late CREATE lands
        self.assertFalse(self.drops()); self.assertIn(late["name"], self.e.st()["dbs"])
        self.assertFalse([o for o in self.e.ops() if o["op"] == "pg_restore"])

    def test_connection_lost_without_creation_is_ambiguous_not_clean(self):
        b = self.e.backup()
        self.e.fault("create-nocreate-lost")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["cleanupOk"]); self.assertIn("unclear (psql rc 2)", r["scratchState"]); self.assertFalse(self.drops())

    # ---- note 4: exclusive, owned record and temps
    def test_an_existing_record_of_the_same_scratch_is_refused_and_kept(self):
        b = self.e.backup()
        self.m.secrets = types.SimpleNamespace(token_hex=lambda n: "0" * (2 * n))
        rec = b / ("verify-indexd_verify_" + "0" * 16 + ".json"); rec.write_text("theirs")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertTrue(r["cleanupOk"]); self.assertEqual(rec.read_text(), "theirs")
        self.assertIn("FileExistsError", " ".join(r["problems"]))
        self.assertFalse([o for o in self.e.ops() if o["op"] == "psql" and "CREATE" in o["sql"]], "nothing created")

    def test_a_preexisting_temp_is_never_reused_or_removed(self):
        b = self.e.backup()
        self.m.secrets = types.SimpleNamespace(token_hex=lambda n: "0" * (2 * n))
        name = "verify-indexd_verify_" + "0" * 16 + ".json"
        tmp = b / f".{name}.{'0' * 16}.tmp"; tmp.write_text("someone else's temp")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertEqual(tmp.read_text(), "someone else's temp")
        self.assertFalse([o for o in self.e.ops() if o["op"] == "psql" and "CREATE" in o["sql"]])

    def test_a_record_replaced_by_someone_else_is_not_overwritten(self):
        b = self.e.backup()
        real = self.e.node.psql_rc
        def swap(sql, db="postgres", timeout=120):
            out = real(sql, db, timeout)
            if sql.startswith("CREATE DATABASE"):
                p = next(b.glob("verify-*.json")); p.unlink(); p.write_text("replaced")      # a new inode at the name
            return out
        self.e.node.psql_rc = swap
        r = self.m.verify_backup(self.e.node, b)
        self.assertEqual(next(b.glob("verify-*.json")).read_text(), "replaced")
        self.assertFalse(r["cleanupOk"]); self.assertTrue(r["scratchState"].startswith("PRESERVED after an exception")); self.assertFalse(self.drops())
        self.assertIn(r["scratch"], self.e.st()["dbs"])
        self.assertFalse(list(b.glob(".verify-*.tmp")), "our own temp is removed, nothing else")

    # ---- note 3: bounded total
    def test_a_never_leaving_backend_is_bounded_by_the_query_budget(self):
        b = self.e.backup()
        self.prof(verify_query_seconds=3)
        self.e.fault("linger-forever")
        t0 = time.monotonic()
        r = self.m.verify_backup(self.e.node, b, sessions_wait=120)
        self.assertLess(time.monotonic() - t0, 15)
        self.assertFalse(r["cleanupOk"]); self.assertIn(r["scratch"], self.e.st()["dbs"]); self.assertFalse(self.drops())

    def test_hanging_queries_are_bounded_by_the_query_budget(self):
        b = self.e.backup()
        self.prof(verify_query_seconds=4)
        real = self.e.node.psql_rc
        def hang(sql, db="postgres", timeout=120):
            if "pg_stat_activity" in sql:
                time.sleep(timeout)                    # each query uses its whole slot, then its answer is lost
                return None, "", "timeout"
            return real(sql, db, timeout)
        self.e.node.psql_rc = hang
        t0 = time.monotonic()
        r = self.m.verify_backup(self.e.node, b, sessions_wait=120)
        self.assertLess(time.monotonic() - t0, 15)
        self.assertFalse(r["cleanupOk"]); self.assertFalse(self.drops())

    def test_scratch_digest_and_version_reads_are_bounded(self):
        b = self.e.backup()
        seen = []
        rd, rv = self.e.node.digest, self.e.node.db_version
        self.e.node.digest = lambda db=None, timeout=None: (seen.append(("digest", db, timeout)), rd(db=db, timeout=timeout))[1]
        self.e.node.db_version = lambda db=None, timeout=None: (seen.append(("version", db, timeout)), rv(db=db, timeout=timeout))[1]
        r = self.m.verify_backup(self.e.node, b)
        self.assertTrue(r["ok"])
        scratch_reads = [x for x in seen if x[1] == r["scratch"]]
        self.assertEqual([x[0] for x in scratch_reads], ["digest", "version"])
        self.assertTrue(all(x[2] is not None and 0 < x[2] <= self.m.QUERY_CAP for x in scratch_reads))

    # ---- note 1: ordinary exceptions are reported, and the pre-switch boundary resumes the unchanged source
    def test_ordinary_exceptions_inside_verify_are_reported_not_raised(self):
        b = self.e.backup()
        (b / "manifest.json").write_text("{not json")
        r = self.m.verify_backup(self.e.node, b)
        self.assertFalse(r["ok"]); self.assertTrue(r["cleanupOk"]); self.assertIn("JSONDecodeError", " ".join(r["problems"]))

    def test_command_v_timeout_through_upgrade_resumes_the_unchanged_source(self):
        e2 = Env(self.m, v=26)
        try:
            self.patched_run("command -v timeout", lambda cmd: subprocess.TimeoutExpired(cmd, 60))
            code, out = run_cmd(self.m.cmd_upgrade, e2.node, types.SimpleNamespace(sha256=e2.new_sha, confirm="upgrade"))
            self.assertEqual(code, 1); self.assertEqual(e2.current(), "aa" * 32)
            self.assertEqual(out["resume"], {"resumed": True, "release": "aa" * 32, "dbVersion": 26}); self.assertEqual(e2.calls, ["stop", "start", "ready26"])
            self.assertIn("TimeoutExpired", " ".join(out["verify"]["problems"]))
        finally:
            e2.close()

    def test_restore_launch_failure_through_upgrade_c2_preserves_scratch_and_resumes(self):
        e2 = Env(self.m, v=27)
        try:
            self.patched_run("pg_restore", lambda cmd: FileNotFoundError(2, "No such file or directory: 'docker'"))
            code, out = run_cmd(self.m.cmd_upgrade_c2, e2.node, types.SimpleNamespace(sha256=e2.new_sha, confirm="upgrade-c2"))
            self.assertEqual(code, 1); self.assertEqual(e2.current(), "aa" * 32); self.assertTrue(out["resume"]["resumed"])
            v = out["verify"]
            self.assertFalse(v["cleanupOk"]); self.assertTrue(v["scratchState"].startswith("PRESERVED after an exception")); self.assertIn(v["scratch"], e2.st()["dbs"])
            self.assertTrue(json.loads((Path(out["backup"]) / f"verify-{v['scratch']}.json").read_text())["scratchState"].startswith("PRESERVED"))
        finally:
            e2.close()

    def test_an_unexpected_verify_exception_is_caught_at_the_switch_boundary(self):
        e2 = Env(self.m, v=26)
        try:
            def boom(node, b, **k):
                raise ValueError("unexpected")
            self.m.verify_backup = boom
            code, out = run_cmd(self.m.cmd_upgrade, e2.node, types.SimpleNamespace(sha256=e2.new_sha, confirm="upgrade"))
            self.assertEqual(code, 1); self.assertTrue(out["resume"]["resumed"]); self.assertEqual(e2.current(), "aa" * 32)
            self.assertIn("ValueError", out["verify"]["problems"][0])
        finally:
            e2.close()

    def test_keyboard_interrupt_propagates_and_never_switches(self):
        e2 = Env(self.m, v=26)
        try:
            def interrupt(node, b, **k):
                raise KeyboardInterrupt
            self.m.verify_backup = interrupt
            with self.assertRaises(KeyboardInterrupt):
                run_cmd(self.m.cmd_upgrade, e2.node, types.SimpleNamespace(sha256=e2.new_sha, confirm="upgrade"))
            self.assertEqual(e2.current(), "aa" * 32)
        finally:
            e2.close()

    def test_a_start_exception_during_resume_is_reported(self):
        e2 = Env(self.m, v=26)
        try:
            e2.fault("restore-fails")
            def bad_start(*a, **k):
                raise OSError("exec format error")
            e2.node.start = bad_start
            code, out = run_cmd(self.m.cmd_upgrade, e2.node, types.SimpleNamespace(sha256=e2.new_sha, confirm="upgrade"))
            self.assertEqual(code, 1); self.assertFalse(out["resume"]["resumed"]); self.assertIn("OSError", out["resume"]["resumeFailed"])
        finally:
            e2.close()


class NegativeControlR4(unittest.TestCase):
    """the same scenarios on the reviewed r4: both blockers are real"""
    def test_r4_drops_the_fixed_verify_database(self):
        m = load(R4, "r4")
        e = Env(m, v=27, extra_dbs={"indexd_verify": {"v": 99, "digest": {"other": [1, "d" * 32]}}})
        try:
            b = e.backup()
            code, out = run_cmd(m.cmd_verify_backup, e.node, types.SimpleNamespace(backup=str(b)))
            self.assertTrue([o for o in e.ops() if o["op"] == "psql" and 'DROP DATABASE IF EXISTS "indexd_verify"' in o["sql"]])
            self.assertNotEqual(e.st()["dbs"].get("indexd_verify", {}).get("v"), 99, "r4 destroyed the unrelated database")
        finally:
            e.close()

    def test_r4_upgrade_switches_without_verifying(self):
        m = load(R4, "r4u")
        e = Env(m, v=26)
        try:
            e.fault("restore-mismatch")
            code, out = run_cmd(m.cmd_upgrade, e.node, types.SimpleNamespace(sha256=e.new_sha, confirm="upgrade"))
            self.assertFalse([o for o in e.ops() if o["op"] == "pg_restore"], "r4 never restores before the switch")
            self.assertEqual(e.current(), e.new_sha, "r4 switched an unverified backup")
        finally:
            e.close()


@unittest.skipUnless(R5 == PKG / "controller/replicactl.py", "the r4 -> r5 delta check applies to the r5 controller itself")
class Static(unittest.TestCase):
    def test_delta_is_limited_to_the_two_blockers(self):
        def defs(p):
            t = ast.parse(p.read_text()); out = {}
            for n in t.body:
                if isinstance(n, ast.FunctionDef):
                    out[n.name] = ast.unparse(n)
                elif isinstance(n, ast.ClassDef):
                    for f in n.body:
                        if isinstance(f, ast.FunctionDef):
                            out[f"{n.name}.{f.name}"] = ast.unparse(f)
            return out
        r4, r5 = defs(R4), defs(R5)
        self.assertEqual(sorted(k for k in r4 if r4[k] != r5.get(k)), ["Node.db_version", "Node.digest", "Node.psql", "cmd_upgrade", "cmd_upgrade_c2", "cmd_verify_backup"])
        self.assertEqual(sorted(set(r5) - set(r4)), ["Node.psql_rc", "QueryBudget.__init__", "QueryBudget.cap", "VerifyRecord.__init__", "VerifyRecord.write",
                                                     "_scratch_count", "_verify", "resume_unchanged", "scratch_name", "verify_backup", "verify_before_switch"])
        # Node.psql/db_version/digest: only the optional timeout (None = r4's unbounded call)
        for f in ("Node.db_version", "Node.digest"):
            self.assertEqual(r5[f].replace(", timeout=None", "").replace(", timeout=timeout", ""), r4[f], f)
        for f in ("cmd_upgrade", "cmd_upgrade_c2"):
            a, b = r4[f], r5[f]
            self.assertEqual(b.replace("    verify_before_switch(node, b, before, STOCK_DB_VERSION)\n", "").replace("    verify_before_switch(node, b, before, FENCE_DB_VERSION)\n", "")
                             .replace(", 'backupVerified': True", ""), a, f)
        src = R5.read_text()
        self.assertNotIn('IF EXISTS "', src); self.assertNotIn('_verify"', src.split('"""', 2)[2])


if __name__ == "__main__":
    unittest.main()
