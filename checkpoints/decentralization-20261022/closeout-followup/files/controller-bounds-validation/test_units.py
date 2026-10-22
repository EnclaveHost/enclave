#!/usr/bin/env python3
"""test_units.py - cheap, no-PostgreSQL checks of the bounds delta in BOTH bounded controllers.
Covered:
- the GNU-timeout guard refuses before anything stops;
- the systemctl host timeouts;
- secs();
- the shape of the psql/pg_dump commands;
- the runId in die().
subprocess.run is stubbed in the loaded module only; nothing outside the temp dir is touched.
    python3 -B -u test_units.py -v"""
import contextlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
COPIES = {"production": HERE / "frozen/replicactl.r5-production.restorefix.bounds.py",
          "fixture": HERE / "derived/replicactl.fixture-r5.restorefix.bounds.py"}


def load(name):
    sp = importlib.util.spec_from_file_location(f"ctl_{name}", COPIES[name])
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    return m


class Stub:
    """records every subprocess.run call; answers by the first matching rule"""

    def __init__(self, rules):
        self.rules, self.calls = rules, []

    def __call__(self, args, **kw):
        self.calls.append((list(args), kw))
        for pred, rc, out in self.rules:
            if pred(args):
                return subprocess.CompletedProcess(args, rc, out.encode(), b"")
        return subprocess.CompletedProcess(args, 0, b"", b"")


GNU = (lambda a: a[-2:] == ["timeout", "--version"], 0, "timeout (GNU coreutils) 9.7\n")


