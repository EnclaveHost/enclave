#!/usr/bin/env python3
"""r4 evaluator tests: r3 b351d11e plus config.acl / config.path_components, with the r3 evaluator as the old negative control.
r3 evaluator tests (r2 c5d9a427 + the production config access model + root's live captures).
r2 evaluator tests. Fixture values are the rehearsal pins themselves, not production observations.
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
    "config.stat": "640 root:enclave-indexd 980", "config.ids": "0:999", "config.type": "regular file", "config.nlink": "1",
    "config.dir_stat": "755 0", "unit.user": "enclave-indexd", "unit.group": "enclave-indexd", "unit.supplementary_groups": "",
    "group.service": "gid=999 members=", "group.primary_users": "enclave-indexd",
    "config.acl": "absent", "config.path_components": "directory 755 0 /etc/enclave-indexd,directory 755 0 /etc,directory 755 0 /", "state.consensus_bytes": "536870912", "state.du_bytes": "561190789",
    "disk.var_lib_free_bytes": str(59 << 30), "disk.var_lib_total_bytes": str(63 << 30), "mem.available_mib": "3200", "mem.total_mib": "3900",
    "pg.inner_timeout": "/usr/bin/timeout", "pg.server_version": "18.6 (Debian 18.6-1.pgdg13+1)", "pg.synchronous_commit": "on",
    "db.size_bytes": "29832895", "db.count.objects": "1491", "db.count.slabs": "559", "db.count.contracts": "71", "db.count.accounts": "1"})
HEAD = {"preflight.version": "r4", "preflight.budget_s": "300", "db.count_cap": "100000"}

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
        self.assertEqual(ev(capture({"group.primary_users": ""}))["verdict"], "BLOCKED", "empty is a valid read; the model then blocks")
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
        self.assertEqual(ev(capture().replace("preflight.version=r4", "preflight.version=r1"))["verdict"], "UNKNOWN")
        self.assertEqual(ev(capture(raw_extra=["preflight.error=not-root"]))["verdict"], "UNKNOWN")
        self.assertEqual(ev("")["verdict"], "UNKNOWN")
        self.assertEqual(ev(capture()[: len(capture()) // 2])["verdict"], "UNKNOWN")
    def test_r1_output_shape_is_not_accepted(self):
        r1 = "\n".join(f"{k}={v}" for k, v in FACTS.items()) + "\n"     # no status keys, no header/trailer
        self.assertEqual(ev(r1)["verdict"], "UNKNOWN")
    def test_unexpected_keys_are_only_noted(self):
        r = ev(capture(raw_extra=["swap.total_kib=0", "swap.total_kib.status=ok", "zzz.new=1"]))
        self.assertEqual(r["verdict"], "READY_FOR_FRESH_BACKUP", r); self.assertTrue(any("zzz.new" in x for x in r["notes"]), r)
        self.assertFalse(any("swap.total_kib" in x for x in r["notes"]), "r3: informational keys the script emits are not 'unexpected'")

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
                     ("pg.synchronous_commit", "off"), ("config.stat", "640 root:root 980"), ("config.stat", "absent"), ("config.stat", "640 root:enclave-indexd 0"),
                     ("app.fence_status", "401"), ("db.fence_columns", "5"), ("pg.container_config_image", "postgres:18"), ("geoip_sha256", "absent"),
                     ("state.consensus_bytes", "absent"), ("disk.var_lib_free_bytes", str(1 << 30)), ("unit.execstart", "path=/opt/enclave-indexd/releases/current/indexd"),
                     ("unit.active", "failed"), ("pg.running", "false"), ("allow_live_start", "absent"), ("db.tables", "34")]:
            with self.subTest(k=k, v=v): self.assertEqual(ev(capture({k: v}))["verdict"], "BLOCKED", (k, v))
    def test_parse_error_overrides_blocker(self):
        self.assertEqual(ev(capture({"db.version": "27"}, raw_extra=["junk"]))["verdict"], "UNKNOWN")

LIVE = H.parents[3]      # work/: root's live captures, read-only
class AccessModel(unittest.TestCase):
    def test_production_model_ready(self):
        self.assertEqual(ev(capture())["verdict"], "READY_FOR_FRESH_BACKUP")
    def test_deviations_block(self):
        cases = [({"config.stat": "600 root:root 980"}, "blind chmod 0600"), ({"config.stat": "600 root:enclave-indexd 980"}, "blind chmod 0600"),
                 ({"config.stat": "640 enclave-indexd:enclave-indexd 980"}, "write access"), ({"config.stat": "660 root:enclave-indexd 980"}, "production access model"),
                 ({"config.stat": "644 root:enclave-indexd 980"}, "production access model"), ({"config.stat": "2640 root:enclave-indexd 980"}, "production access model"),
                 ({"config.stat": "640 root:users 980"}, "production access model"),
                 ({"config.type": "symbolic link"}, "regular file"), ({"config.nlink": "2"}, "hard links"), ({"config.ids": "1000:999"}, "owner uid"),
                 ({"config.ids": "0:1000"}, "gid 1000 != group"), ({"config.ids": "0:0", "group.service": "gid=0 members="}, "is gid 0"),
                 ({"group.service": "gid=999 members=steven"}, "supplementary members"), ({"group.service": "gid=999 members=a,b"}, "supplementary members"),
                 ({"group.primary_users": "enclave-indexd,other"}, "primary group"), ({"unit.user": "root"}, "unit runs"), ({"unit.group": "users"}, "unit runs"),
                 ({"unit.supplementary_groups": "docker"}, "SupplementaryGroups"), ({"config.dir_stat": "775 0"}, "/etc/enclave-indexd"),
                 ({"config.dir_stat": "755 1000"}, "/etc/enclave-indexd")]
        for ch, want in cases:
            with self.subTest(ch=ch):
                r = ev(capture(ch)); self.assertEqual(r["verdict"], "BLOCKED", r); self.assertTrue(any(want in b for b in r["blockers"]), r)
    def test_access_facts_required(self):
        for k in E.ACCESS:
            with self.subTest(k=k):
                self.assertEqual(ev(capture(drop=(k,)))["verdict"], "UNKNOWN")
                self.assertEqual(ev(capture(status={k: "rc:2"}))["verdict"], "UNKNOWN")
        for ch in [{"group.service": "999"}, {"group.service": "gid=999"}, {"group.service": "gid=0999 members="}, {"group.service": "gid=999 members=Bad"},
                   {"config.ids": "0"}, {"config.ids": "root:999"}, {"config.dir_stat": "755"}, {"config.dir_stat": "rwx 0"}]:
            with self.subTest(ch=ch): self.assertEqual(ev(capture(ch))["verdict"], "UNKNOWN")
    def test_root_live_captures(self):
        # root's actual live outputs, read-only. r2 run: every SQL read failed (role "root") -> UNKNOWN, never READY.
        r = E.evaluate(*E.parse((LIVE / "root-storage-live-preflight-20261022" / "preflight.out").read_bytes()))
        self.assertEqual(r["verdict"], "UNKNOWN"); self.assertTrue(any('role "root" does not exist' in u for u in r["unknown"]), r["unknown"][:3])
        # root's corrected run: with the r3 evaluator, 0640 root:enclave-indexd is no longer a blocker; only the r3 access facts are missing
        live = (LIVE / "root-storage-live-preflight-r3-20261022" / "preflight.out").read_bytes()
        r = E.evaluate(*E.parse(live))
        self.assertEqual((r["verdict"], r["blockers"], r["review"], r["parseErrors"]), ("UNKNOWN", [], [], []), r)
        self.assertEqual(sorted(u.split(":")[0] for u in r["unknown"] if u.endswith("not reported")), sorted(E.ACCESS))   # all 11 r4 access facts
        self.assertFalse(any("unexpected keys" in n for n in r["notes"]), r["notes"])
        # HYPOTHETICAL (fixture facts, NOT live observations): if the r3 metadata reads match the production model, that capture is READY
        extra = "".join(f"{k}={FACTS[k]}\n{k}.status=ok\n" for k in E.ACCESS).encode()
        hyp = live.replace(b"preflight.complete=yes\n", extra + b"preflight.complete=yes\n")
        self.assertEqual(E.evaluate(*E.parse(hyp))["verdict"], "READY_FOR_FRESH_BACKUP")

OLD3 = load("ev3", H.parents[1] / "storage-migration-r3" / "preflight" / "evaluate-preflight.py")      # r3 fcf2177d, old negative control
class R4PathAndAcl(unittest.TestCase):
    def test_acl(self):
        self.assertEqual(ev(capture({"config.acl": "unsupported"}))["verdict"], "READY_FOR_FRESH_BACKUP")
        r = ev(capture({"config.acl": "present"})); self.assertEqual(r["verdict"], "BLOCKED"); self.assertTrue(any("POSIX access ACL" in b for b in r["blockers"]), r)
        for v in ("yes", "Present", "absent,present"):
            with self.subTest(v=v): self.assertEqual(ev(capture({"config.acl": v}))["verdict"], "UNKNOWN")
    def test_components(self):
        base = "directory 755 0 /etc/enclave-indexd,directory 755 0 /etc,directory 755 0 /"
        root_as = lambda m: base[:-len("755 0 /")] + m + " 0 /"
        ok = [base, base.replace("755 0 /etc,", "1777 0 /etc,"), root_as("555")]
        bad = [(base.replace("directory 755 0 /etc/enclave-indexd", "symbolic link 777 0 /etc/enclave-indexd"), "not a directory"),
               (base.replace("directory 755 0 /etc,", "symbolic link 777 0 /etc,"), "not a directory"),
               (base.replace("755 0 /etc/enclave-indexd", "775 0 /etc/enclave-indexd"), "config directory"),
               (base.replace("755 0 /etc/enclave-indexd", "1777 0 /etc/enclave-indexd"), "config directory"),   # sticky is NOT allowed for the config dir itself
               (base.replace("755 0 /etc/enclave-indexd", "755 994 /etc/enclave-indexd"), "config directory"),
               (base.replace("755 0 /etc,", "777 0 /etc,"), "ancestor /etc"), (base.replace("755 0 /etc,", "1777 994 /etc,"), "ancestor /etc"),
               (base.replace("755 0 /etc,", "755 1000 /etc,"), "ancestor /etc"), (root_as("775"), "ancestor / ")]
        for v in ok:
            with self.subTest(ok=v): self.assertEqual(ev(capture({"config.path_components": v}))["verdict"], "READY_FOR_FRESH_BACKUP", v)
        for v, want in bad:
            with self.subTest(bad=v):
                r = ev(capture({"config.path_components": v})); self.assertEqual(r["verdict"], "BLOCKED", (v, r)); self.assertTrue(any(want in b for b in r["blockers"]), (want, r["blockers"]))
        for v in ["directory 755 0 /etc,directory 755 0 /", base + ",directory 755 0 /x", "directory 755 0 /etc/enclave-indexd", base.replace(" 0 /etc,", " root /etc,"), "",
                  base.replace("directory 755 0 /etc,", "directory 0755 0 /etc,directory 755 0 /etc,")]:
            with self.subTest(unk=v): self.assertEqual(ev(capture({"config.path_components": v}))["verdict"], "UNKNOWN", v)
    def test_old_r3_evaluator_negative_control(self):
        # the r3 evaluator never looks at these facts: an ACL or a symlinked config directory in an r4 capture is still READY there
        for ch in ({"config.acl": "present"}, {"config.path_components": "symbolic link 777 0 /etc/enclave-indexd,directory 755 0 /etc,directory 755 0 /"},
                   {"config.path_components": "directory 755 0 /etc/enclave-indexd,directory 777 0 /etc,directory 755 0 /"}):
            with self.subTest(ch=ch):
                text = capture(ch).replace("preflight.version=r4", "preflight.version=r3")
                self.assertEqual(OLD3.evaluate(*OLD3.parse(text))["verdict"], "READY_FOR_FRESH_BACKUP", "r3 gap (old negative control)")
                self.assertEqual(ev(capture(ch))["verdict"], "BLOCKED")
    def test_root_fresh_r3_capture_and_extra_metadata(self):
        live = (LIVE / "root-storage-live-preflight-r4-20261022" / "preflight.out").read_bytes()
        self.assertEqual(OLD3.evaluate(*OLD3.parse(live))["verdict"], "READY_FOR_FRESH_BACKUP", "root's fresh r3 read, r3 evaluator")
        r = E.evaluate(*E.parse(live))
        self.assertEqual((r["verdict"], r["blockers"]), ("UNKNOWN", []))
        self.assertEqual(sorted(u.split(":")[0] for u in r["unknown"] if u.endswith("not reported")), ["config.acl", "config.path_components"])
        # CROSS-CAPTURE (not a consolidated READY): root's separate metadata read, rendered in r4 form, closes exactly those two facts
        md = json.loads((LIVE / "root-storage-access-extra-20261022" / "metadata.json").read_text())
        comps = ",".join(f"{c['type']} {int(c['mode'], 8):o} {c['uid']} {c['path']}" for c in md["components"])
        self.assertEqual(comps, FACTS["config.path_components"])
        extra = f"config.acl={md['configAcl']}\nconfig.acl.status=ok\nconfig.path_components={comps}\nconfig.path_components.status=ok\n".encode()
        self.assertEqual(E.evaluate(*E.parse(live.replace(b"preflight.complete=yes\n", extra + b"preflight.complete=yes\n")))["verdict"], "READY_FOR_FRESH_BACKUP")

class Digest(unittest.TestCase):
    T = ["db_version", "accounts", "objects", "object_slabs", "object_events", "slabs", "slab_sectors", "account_slabs", "sharing_keys", "shared_objects", "blocked_objects", "contracts", "hosts"]
    def text(self, rows=None, status="ok", tail=True):
        rows = rows if rows is not None else [f"digest.{t}=" + ("26|" if t == "db_version" else "5|" + "a" * 32) for t in self.T]
        return "\n".join(["digest.version=r3", "digest.max_db_bytes=1000000000"] + rows + [f"digest.status={status}"] + (["digest.complete=yes"] if tail else [])) + "\n"
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
