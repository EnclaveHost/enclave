#!/usr/bin/env python3
"""test_package.py - STATIC/LOCAL checks of the storage-enclave-fixture sources (no docker, no PostgreSQL, no indexd).
  python3 -u test/test_package.py -v"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
PKG = Path(__file__).resolve().parent.parent
REF = PKG / "ref"


def defs(path):
    """top-level functions/classes (methods flattened as Class.method) -> source"""
    t = ast.parse(path.read_text())
    out = {}
    for n in t.body:
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            out[n.name] = ast.unparse(n) if isinstance(n, ast.FunctionDef) else None
            if isinstance(n, ast.ClassDef):
                for m in n.body:
                    if isinstance(m, ast.FunctionDef):
                        out[f"{n.name}.{m.name}"] = ast.unparse(m)
    return out


class Package(unittest.TestCase):
    def test_every_stage_function_and_assertion_is_unchanged(self):
        old, new = defs(REF / "old-package/fixture/run_c2_fixture_test.py"), defs(PKG / "fixture/run_c2_fixture_test.py")
        self.assertEqual(set(old), set(new))
        changed = sorted(k for k in old if old[k] != new[k])
        self.assertEqual(changed, ["ctl"], "only ctl's controller path changed")
        self.assertEqual(old["ctl"].replace("str(root / 'controller' / 'replicactl.py')", "str(CONTROLLER)"), new["ctl"])
        stages = lambda p: re.findall(r'^stage\("([^"]+)", (\w+)\)$', p.read_text(), re.M)
        s_old, s_new = stages(REF / "old-package/fixture/run_c2_fixture_test.py"), stages(PKG / "fixture/run_c2_fixture_test.py")
        self.assertEqual(s_old, s_new); self.assertEqual(len(s_new), 8)
        self.assertEqual([n for n, _ in s_new], ["1-fence-release-v27-baseline-v3-writer", "2-quiesced-backup-and-restore-verify", "3-upgrade-to-c2-v28-not-enrolled",
                          "4-enrol-cas-replay-conflicts-refusals", "5-indexd-sigkill-restart-enrolment-durable", "6-rollback-refused-while-enrolled",
                          "7-rollback-acknowledged-schema-equals-v27", "8-re-upgrade-not-re-enrolled-then-re-enrol"])

    def test_controller_delta_is_the_process_runner_only(self):
        r4, fx = defs(REF / "r4/replicactl.r4.py"), defs(PKG / "controller/replicactl.py")
        changed = sorted(k for k in r4 if r4[k] != fx.get(k))
        self.assertEqual(changed, ["Node.pid", "Node.start", "Node.stop", "cmd_crash_indexd"])
        self.assertEqual(sorted(set(fx) - set(r4)), ["Node.signal_ours", "boot_id", "pidfd_wait", "proc_start"])
        # Node.start: only the runner=process branch changed; the systemd branch is the r4 text
        self.assertIn("subprocess.run(['systemctl', 'start', self['unit']], check=True)", fx["Node.start"])
        self.assertIn("subprocess.run(['systemctl', 'stop', self['unit']], check=True)", fx["Node.stop"])
        self.assertNotIn("os.kill(", (PKG / "controller/replicactl.py").read_text())

    def test_r4_controller_is_a_superset_of_the_old_package_controller_for_this_profile(self):
        old, r4 = defs(REF / "old-package/controller/replicactl.py"), defs(REF / "r4/replicactl.r4.py")
        changed = sorted(k for k in old if old[k] != r4.get(k))
        self.assertEqual(changed, ["Node.psql", "check_secret_modes", "cmd_backup", "cmd_verify_backup"])
        # psql/pg_dump/pg_restore: -U ${POSTGRES_USER:-postgres} == -U $POSTGRES_USER when the fixture sets POSTGRES_USER=indexd
        self.assertIn("POSTGRES_USER=indexd", (PKG / "fixture/run-c2-fixture.py").read_text())
        # check_secret_modes: the exception applies only with profile key config_file_access, which the fixture never writes
        self.assertNotIn("config_file_access", (PKG / "fixture/make-fixture-node.py").read_text())

    def test_node_config_is_loopback_isolated_and_keeps_enclave_small_defaults(self):
        t = Path(tempfile.mkdtemp(prefix="c2fx-node-"))
        try:
            (t / "secrets").mkdir(mode=0o700)
            (t / "secrets/postgres.env").write_text("POSTGRES_USER=indexd\nPOSTGRES_PASSWORD=dummy\nPOSTGRES_DB=indexd\n")
            fence = t / "fake-indexd"; fence.write_text("#!/bin/sh\necho 'Recovery Phrase: alpha beta gamma'\n"); fence.chmod(0o755)
            geo = t / "geo.mmdb"; geo.write_bytes(b"dummy")
            env = dict(os.environ, C2FX_STAGE=str(t), C2FX_PORTS="41001,41002,41003", C2FX_PG_PORT="41004", C2FX_PG_CONTAINER="enclave-c2fx-x-pg",
                       C2FX_FENCE=str(fence), C2FX_GEOIP=str(geo), C2FX_MIGRATION_DIR=str(PKG / "migration"))
            r = subprocess.run([sys.executable, str(PKG / "fixture/make-fixture-node.py")], capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("dummy", r.stdout); self.assertNotIn("alpha", r.stdout)
            cfg = (t / "secrets/indexd.yml").read_text()
            self.assertEqual(oct((t / "secrets/indexd.yml").stat().st_mode & 0o777), "0o600")
            self.assertEqual(oct((t / "secrets/admin-password").stat().st_mode & 0o777), "0o600")
            addrs = re.findall(r"(?:address|advertiseURL|host): (\S+)", cfg)
            self.assertEqual(addrs, ["127.0.0.1:41001", "127.0.0.1:41003", "http://127.0.0.1:41003", "127.0.0.1:41002", "127.0.0.1"])
            for line in ("bootstrap: false", "enableUPnP: false", "peers: []", "enabled: false", "autoOpenWebUI: false", "port: 41004"):
                self.assertIn(line, cfg)
            for k in ("contract", "growth", "fund", "Timeout", "timeout", "maintenance"):
                self.assertNotIn(k, cfg, "no sizing/timeout override: the enclave-small compiled defaults apply")
            prof = json.loads((t / "fixture-profile.json").read_text())
            self.assertEqual(prof["pg_container"], "enclave-c2fx-x-pg"); self.assertEqual(prof["admin_url"], "http://127.0.0.1:41001/api")
            self.assertNotIn("config_file_access", prof)
            # the same config template as the G-C2 package copy, ports aside
            tpl = lambda p: re.search(r'cfg = f"""(.*?)"""', p.read_text(), re.S).group(1)
            new = tpl(PKG / "fixture/make-fixture-node.py")
            for k, v in (("{admin_port}", "59990"), ("{syncer_port}", "59991"), ("{app_port}", "59992"), ("{pg_port}", "55434")):
                new = new.replace(k, v)
            self.assertEqual(new, tpl(REF / "old-package/fixture/make-fixture-node.py"))
        finally:
            shutil.rmtree(t)

    def test_runner_static_safety(self):
        src = (PKG / "fixture/run-c2-fixture.py").read_text() + (PKG / "fixture/c2fx.py").read_text()
        for bad in ("pkill", "killall", "ps -e", "os.kill(", "0.0.0.0", "docker system", "prune", "--network host", "shell=True"):
            self.assertNotIn(bad, src, bad)
        for need in ('"--pull", "never"', '"127.0.0.1::5432"', '"--memory"', 'GOPROXY="off"', 'GOFLAGS="-mod=readonly"', 'GOTOOLCHAIN="local"',
                     'GOCACHE=str(gocache)', "O_EXCL"):
            self.assertIn(need, src, need)
        self.assertNotRegex(src, r"rm\s+-rf")
        # processes: only this job's own cgroup.procs and the cleaner's own ancestry are read; no host-wide /proc enumeration
        for bad in ('Path("/proc").iterdir', "listdir('/proc'", 'listdir("/proc"', "glob('/proc", 'glob("/proc', "psutil", "pgrep"):
            self.assertNotIn(bad, src, bad)
        self.assertIn('read_procs(d)', src)
        # docker names always carry the run id
        self.assertIn('f"enclave-c2fx-{self.id}-pg"', src); self.assertIn('f"enclave-c2fx-{self.id}-pgdata"', src)

    def test_pins_point_at_the_new_binaries_and_matching_tree(self):
        src = (PKG / "fixture/run-c2-fixture.py").read_text()
        self.assertIn("c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568", src)
        self.assertIn("2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7", src)
        self.assertIn("d306f997a60105a17d06aea4f824a2d3134ab962936467a403b789de620b72df", src)
        for old in ("61413110", "e6e812fd", "indexd-replica-rollout/src", "indexd-v0.6.0-fence.1-linux-amd64"):
            self.assertNotIn(old, src + (PKG / "fixture/make-fixture-node.py").read_text())


if __name__ == "__main__":
    unittest.main()
