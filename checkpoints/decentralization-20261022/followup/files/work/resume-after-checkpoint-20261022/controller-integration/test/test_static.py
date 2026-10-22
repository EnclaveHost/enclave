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
        runs = HERE / "runs"
        snap = lambda: sorted((f.name, f.stat().st_size, f.stat().st_mtime_ns) for f in runs.iterdir()) if runs.exists() else None
        before = snap()
        r = subprocess.run([sys.executable, "-B", str(RUN), "--plan"], capture_output=True, text=True, timeout=300, env=env)
        out = json.loads(r.stdout)
        self.assertEqual(r.returncode, 0, out); self.assertEqual(out["pinMismatches"], []); self.assertTrue(out["fenceTreeInventory"][0])
        r = subprocess.run([sys.executable, "-B", str(RUN), "--execute", "0" * 64], capture_output=True, text=True, timeout=300, env=env)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(snap(), before, "nothing created or changed in runs/ (root's run e370da8a42b29695 evidence included)")


class Checks(unittest.TestCase):
    def setUp(self):
        self.src = CHECKS.read_text()
        self.d = defs(CHECKS)
        t = ast.parse(self.src)
        for n in t.body:
            if isinstance(n, ast.ClassDef) and n.name == "Holder":
                self.holder = {f.name: ast.unparse(f) for f in n.body if isinstance(f, ast.FunctionDef)}

    def test_checks_and_order(self):
        names = re.findall(r'\("(X\d[ab]?)-[^"]+", (x\w+)\)', self.src)
        self.assertEqual([n for n, _ in names], ["X1", "X2", "X3a", "X3b", "X4", "X5", "X6", "X7", "X8"])

    def test_r1_frozen_and_run_receipt_kept(self):
        self.assertTrue((HERE / "ref/r1/integration_checks.py").is_file())
        rec = (HERE / "ref/r1/RUN-RECEIPT-e370da8a42b29695.sha256").read_text().splitlines()
        self.assertEqual(len(rec), 11)
        for line in rec:
            h, f = line.split("  ", 1)
            self.assertEqual(hashlib.sha256((HERE / f).read_bytes()).hexdigest(), h, f)

    def test_no_container_lifecycle_and_loopback_only(self):
        for bad in ("docker\", \"run\"", "\"rm\", \"-f\"", "\"volume\"", "0.0.0.0", "--network", "IF EXISTS", "pkill", "os.kill("):
            self.assertNotIn(bad, self.src, bad)
        execs = [m.start() for m in re.finditer(r'"docker", "exec"', self.src)]
        self.assertEqual(len(execs), 2, "the psql helper + the Holder, both against this run's own container")
        for i in execs:
            self.assertIn("PG,", self.src[i:i + 120])
        self.assertIn('PG = P["pg_container"]', self.src)

    def test_only_one_database_drop_and_it_is_the_named_validated_leftover(self):
        self.assertEqual(len(re.findall(r"DROP DATABASE", self.src)), 1)
        x4 = self.d["x4_query_budget"]
        i = x4.index("DROP DATABASE")
        self.assertLess(x4.index("SCRATCH_RX.match(scratch)"), i); self.assertLess(x4.index("record_of(S['backup'], scratch)"), i)
        self.assertLess(x4.index("h.close() == 'closed'"), i)

    def test_triggers_are_own_names_in_template1_and_always_removed(self):
        self.assertIn('TRIGGERS = ("c2it_delay", "c2it_refuse", "c2it_barrier")', self.src)
        self.assertIn("check(name in TRIGGERS", self.d["install_trigger"])
        for f in ("x3a_prompt_cancel", "verify_with_holder", "x7_refused_restore_upgrade"):
            self.assertIn("finally:", self.d[f]); self.assertIn("remove_trigger(", self.d[f])
        self.assertIn("for t in TRIGGERS", self.d["finalize"])
        self.assertIn("psql('template1', 'CREATE EVENT TRIGGER c2it_barrier", self.d["install_barrier"])

    def test_holder_identity_gate_and_barrier(self):
        h = self.holder
        self.assertIn("'c2it-holder-' + secrets.token_hex(6)", h["__init__"])
        self.assertIn("PGAPPNAME", h["start"]); self.assertIn("SCRATCH_RX.match(scratch)", h["start"])
        self.assertIn("state = 'active'", h["observe"]); self.assertIn("raise Fail(", h["observe"])
        # the only termination: pg_terminate_backend filtered by THIS holder's token
        self.assertFalse([k for k, v in self.d.items() if "pg_terminate_backend" in v], "no top-level function terminates backends")
        self.assertEqual([k for k, v in h.items() if "pg_terminate_backend" in v], ["close"])
        self.assertIn("pg_terminate_backend(pid) FROM pg_stat_activity WHERE {ident}application_name = '{self.token}'", h["close"])
        self.assertIn("f'pid = {int(self.pid)} AND ' if self.pid else ''", h["close"])
        self.assertIn("for h in S.get('holders', [])", self.d["finalize"])
        b = self.src[self.src.index("BARRIER = "):self.src.index("def install_barrier")]
        self.assertIn("application_name = '{tok}'", b); self.assertIn("RAISE EXCEPTION 'c2it: holder never attached'", b)
        self.assertIn("re.fullmatch('c2it-holder-[0-9a-f]{12}', token)", self.d["install_barrier"])
        w = self.d["verify_with_holder"]
        order = [w.index(x) for x in ("install_barrier(h.token)", "subprocess.Popen", "new_record_scratch(", "h.start(scratch)", "h.observe(scratch)", "while cli.poll() is None")]
        self.assertEqual(order, sorted(order), "barrier -> CLI -> scratch from record -> holder -> GATE observed -> follow")

    def test_strict_assertions_no_either_branch(self):
        x3a, x3b, x4 = self.d["x3a_prompt_cancel"], self.d["x3b_held_connection_waited_out"], self.d["x4_query_budget"]
        self.assertIn("pg_sleep(20)", x3a); self.assertIn("verify_timeout_seconds=2", x3a); self.assertIn("el < 60", x3a)
        self.assertIn("v['scratchState'] == 'dropped' and v['cleanupOk']", x3a); self.assertIn("verify_backends() == 0", x3a)
        self.assertIn("verify_timeout_seconds=20", x3b); self.assertIn("holder_seconds=40", x3b)
        self.assertIn("f['holderRc'] == 0", x3b); self.assertIn("f['cliEnd'] >= f['holderEnd'] >= 35", x3b); self.assertIn("f['observedAt'] < 20", x3b)
        self.assertIn("v['scratchState'] == 'dropped' and v['cleanupOk']", x3b)
        self.assertIn("verify_query_seconds=12", x4); self.assertIn("holder_seconds=60", x4); self.assertIn("f['cliEnd'] < 30", x4)
        self.assertIn("f['holderAttachedAtCliEnd']", x4); self.assertIn("v['scratchState'].startswith('KEPT')", x4); self.assertIn("f['observedAt'] < 6", x4)
        for f in (x3b, x4):
            self.assertNotIn(" or ", f.replace("'or'", ""), "no either-outcome acceptance")
        x6, x7 = self.d["x6_corrupt_backup_upgrade"], self.d["x7_refused_restore_upgrade"]
        for x in (x6, x7):
            self.assertIn("{'resumed': True, 'release': sha(FENCE), 'dbVersion': 27}", x); self.assertIn("current() == sha(FENCE)", x)
        self.assertIn("hash mismatch", x6); self.assertIn("RAISE EXCEPTION", x7)


if __name__ == "__main__":
    unittest.main()
