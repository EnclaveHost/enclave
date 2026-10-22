#!/usr/bin/env python3
"""static checks of restore-timeout-diagnosis (no Docker, no PostgreSQL): the fix is exactly the reviewed text delta on
both r5 controllers, the frozen sources are untouched, and the reproduction only acts on its own container."""
import ast
import hashlib
import importlib.util
import re
import unittest
from pathlib import Path

DIAG = Path(__file__).resolve().parents[1]
WORK = DIAG.parents[1]
R5PKG = WORK / "claude-resumed-20261022/control-package/storage-migration-r5"
R5_FIXTURE, R5_PROD = R5PKG / "integration/replicactl.fixture-r5.py", R5PKG / "controller/replicactl.py"
FROZEN = {R5_FIXTURE: "2ab98b4d359fd0f3dcd34458ddfdf61a32b0dfb66652328418e453d4bc679151",
          R5_PROD: "3e8a8c3fde252d80a46e0e445b114fb7a61fcd1fd247dcedc2144f41b2431f63",
          WORK / "claude-resumed-20261022/storage-enclave-fixture/fixture/c2fx.py": "ff1b092c54135df64b506b1683fb48679f678f21e6ec5d28ef6fb54a66534ad6",
          WORK / "resume-after-checkpoint-20261022/controller-integration/integration_checks.py": "8fa874de2d8300fe04a1a362708ece3b2f3425d57a6bb039fd87bc2c7a2a107f",
          WORK / "resume-after-checkpoint-20261022/controller-integration/run-integration.py": "0ef3d627062a6fdc453af7a8533a86487c52c85864936ba190e1930749c8b2d8"}
PAIRS = ((R5_FIXTURE, DIAG / "fix/replicactl.fixture-r5.restorefix.py"), (R5_PROD, DIAG / "fix/replicactl.r5-production.restorefix.py"))


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def restore_calls(src):
    """every string constant handed to `sh -c` that runs pg_restore"""
    return [n.value for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Constant) and isinstance(n.value, str) and "pg_restore -U" in n.value]


class Frozen(unittest.TestCase):
    def test_frozen_sources_unchanged(self):
        for p, h in FROZEN.items():
            self.assertEqual(sha(p), h, p)


class Fix(unittest.TestCase):
    def test_copies_are_exactly_the_reviewed_delta(self):
        ap = load("apply_restorefix", DIAG / "fix/apply_restorefix.py")
        for src, fixed in PAIRS:
            self.assertEqual(ap.apply(src.read_text()), fixed.read_text(), fixed)

    def test_only_the_verify_restore_changes_in_code(self):
        """outside docstrings/comments the delta is: the timeout probe, the restore command and the problem text"""
        for src, fixed in PAIRS:
            a, b = ast.parse(src.read_text()), ast.parse(fixed.read_text())
            fa = {n.name: ast.dump(n) for n in a.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
            fb = {n.name: ast.dump(n) for n in b.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
            self.assertEqual(set(fa), set(fb))
            self.assertEqual(sorted(k for k in fa if fa[k] != fb[k]), ["_verify"], fixed)

    def test_restore_is_foreground_exec_and_reaped_by_timeout(self):
        for src, fixed in PAIRS:
            old, new = restore_calls(src.read_text()), restore_calls(fixed.read_text())
            self.assertEqual(len(old), 1)
            self.assertEqual(len(new), 1)
            self.assertTrue(old[0].startswith('timeout -s KILL "$2" pg_restore'))
            self.assertTrue(new[0].startswith('exec timeout --foreground -s KILL "$2" pg_restore'))
            self.assertEqual(old[0].split("pg_restore", 1)[1], new[0].split("pg_restore", 1)[1])   # same pg_restore args

    def test_probe_requires_gnu_coreutils(self):
        for _, fixed in PAIRS:
            t = fixed.read_text()
            self.assertIn('node["pg_container"], "timeout", "--version"]', t)
            self.assertIn('"GNU coreutils" not in', t)
            self.assertNotIn('"command -v timeout"', t)

    def test_no_new_server_side_kill_or_force(self):
        for src, fixed in PAIRS:
            for word in ("pg_terminate_backend", "pg_cancel_backend", "WITH (FORCE)", "FORCE"):
                self.assertEqual(src.read_text().count(word), fixed.read_text().count(word), word)


class Repro(unittest.TestCase):
    src = (DIAG / "repro.py").read_text()

    def test_docker_targets_only_own_container(self):
        """every docker exec/logs/inspect names lab.c / self.c (this run's container); no rm/kill/stop outside c2fx"""
        self.assertEqual(len(re.findall(r'"docker", "exec"', self.src)), len(re.findall(r'"docker", "exec"[^\n]*?\b(?:self\.lab\.c|self\.c|lab\.c)\b', self.src)))
        for verb in ('"rm"', '"kill"', '"stop"', '"volume", "rm"', "--network", "0.0.0.0"):
            self.assertNotIn(verb, self.src, verb)
        self.assertIn('"--pull", "never"', self.src)
        self.assertIn('"127.0.0.1::5432"', self.src)

    def test_terminate_only_own_session_by_pid_and_token(self):
        self.assertEqual(self.src.count("pg_terminate_backend"), 1)
        self.assertRegex(self.src, r"pg_terminate_backend\(pid\) FROM pg_stat_activity WHERE pid = \{int\(self\.pid\)\} \"\n\s+f\"AND application_name = '\{self\.token\}'")

    def test_barrier_removed_and_scoped(self):
        self.assertIn("DROP EVENT TRIGGER IF EXISTS diag_barrier", self.src)
        self.assertRegex(self.src, r"finally:\n\s+try:\n\s+lab\.psql\(\"template1\", UNBARRIER\)")
        self.assertIn(r"current_database() NOT LIKE 'diagsrc\_verify\_%'", self.src)

    def test_expectations_are_fixed_before_the_run(self):
        self.assertIn('"E0a-r5-shape-timeout-KILL-on-sleep", "timeout -s KILL 2 sleep 30", True', self.src)
        self.assertIn('"E0b-fixed-shape-exec-timeout-foreground", "exec timeout --foreground -s KILL 2 sleep 30", False', self.src)
        self.assertIn('("E1-r5-controller-verify-backup-X3b-injection", r5, True)', self.src)
        self.assertIn('("E2-fixed-controller-verify-backup-X3b-injection", fixed, False)', self.src)
        self.assertIn('"E3-r5-shape-under-docker-init", "timeout -s KILL 2 sleep 30", False', self.src)
        self.assertIn('expect(res, "holder ended BY ITSELF at >= 35 s", True', self.src)
        self.assertIn("RESTORE_BOUND, BARRIER_SLEEP, HOLDER_SLEEP, SENTINEL_SLEEP = 20, 30, 40, 60", self.src)

    def test_queue_cap_and_c2fx_cleanup(self):
        self.assertIn("MAX_SCOPE = 768 * 1024 * 1024", self.src)
        self.assertIn("PG_MEM_MIB = 256", self.src)
        self.assertIn('out["cleanup"] = run.cleanup()', self.src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
