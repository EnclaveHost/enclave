#!/usr/bin/env python3
"""r2 evaluator tests. Fixture values are the rehearsal pins themselves, not production observations.
Negative control: root's repro inputs (work/root-storage-migration-review-20261022/repro.py) still yield the false READY
on the frozen r1 evaluator (negative-control/evaluate-before.py = 152fe44c), and never READY on r2."""
import importlib.util, json, pathlib, subprocess, sys, unittest
H = pathlib.Path(__file__).resolve().parent
def load(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
E = load("ev2", H / "evaluate-preflight.py")
OLD = load("ev1", H / "negative-control" / "evaluate-before.py")
FACTS = dict(E.EXPECT, **E.SESSION, **{
    "binary.is_symlink": "no", "releases_dir": "absent", "unit.dropins_dir": "absent", "unit.dropins": "",
    "config.stat": "600 enclave-indexd:enclave-indexd 980", "state.consensus_bytes": "536870912", "state.du_bytes": "561190789",
    "disk.var_lib_free_bytes": str(59 << 30), "disk.var_lib_total_bytes": str(63 << 30), "mem.available_mib": "3200", "mem.total_mib": "3900",
    "pg.inner_timeout": "/usr/bin/timeout", "pg.server_version": "18.6 (Debian 18.6-1.pgdg13+1)", "pg.synchronous_commit": "on",
    "db.size_bytes": "29832895", "db.count.objects": "1491", "db.count.slabs": "559", "db.count.contracts": "71", "db.count.accounts": "1"})
HEAD = {"preflight.version": "r2", "preflight.budget_s": "300", "db.count_cap": "100000"}

def capture(facts=None, drop=(), status=None, raw_extra=(), tail=True):
    facts = dict(FACTS, **(facts or {})); status = status or {}
    lines = [f"{k}={v}" for k, v in HEAD.items()]
    for k, v in facts.items():
        if k in drop: continue
        lines += [f"{k}={v}", f"{k}.status={status.get(k, 'ok')}"]
    lines += list(raw_extra)
    if tail: lines.append("preflight.complete=yes")
    return "\n".join(lines) + "\n"
def ev(text): return E.evaluate(*E.parse(text))

class Green(unittest.TestCase):
    def test_green_ready(self):
        r = ev(capture()); self.assertEqual(r["verdict"], "READY_FOR_FRESH_BACKUP", r)
    def test_boundary_free_equals_need_is_ready(self):
        need = 4 * (561190789 + 29832895) + (1 << 30)
        self.assertEqual(ev(capture({"disk.var_lib_free_bytes": str(need)}))["verdict"], "READY_FOR_FRESH_BACKUP")
        self.assertEqual(ev(capture({"disk.var_lib_free_bytes": str(need - 1)}))["verdict"], "BLOCKED")

class RootRepro(unittest.TestCase):
    CASES = [(c["key"], c["value"]) for c in json.loads((H / "negative-control" / "root-repro-result.json").read_text())]
    def test_old_evaluator_still_false_green(self):
        # the frozen r1 evaluator with root's exact green dict: every non-numeric case is (falsely) READY
        g = dict(OLD.EXPECT, **{"pg.synchronous_commit": "on", "config.stat": "600 enclave-indexd:enclave-indexd 980", "disk.var_lib_free_bytes": str(59 << 30),
                 "state.du_bytes": "561190789", "db.size_bytes": "29832895", "binary.is_symlink": "no", "releases_dir": "absent", "unit.dropins": "",
                 "db.count.objects": "1491", "db.count.slabs": "559", "db.count.contracts": "71", "pg.server_version": "18.6", "mem.available_mib": "3200", "digest.objects": "1491|abc"})
        got = [OLD.evaluate(dict(g, **{k: v}))["verdict"] for k, v in self.CASES]
        self.assertEqual(got, [c["verdict"] for c in json.loads((H / "negative-control" / "root-repro-result.json").read_text())])
        self.assertEqual(got.count("READY_FOR_FRESH_BACKUP"), 7)
    def test_new_evaluator_never_ready(self):
        for k, v in self.CASES:
            for st in ("ok", "rc:1", "timeout"):
                with self.subTest(k=k, v=v, st=st):
                    r = ev(capture({k: v}, status={k: st}))
                    self.assertIn(r["verdict"], ("UNKNOWN", "BLOCKED"), r)
                    self.assertTrue(any(k in u for u in r["unknown"]), r)

class Numeric(unittest.TestCase):
    BAD = ["", " 1", "1 ", "1.0", "1e9", "-0", "-1", "+1", "0x10", "NaN", "nan", "inf", "Infinity", "01", "١٢", "１２", "1_000", str(1 << 63), "9" * 25, "ERROR", "timeout", "unreadable"]
    def test_every_numeric_fact_rejects_malformed(self):
        for k in E.INTS:
            for v in self.BAD:
                with self.subTest(k=k, v=v):
                    r = ev(capture({k: v}))
                    self.assertNotEqual(r["verdict"], "READY_FOR_FRESH_BACKUP", r)
    def test_incoherent(self):
        for ch in [{"disk.var_lib_free_bytes": str(64 << 30)}, {"disk.var_lib_total_bytes": "0"}, {"mem.available_mib": "4000"}, {"mem.total_mib": "0"},
                   {"db.size_bytes": "0"}, {"state.du_bytes": "0"}, {"state.consensus_bytes": "561190790"}, {"state.consensus_bytes": "12x"},
                   {"app.fence_status": "000"}, {"app.fence_status": "0"}, {"app.fence_status": "999"}, {"db.count.objects": "100002"}]:
            with self.subTest(ch=ch):
                r = ev(capture(ch)); self.assertIn(r["verdict"], ("UNKNOWN", "BLOCKED"), r)
                if "app.fence_status" not in ch: self.assertEqual(r["verdict"], "UNKNOWN", r)
    def test_shas_must_be_sha(self):
        for k in E.SHAS:
            for v in ("ABC", "0" * 63, "g" * 64, "2D7A637E843500F7BD1864D76E1FA310E3163E57ADC5D8C19E43598E827DE5DC"):
                with self.subTest(k=k, v=v): self.assertEqual(ev(capture({k: v}))["verdict"], "UNKNOWN")

class Status(unittest.TestCase):
    def test_every_required_fact_failed_status_is_unknown(self):
        for k in E.NEED:
            for st in ("timeout", "rc:1", "rc:124", "empty", "malformed:multiline", "skipped:walltime-budget", "skipped:sql-degraded", "OK", ""):
                with self.subTest(k=k, st=st):
                    r = ev(capture(status={k: st})); self.assertEqual(r["verdict"], "UNKNOWN", r)
    def test_every_required_fact_missing_is_unknown(self):
        for k in E.NEED:
            with self.subTest(k=k): self.assertEqual(ev(capture(drop=(k,)))["verdict"], "UNKNOWN")
    def test_value_without_status_is_unknown(self):
        text = capture().replace("db.version.status=ok\n", "")
        self.assertEqual(ev(text)["verdict"], "UNKNOWN")
    def test_empty_ok_value_is_unknown_except_dropins(self):
        self.assertEqual(ev(capture({"db.schema_sha256": ""}))["verdict"], "UNKNOWN")
        self.assertEqual(ev(capture({"unit.dropins": ""}))["verdict"], "READY_FOR_FRESH_BACKUP")
    def test_session_bounds_must_be_proven(self):
        for k, v in [("pg.session.default_transaction_read_only", "off"), ("pg.session.statement_timeout", "0"), ("pg.session.lock_timeout", "0"),
                     ("pg.session.statement_timeout", "5min")]:
            with self.subTest(k=k, v=v): self.assertEqual(ev(capture({k: v}))["verdict"], "UNKNOWN")

class Parsing(unittest.TestCase):
    def test_duplicates_never_ready(self):
        for k, v in [("db.version", "26"), ("db.version", "27"), ("db.schema_sha256", FACTS["db.schema_sha256"]), ("db.version.status", "ok"), ("preflight.complete", "yes")]:
            with self.subTest(k=k, v=v):
                text = capture(raw_extra=[f"{k}={v}"]); r = ev(text); self.assertEqual(r["verdict"], "UNKNOWN", r)
                self.assertTrue(any("duplicate" in e for e in r["parseErrors"]), r)
    def test_duplicate_mismatch_still_unknown_not_last_wins(self):
        # r1 let the last duplicate win; r2 discards both, so a trailing forged value cannot make READY
        bad = capture({"db.version": "27"}, raw_extra=["db.version=26"])
        r = ev(bad); self.assertEqual(r["verdict"], "UNKNOWN"); self.assertIsNone(r["observed"]["db.version"])
    def test_malformed_lines(self):
        for extra in ["garbage", "=x", "Db.version=26", "db..version=26", "db.version =26", "x=\x00", "x=café", "x= padded", "x=y\r"]:
            with self.subTest(extra=extra): self.assertEqual(ev(capture(raw_extra=[extra]))["verdict"], "UNKNOWN")
        self.assertEqual(ev(capture().replace("\n", "\n\n", 1))["verdict"], "UNKNOWN")     # blank line
    def test_truncated_or_not_r2(self):
        self.assertEqual(ev(capture(tail=False))["verdict"], "UNKNOWN")
        self.assertEqual(ev(capture().replace("preflight.version=r2", "preflight.version=r1"))["verdict"], "UNKNOWN")
        self.assertEqual(ev(capture(raw_extra=["preflight.error=not-root"]))["verdict"], "UNKNOWN")
        self.assertEqual(ev("")["verdict"], "UNKNOWN")
        self.assertEqual(ev(capture()[: len(capture()) // 2])["verdict"], "UNKNOWN")
    def test_r1_output_shape_is_not_accepted(self):
        r1 = "\n".join(f"{k}={v}" for k, v in FACTS.items()) + "\n"     # no status keys, no header/trailer
        self.assertEqual(ev(r1)["verdict"], "UNKNOWN")
    def test_unexpected_keys_are_only_noted(self):
        r = ev(capture(raw_extra=["swap.total_kib=0", "swap.total_kib.status=ok", "zzz.new=1"]))
        self.assertEqual(r["verdict"], "READY_FOR_FRESH_BACKUP", r); self.assertTrue(any("zzz.new" in x for x in r["notes"]), r)

class Drift(unittest.TestCase):
    def test_count_decrease_is_review_not_loss(self):
        for t in E.REHEARSED_COUNTS:
            with self.subTest(t=t):
                r = ev(capture({f"db.count.{t}": "0"})); self.assertEqual(r["verdict"], "REVIEW_REQUIRED", r)
                text = json.dumps(r).lower(); self.assertIn("not proof of loss", text); self.assertNotIn("may have been lost", text)
    def test_increase_and_capped_are_notes(self):
        self.assertEqual(ev(capture({"db.count.objects": "5000"}))["verdict"], "READY_FOR_FRESH_BACKUP")
        r = ev(capture({"db.count.objects": "100001"})); self.assertEqual(r["verdict"], "READY_FOR_FRESH_BACKUP", r); self.assertTrue(any("capped" in n for n in r["notes"]))
    def test_review_does_not_hide_blockers_or_unknown(self):
        self.assertEqual(ev(capture({"db.count.objects": "1", "db.version": "27"}))["verdict"], "BLOCKED")
        self.assertEqual(ev(capture({"db.count.objects": "1"}, status={"db.schema_sha256": "timeout"}))["verdict"], "UNKNOWN")

class Blockers(unittest.TestCase):
    def test_drifts_block(self):
        for k, v in [("binary.path_sha256", "0" * 64), ("binary.path_sha256", "absent"), ("db.version", "27"), ("db.schema_sha256", "1" * 64), ("pg.fsync", "off"),
                     ("pg.synchronous_commit", "off"), ("config.stat", "640 root:enclave-indexd 980"), ("config.stat", "absent"), ("config.stat", "600 a:b 0"),
                     ("app.fence_status", "401"), ("db.fence_columns", "5"), ("pg.container_config_image", "postgres:18"), ("geoip_sha256", "absent"),
                     ("state.consensus_bytes", "absent"), ("disk.var_lib_free_bytes", str(1 << 30)), ("unit.execstart", "path=/opt/enclave-indexd/releases/current/indexd"),
                     ("unit.active", "failed"), ("pg.running", "false"), ("allow_live_start", "absent"), ("db.tables", "34")]:
            with self.subTest(k=k, v=v): self.assertEqual(ev(capture({k: v}))["verdict"], "BLOCKED", (k, v))
    def test_parse_error_overrides_blocker(self):
        self.assertEqual(ev(capture({"db.version": "27"}, raw_extra=["junk"]))["verdict"], "UNKNOWN")

class Digest(unittest.TestCase):
    T = ["db_version", "accounts", "objects", "object_slabs", "object_events", "slabs", "slab_sectors", "account_slabs", "sharing_keys", "shared_objects", "blocked_objects", "contracts", "hosts"]
    def text(self, rows=None, status="ok", tail=True):
        rows = rows if rows is not None else [f"digest.{t}=" + ("26|" if t == "db_version" else "5|" + "a" * 32) for t in self.T]
        return "\n".join(["digest.version=r2", "digest.max_db_bytes=1000000000"] + rows + [f"digest.status={status}"] + (["digest.complete=yes"] if tail else [])) + "\n"
    def test_digest(self):
        self.assertEqual(E.evaluate_digest(self.text())["verdict"], "COMPLETE")
        for bad in [self.text(status="timeout"), self.text(tail=False), self.text(rows=[]), self.text(rows=["digest.objects=5|xyz"] * 13)]:
            self.assertEqual(E.evaluate_digest(bad)["verdict"], "UNKNOWN")

class Cli(unittest.TestCase):
    def run_cli(self, data, *flags):
        f = H / "cli.fixture"; f.write_bytes(data)
        try: return subprocess.run([sys.executable, str(H / "evaluate-preflight.py"), *flags, str(f)], capture_output=True).returncode
        finally: f.unlink()
    def test_exit_codes(self):
        self.assertEqual(self.run_cli(capture().encode()), 0)
        self.assertEqual(self.run_cli(capture({"db.version": "27"}).encode()), 1)
        self.assertEqual(self.run_cli(capture({"db.count.slabs": "3"}).encode()), 2)
        self.assertEqual(self.run_cli(capture(status={"db.version": "timeout"}).encode()), 3)
        self.assertEqual(self.run_cli(capture().encode() + b"x=\xff\n"), 3)
        self.assertEqual(subprocess.run([sys.executable, str(H / "evaluate-preflight.py"), str(H / "does-not-exist")], capture_output=True).returncode, 3)

if __name__ == "__main__": unittest.main()
