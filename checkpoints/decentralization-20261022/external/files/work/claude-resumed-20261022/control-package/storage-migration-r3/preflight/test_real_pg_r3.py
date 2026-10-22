#!/usr/bin/env python3
"""r3 against the REAL official image, pinned 74935e72 (local copy, --pull never, --network none, --memory 192m, tmpfs).
Toy schema, no production data, containers removed at the end.
  ProdLike: started like work/storage-vm/enclave-indexd-postgres.service:
    - env file with POSTGRES_PASSWORD, POSTGRES_DB=indexd and PGDATA only, so POSTGRES_USER is UNSET;
    - --read-only, with tmpfs for /var/lib/postgresql, /var/run/postgresql and /tmp.
    Checks:
    - r2 helpers fail as in root's live run (role "root");
    - r3 helpers connect as postgres with the read-only/5s/1s session, a write is refused, and the schema hash works;
    - the r3 controller copy's status/backup/verify-backup/digest work (psql, pg_dump, pg_restore paths);
    - the original ce63951e controller fails backup and status.
  FixtureLike: POSTGRES_USER=indexd is set. The r3 preflight and controller use that role unchanged."""
import json, os, pathlib, secrets, subprocess, sys, tempfile, time, unittest
H = pathlib.Path(__file__).resolve().parent
R3, R2 = H / "vm-preflight.sh", H.parents[1] / "storage-migration-r2" / "preflight" / "vm-preflight.sh"
CTL3 = H.parent / "controller" / "replicactl.py"
CTL0 = H.parents[3] / "indexd-c2-implementation" / "package" / "controller" / "replicactl.py"     # ce63951e, read-only
PIN = "sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336"
SETUP = """CREATE TABLE global_settings (db_version int); INSERT INTO global_settings VALUES (26);
CREATE TABLE accounts (id bigserial PRIMARY KEY); INSERT INTO accounts DEFAULT VALUES;
CREATE TABLE objects (id bigserial PRIMARY KEY, account_id bigint REFERENCES accounts(id)); INSERT INTO objects (account_id) SELECT 1 FROM generate_series(1, 1491);
CREATE TABLE slabs (id bigserial PRIMARY KEY); INSERT INTO slabs SELECT FROM generate_series(1, 562);
CREATE TABLE contracts (id bigserial PRIMARY KEY); INSERT INTO contracts SELECT FROM generate_series(1, 78);"""
TOY_DIGEST = ("SELECT 'db_version|' || db_version || '|' FROM global_settings;\n"
              "SELECT 'objects|' || count(*) || '|' || coalesce(md5(string_agg(id || ',' || account_id, E'\\n' ORDER BY id)), '') FROM objects;\n"
              "SELECT 'slabs|' || count(*) || '|' || coalesce(md5(string_agg(id::text, E'\\n' ORDER BY id)), '') FROM slabs;\n")

def sh(*a, **k): return subprocess.run(list(a), capture_output=True, text=True, timeout=k.pop("timeout", 120), **k)

class Base:
    ENV = {}
    @classmethod
    def setUpClass(cls):
        if sh("docker", "image", "inspect", "-f", "{{.Id}}", "postgres:18.6").stdout.strip() != PIN: raise unittest.SkipTest("pinned image not local")
        cls.name = f"pf-r3-{cls.__name__.lower()}-{os.getpid()}"
        cls.tmp = tempfile.TemporaryDirectory(prefix="pf-r3-pg-"); envf = pathlib.Path(cls.tmp.name) / "postgres.env"
        envf.write_text("".join(f"{k}={v}\n" for k, v in cls.ENV.items())); os.chmod(envf, 0o600)
        r = sh("docker", "run", "-d", "--rm", "--pull", "never", "--network", "none", "--memory", "192m", "--name", cls.name, "--read-only",
               "--env-file", str(envf), "--tmpfs", "/var/lib/postgresql:rw,size=256m", "--tmpfs", "/var/run/postgresql:rw,size=16m", "--tmpfs", "/tmp:rw,size=64m",
               PIN, "postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=20")
        assert r.returncode == 0, r.stderr
        cls.su = cls.ENV.get("POSTGRES_USER", "postgres")
        for _ in range(80):
            if cls.admin("SELECT 1").stdout.strip() == "1": break
            time.sleep(0.5)
        else: raise RuntimeError("test postgres did not start: " + sh("docker", "logs", cls.name).stderr[-400:])
        assert cls.admin(SETUP).returncode == 0
    @classmethod
    def tearDownClass(cls):
        sh("docker", "rm", "-f", cls.name); cls.tmp.cleanup()
    @classmethod
    def admin(cls, sql, db="indexd"):
        return sh("docker", "exec", cls.name, "psql", "-U", cls.su, "-d", db, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", sql)
    def driver(self, script, body):
        p = sh("bash", "-c", f'. "$0"; PG={self.name}; SECONDS=0; {body}', str(script), env={"PREFLIGHT_SOURCE_ONLY": "1", "PATH": os.environ["PATH"]})
        return dict(l.partition("=")[::2] for l in p.stdout.splitlines())
    def ctl(self, ctl, *args, backups="backups"):
        d = pathlib.Path(self.tmp.name); (d / "state").mkdir(exist_ok=True); (d / backups).mkdir(exist_ok=True, mode=0o700); (d / "mig").mkdir(exist_ok=True)
        (d / "mig" / "digest.sql").write_text(TOY_DIGEST); (d / "state" / "consensus.db").write_bytes(b"toy")
        prof = d / "profile.json"
        prof.write_text(json.dumps({"runner": "process", "pg_container": self.name, "database": "indexd", "state_dir": str(d / "state"),
                                    "release_dir": str(d / "state"), "backup_dir": str(d / backups), "migration_dir": str(d / "mig")}))
        r = sh(sys.executable, "-B", str(ctl), "--profile", str(prof), *args)
        try: out = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError): out = {"raw": r.stdout[-300:], "stderr": r.stderr[-300:]}
        return r.returncode, out
    R3_BODY = """fact pg.inner_timeout "$T_META" r_inner_timeout && INNER_TIMEOUT=1
      sqlfact ro 'SHOW default_transaction_read_only'; sqlfact st 'SHOW statement_timeout'; sqlfact lt 'SHOW lock_timeout'
      sqlfact who 'SELECT current_user'; sqlfact db.version 'SELECT db_version FROM global_settings'
      sqlfact db.count.objects "SELECT count(*) FROM (SELECT 1 FROM objects LIMIT $((COUNT_CAP + 1))) s"
      sqlfact w 'CREATE TABLE x (i int)'; fact db.schema_sha256 "$T_DUMP" r_schema"""