class Bounds(unittest.TestCase):
    def setUp(self):
        self.real_run = subprocess.run          # each copy's `subprocess` IS this module: always restore the real run
        self.t = tempfile.TemporaryDirectory(dir=HERE)
        d = Path(self.t.name)
        (d / "allow").write_text("")
        (d / "backups").mkdir()
        self.prof = d / "profile.json"
        self.prof.write_text(json.dumps({"runner": "systemd", "unit": "enclave-indexd", "pg_container": "pgc", "database": "indexd",
                                         "allow_file": str(d / "allow"), "release_dir": str(d / "rel"), "state_dir": str(d),
                                         "backup_dir": str(d / "backups"), "migration_dir": str(d), "psql_timeout_seconds": 300}))

    def tearDown(self):
        subprocess.run = self.real_run
        self.t.cleanup()

    def each(self):
        for name in COPIES:
            with self.subTest(copy=name):
                yield name, load(name)
            subprocess.run = self.real_run

    def call(self, m, fn, *a):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                fn(*a)
                code = None
            except SystemExit as e:
                code = e.code
        return code, out.getvalue()

    def test_guard_refuses_without_gnu_timeout_before_any_stop(self):
        for name, m in self.each():
            for answer in ((lambda a: a[-2:] == ["timeout", "--version"], 0, "BusyBox v1.36.1 (2024-06-10) multi-call binary.\n"),
                           (lambda a: a[-2:] == ["timeout", "--version"], 127, "")):
                st = Stub([answer])
                m.subprocess.run = st
                node = m.Node(self.prof)
                for action, extra in (("upgrade", {"sha256": "ab" * 32}), ("upgrade-c2", {"sha256": "ab" * 32}),
                                      ("rollback", {"stock_sha256": "ab" * 32, "fenced_writers_stopped": True}),
                                      ("rollback-c2", {"fence_sha256": "ab" * 32, "cas_writers_stopped": True, "acknowledge_cas_downgrade": False})):
                    args = type("A", (), dict(confirm=action, **extra))()
                    fn = {"upgrade": m.cmd_upgrade, "upgrade-c2": m.cmd_upgrade_c2, "rollback": m.cmd_rollback, "rollback-c2": m.cmd_rollback_c2}[action]
                    code, out = self.call(m, fn, node, args)
                    self.assertEqual(code, 2, (action, out))
                    j = json.loads(out.strip().splitlines()[-1])
                    self.assertIn("no GNU coreutils `timeout`", j["error"])
                    self.assertRegex(j["runId"], r"^[0-9a-f]{16}$")
                self.assertFalse([c for c, _ in st.calls if c[:1] == ["systemctl"]], "nothing stopped or started")

    def test_guard_passes_with_gnu_and_install_is_not_gated(self):
        for name, m in self.each():
            st = Stub([GNU])
            m.subprocess.run = st
            node = m.Node(self.prof)
            code, out = self.call(m, m.cmd_upgrade, node, type("A", (), {"confirm": "upgrade", "sha256": "ab" * 32})())
            self.assertIn("release not installed", json.loads(out.strip().splitlines()[-1])["error"])   # got past the guard
            st2 = Stub([])
            m.subprocess.run = st2
            m.guard(node, "install", type("A", (), {"confirm": "install"})())
            self.assertEqual(st2.calls, [], "install: no container probe")

    def test_systemctl_calls_have_host_timeouts(self):
        for name, m in self.each():
            st = Stub([])
            m.subprocess.run = st
            node = m.Node(self.prof)
            node.running(); node.start(); node.stop(); node.stop(timeout=10)
            got = [(c[1], kw.get("timeout")) for c, kw in st.calls]
            self.assertEqual(got, [("is-active", 30), ("start", 120), ("stop", 240), ("stop", 70)])

    def test_secs_never_zero(self):
        for name, m in self.each():
            self.assertEqual([m.secs(x) for x in (0, 0.01, 0.2, 1, 1.0, 1.01, 119.4, 300)], [1, 1, 1, 1, 1, 2, 120, 300])

    def test_psql_and_dump_shapes(self):
        for name, m in self.each():
            st = Stub([(lambda a: "psql" in a, 0, "1\n")])
            m.subprocess.run = st
            node = m.Node(self.prof)
            node.psql("SELECT 1;", timeout=0.3)
            node.psql("SELECT 1;")
            node.psql_rc("SELECT 1;", timeout=7.2)
            tag = f"PGAPPNAME=replicactl-{m.RUN_ID}"
            for (args, kw), t in zip(st.calls, (1, 300, 8)):
                self.assertEqual(args[:7], ["docker", "exec", "-i", "-e", tag, "-e", f"PGOPTIONS=-c statement_timeout={t * 1000} -c lock_timeout=30000"])
                self.assertTrue(args[10].startswith('exec timeout --foreground -s KILL "$2" psql -U '), args[10])
                self.assertEqual(args[-1], str(t))
            self.assertEqual([kw["timeout"] for _, kw in st.calls], [16, 315, 7.2 + 15])
            # cmd_backup: pg_dump bounded in the container + host, tagged; a host timeout dies without a manifest
            bdir = self.prof.with_name(f"backups-{name}"); bdir.mkdir()       # one per copy (backup names are per second)
            prof = json.loads(self.prof.read_text()); prof.update(runner="process", dump_timeout_seconds=4, backup_dir=str(bdir))
            p2 = self.prof.with_name(f"p2-{name}.json"); p2.write_text(json.dumps(prof))
            node = m.Node(p2)

            def hang(args, **kw):
                st.calls.append((list(args), kw))
                raise subprocess.TimeoutExpired(args, kw.get("timeout"))
            st.calls.clear()
            m.subprocess.run = hang
            code, out = self.call(m, m.cmd_backup, node, None)
            a, kw = st.calls[0]
            self.assertEqual(a[:5], ["docker", "exec", "-e", f"PGAPPNAME=replicactl-{m.RUN_ID}", "pgc"])
            self.assertTrue(a[7].startswith('exec timeout --foreground -s KILL "$2" pg_dump -U ') and "--lock-wait-timeout=30000" in a[7])
            self.assertEqual((a[-1], kw["timeout"]), ("4", 64))
            self.assertEqual(code, 2)
            self.assertIn("pg_dump did not answer within 64 s", json.loads(out.strip().splitlines()[-1])["error"])
            self.assertEqual(list(Path(prof["backup_dir"]).glob("*/manifest.json")), [], "an incomplete backup never gets a manifest")

    def test_run_id_announced_on_stderr(self):
        for name, path in COPIES.items():
            with self.subTest(copy=name):
                r = subprocess.run([sys.executable, "-B", str(path), "--profile", str(self.prof), "install", "/nonexistent",
                                    "--sha256", "ab" * 32, "--confirm", "nope"], capture_output=True, text=True, timeout=60)
                first = json.loads(r.stderr.splitlines()[0])
                self.assertRegex(first["runId"], r"^[0-9a-f]{16}$")
                self.assertEqual(first["pgApplicationName"], "replicactl-" + first["runId"])
                self.assertEqual(json.loads(r.stdout.strip().splitlines()[-1])["runId"], first["runId"])


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    unittest.main()
