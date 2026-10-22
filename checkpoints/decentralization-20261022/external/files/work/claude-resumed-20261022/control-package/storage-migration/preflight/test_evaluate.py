#!/usr/bin/env python3
"""Fixture tests of evaluate-preflight.py: a rehearsal-matching state is READY; each drift is BLOCKED; missing evidence is
UNKNOWN (never READY). Fixture values are the rehearsal pins themselves, not production observations."""
import importlib.util, pathlib, subprocess, unittest
H = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ev", H / "evaluate-preflight.py"); E = importlib.util.module_from_spec(spec); spec.loader.exec_module(E)
GREEN = dict(E.EXPECT, **{"pg.synchronous_commit": "on", "config.stat": "600 enclave-indexd:enclave-indexd 980", "disk.var_lib_free_bytes": str(59 << 30),
        "state.du_bytes": "561190789", "db.size_bytes": "29832895", "binary.is_symlink": "no", "releases_dir": "absent", "unit.dropins": "",
        "db.count.objects": "1491", "db.count.slabs": "559", "db.count.contracts": "71", "pg.server_version": "18.6 (Debian 18.6-1.pgdg13+1)", "mem.available_mib": "3200",
        "digest.objects": "1491|abc"})
class T(unittest.TestCase):
    def ev(self, **ch):
        kv = dict(GREEN); kv.update(ch); return E.evaluate({k: v for k, v in kv.items() if v is not None})
    def test_green(self):
        # unit.dropins is legitimately empty: the evaluator must not count an empty drop-in list as missing evidence
        r = self.ev(); self.assertEqual(r["verdict"], "READY_FOR_FRESH_BACKUP", r)
    def test_drifts_block(self):
        for k, v in [("binary.path_sha256", "0" * 64), ("db.version", "27"), ("db.schema_sha256", "1" * 64), ("pg.fsync", "off"), ("pg.synchronous_commit", "off"),
                     ("config.stat", "640 root:enclave-indexd 980"), ("db.count.objects", "1000"), ("app.fence_status", "401"), ("db.fence_columns", "5"),
                     ("pg.container_config_image", "postgres:18"), ("geoip_sha256", "absent"), ("disk.var_lib_free_bytes", str(1 << 30)), ("unit.execstart", "path=/opt/enclave-indexd/releases/current/indexd")]:
            with self.subTest(k): self.assertEqual(self.ev(**{k: v})["verdict"], "BLOCKED", (k, v))
    def test_missing_is_unknown(self):
        for k in ("db.schema_sha256", "pg.synchronous_commit", "config.stat", "binary.path_sha256"):
            with self.subTest(k): self.assertEqual(self.ev(**{k: None})["verdict"], "UNKNOWN", k)
    def test_cli_and_script_syntax(self):
        self.assertEqual(subprocess.run(["bash", "-n", str(H / "vm-preflight.sh")]).returncode, 0)
        f = H / "green.fixture"; f.write_text("\n".join(f"{k}={v}" for k, v in GREEN.items()) + "\n")
        try: self.assertEqual(subprocess.run(["python3", str(H / "evaluate-preflight.py"), str(f)], capture_output=True).returncode, 0)
        finally: f.unlink()
if __name__ == "__main__": unittest.main()