class ProdLike(Base, unittest.TestCase):
    ENV = {"POSTGRES_PASSWORD": secrets.token_urlsafe(24), "POSTGRES_DB": "indexd", "PGDATA": "/var/lib/postgresql/data"}
    def test_1_condition_is_production_shaped(self):
        self.assertEqual(sh("docker", "exec", self.name, "sh", "-c", 'echo "${POSTGRES_USER-unset}:$(id -un)"').stdout.strip(), "unset:root")
    def test_2_r2_fails_like_live(self):
        kv = self.driver(R2, self.R3_BODY)
        for k in ("ro", "who", "db.version", "db.count.objects"):
            self.assertEqual(kv[k + ".status"], "rc:2", kv); self.assertIn('role "root" does not exist', kv[k + ".err"])
        self.assertNotEqual(kv["db.schema_sha256.status"], "ok"); self.assertEqual(kv["db.schema_sha256"], "")
    def test_3_r3_reads_as_postgres_read_only(self):
        kv = self.driver(R3, self.R3_BODY)
        for k, v in [("pg.inner_timeout", "/usr/bin/timeout"), ("ro", "on"), ("st", "5s"), ("lt", "1s"), ("who", "postgres"), ("db.version", "26"), ("db.count.objects", "1491")]:
            self.assertEqual((kv.get(k), kv.get(k + ".status")), (v, "ok"), (k, kv))
        self.assertTrue(kv["w.status"].startswith("rc:")); self.assertIn("read-only transaction", kv["w.err"])
        self.assertEqual(kv["db.schema_sha256.status"], "ok"); self.assertRegex(kv["db.schema_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(self.admin("SELECT count(*) FROM pg_tables WHERE tablename = 'x'").stdout.strip(), "0")
    def test_4_r3_controller_psql_pg_dump_pg_restore(self):
        rc, st = self.ctl(CTL3, "status"); self.assertEqual((rc, st.get("dbVersion")), (0, 26), st)
        rc, d = self.ctl(CTL3, "digest"); self.assertEqual(rc, 0, d); self.assertEqual(d["digest"]["objects"]["rows"], 1491)
        rc, b = self.ctl(CTL3, "backup"); self.assertEqual((rc, b.get("ok"), b.get("dbVersion")), (0, True, 26), b)
        bdir = pathlib.Path(b["backup"]); m = json.loads((bdir / "manifest.json").read_text())
        self.assertGreater(m["files"]["indexd.pgdump"]["bytes"], 1000); self.assertEqual(m["digest"], d["digest"])
        rc, v = self.ctl(CTL3, "verify-backup", str(bdir)); self.assertEqual((rc, v.get("ok"), v.get("digestMatches"), v.get("restoredDbVersion")), (0, True, True, 26), v)
        self.assertEqual(self.admin("SELECT count(*) FROM pg_database WHERE datname = 'indexd_verify'", db="postgres").stdout.strip(), "0", "scratch database dropped")
    def test_5_original_controller_fails(self):
        rc, b = self.ctl(CTL0, "backup", backups="backups-ce63951e"); self.assertNotEqual(rc, 0); self.assertIn('role "root" does not exist', b.get("error", ""), b)
        rc, st = self.ctl(CTL0, "status"); self.assertNotEqual(rc, 0)

class FixtureLike(Base, unittest.TestCase):
    ENV = {"POSTGRES_USER": "indexd", "POSTGRES_PASSWORD": secrets.token_urlsafe(24), "POSTGRES_DB": "indexd", "PGDATA": "/var/lib/postgresql/data"}
    def test_set_role_is_used_unchanged(self):
        kv = self.driver(R3, self.R3_BODY)
        self.assertEqual((kv["who"], kv["ro"], kv["db.version"], kv["db.schema_sha256.status"]), ("indexd", "on", "26", "ok"), kv)
        rc, st = self.ctl(CTL3, "status"); self.assertEqual((rc, st.get("dbVersion")), (0, 26), st)
        rc, b = self.ctl(CTL3, "backup"); self.assertEqual((rc, b.get("ok")), (0, True), b)
        rc, v = self.ctl(CTL3, "verify-backup", b["backup"]); self.assertEqual((rc, v.get("ok")), (0, True), v)

if __name__ == "__main__": unittest.main()
