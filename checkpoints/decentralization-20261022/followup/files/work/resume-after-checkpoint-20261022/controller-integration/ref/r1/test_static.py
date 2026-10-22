#!/usr/bin/env python3
"""test_static.py - LOCAL checks of the derived integration package. No docker, no PostgreSQL, no indexd: static/AST
checks plus `--plan` and a refused `--execute`.
  python3 -u test/test_static.py -v"""
import ast
import hashlib
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent.parent
W = next(p for p in HERE.parents if p.name == "work")
FIX = W / "claude-resumed-20261022/storage-enclave-fixture"
RUN, CHECKS, FROZEN_RUN = HERE / "run-integration.py", HERE / "integration_checks.py", HERE / "ref/run-c2-fixture.frozen.py"


def defs(p):
    return {n.name: ast.unparse(n) for n in ast.parse(p.read_text()).body if isinstance(n, ast.FunctionDef)}


class Runner(unittest.TestCase):
    def test_reference_copy_is_the_frozen_runner(self):
        self.assertEqual(FROZEN_RUN.read_bytes(), (FIX / "fixture/run-c2-fixture.py").read_bytes())
        self.assertEqual(hashlib.sha256(FROZEN_RUN.read_bytes()).hexdigest()[:16], "4b09043ac7b036d9")

    def test_delta_is_limited_to_the_derivation(self):
        old, new = defs(FROZEN_RUN), defs(RUN)
        self.assertEqual(sorted(k for k in old if old[k] != new.get(k)), ["finish", "main", "pins", "work"])
        self.assertEqual(sorted(set(new) - set(old)), ["_load_c2fx"])
        # main: only the two outcome strings
        self.assertEqual(new["main"].replace("stages-and-checks-passed", "stages-passed").replace("stages-or-checks-failed", "stages-failed"), old["main"])
        w = new["work"]
        i_pre, i_st, i_post = w.index("'pre'"), w.index("run_c2_fixture_test.py"), w.index("'post'")
        self.assertLess(i_pre, i_st); self.assertLess(i_st, i_post)
        self.assertIn("C2FX_CONTROLLER=str(CONTROLLER)", w)

    def test_pins_are_exact_and_the_frozen_packages_verify(self):
        src = RUN.read_text()
        frozen = dict(re.findall(r'"((?:fixture|migration)/[^"]+)": "([0-9a-f]{64})"', src))
        self.assertEqual(len(frozen), 7)
        for rel, h in frozen.items():
            self.assertEqual(hashlib.sha256((FIX / rel).read_bytes()).hexdigest(), h, rel)
        ctl = W / "claude-resumed-20261022/control-package/storage-migration-r5/integration/replicactl.fixture-r5.py"
        self.assertIn(hashlib.sha256(ctl.read_bytes()).hexdigest(), src)
        for d in (FIX, W / "claude-resumed-20261022/control-package/storage-migration-r5"):
            r = subprocess.run(["sha256sum", "-c", "--quiet", "SHA256SUMS"], cwd=d, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{d.name}: {r.stdout[-300:]}")

    def test_plan_has_no_side_effects_and_wrong_manifest_is_refused(self):
        env = dict(os.environ, C2FX_DOCKER="/nonexistent/docker")
        r = subprocess.run([sys.executable, "-B", str(RUN), "--plan"], capture_output=True, text=True, timeout=300, env=env)
        out = json.loads(r.stdout)
        self.assertEqual(r.returncode, 0, out); self.assertEqual(out["pinMismatches"], []); self.assertTrue(out["fenceTreeInventory"][0])
        r = subprocess.run([sys.executable, "-B", str(RUN), "--execute", "0" * 64], capture_output=True, text=True, timeout=300, env=env)
        self.assertEqual(r.returncode, 2)
        self.assertFalse((HERE / "runs").exists(), "nothing created")


class Checks(unittest.TestCase):
    def setUp(self):
        self.src = CHECKS.read_text()
        self.d = defs(CHECKS)

    def test_checks_and_order(self):
        names = re.findall(r'\("(X\d-[^"]+)", (x\d_\w+)\)', self.src)
        self.assertEqual([n.split("-")[0] for n, _ in names], [f"X{i}" for i in range(1, 9)])

    def test_no_container_lifecycle_and_loopback_only(self):
        for bad in ("docker\", \"run\"", "\"rm\", \"-f\"", "\"volume\"", "0.0.0.0", "--network", "IF EXISTS", "pkill", "os.kill("):
            self.assertNotIn(bad, self.src, bad)
        self.assertEqual(self.src.count('"docker", "exec"'), 1, "one docker exec helper, against this run's own container from the profile")
        self.assertIn('PG = P["pg_container"]', self.src)

    def test_only_one_database_drop_and_it_is_the_named_validated_leftover(self):
        drops = [m.start() for m in re.finditer(r"DROP DATABASE", self.src)]
        self.assertEqual(len(drops), 1)
        x4 = self.d["x4_query_budget"]
        self.assertIn("DROP DATABASE", x4)
        self.assertLess(x4.index("SCRATCH_RX.match(scratch)"), x4.index("DROP DATABASE"))
        self.assertLess(x4.index("record_of(S['backup'], scratch)"), x4.index("DROP DATABASE"))

    def test_triggers_are_own_names_in_template1_and_always_removed(self):
        self.assertIn('TRIGGERS = ("c2it_delay", "c2it_refuse")', self.src)
        self.assertIn("check(name in TRIGGERS", self.d["install_trigger"])
        for f in ("x3_killed_restore", "x4_query_budget", "x7_refused_restore_upgrade"):
            self.assertIn("finally:", self.d[f]); self.assertIn("remove_trigger(", self.d[f])
        self.assertIn("for t in TRIGGERS", self.d["finalize"])
        self.assertIn("psql('template1', f'CREATE EVENT TRIGGER", self.d["install_trigger"])

    def test_strict_assertions_no_either_branch(self):
        x3, x4 = self.d["x3_killed_restore"], self.d["x4_query_budget"]
        self.assertIn("pg_sleep(20)", x3); self.assertIn("verify_timeout_seconds=2", x3)
        self.assertIn("15 <= el < 140", x3); self.assertIn("v['scratchState'] == 'dropped' and v['cleanupOk']", x3)
        self.assertIn("pg_sleep(30)", x4); self.assertIn("verify_query_seconds=6", x4); self.assertIn("el < 20", x4)
        self.assertIn("v['scratchState'].startswith('KEPT')", x4)
        x6, x7 = self.d["x6_corrupt_backup_upgrade"], self.d["x7_refused_restore_upgrade"]
        for x in (x6, x7):
            self.assertIn("{'resumed': True, 'release': sha(FENCE), 'dbVersion': 27}", x); self.assertIn("current() == sha(FENCE)", x)
        self.assertIn("hash mismatch", x6); self.assertIn("RAISE EXCEPTION", x7)


if __name__ == "__main__":
    unittest.main()
