"""Local tests of activate_certs.py: every path is redirected into a temp dir, systemctl/journalctl are faked, and
`node --check` is real. Run: python3 -m unittest test_activate_certs (no network, no root, no remote)."""
import hashlib, io, json, os, shutil, tempfile, time, unittest
from contextlib import redirect_stdout
import activate_certs as A

HERE = os.path.dirname(os.path.abspath(__file__))
WO = os.path.abspath(os.path.join(HERE, "../../.."))
BASE = open(os.path.join(WO, "work/enclave/relay/certs.js"), "rb").read()
CAND = open(os.path.join(WO, "work/acme-retention/tree/relay/certs.js"), "rb").read()
sha = lambda b: hashlib.sha256(b).hexdigest()
REAL_RUN = A.run


class Rig:
    def __init__(self, t):
        self.t = t
        d = self.d = tempfile.mkdtemp(prefix="actcerts-")
        for sub in ("opt/nan-relay/node_modules/x", "etc/nan-relay", "etc/systemd", "var/state", "home/controladmin", "root", "run"):
            os.makedirs(f"{d}/{sub}", exist_ok=True)
        self.src = f"{d}/opt/nan-relay"
        open(f"{self.src}/certs.js", "wb").write(BASE)
        open(f"{self.src}/api-relay.js", "w").write("// entry\n")
        open(f"{self.src}/node_modules/x/i.js", "w").write("1\n")
        open(f"{d}/etc/nan-relay/api-relay.env", "w").write("SECRET_VALUE_NEVER_PRINTED=1\n")
        self.unit_files = {}
        for n in ("unit.service", "dropin.conf"):
            p = f"{d}/etc/systemd/{n}"; open(p, "w").write(f"[{n}]\n"); self.unit_files[p] = sha(open(p, "rb").read())
        self.store = f"{d}/var/state/certs.json"
        json.dump({"accounts": {"https://ca/dir": "SEALED_BLOB_NEVER_PRINTED"}, "certs": {"a|b": {}}, "failures": {}, "orders": {}},
                  open(self.store, "w"))
        self.cand = f"{d}/home/controladmin/certs.js.candidate"
        open(self.cand, "wb").write(CAND)
        past = time.time() - 3600
        for root, _, files in os.walk(d):
            for f in files: os.utime(os.path.join(root, f), (past, past))
        self.state = {"pid": 100, "starts": {100: time.time() - 60}, "active": "active", "ndr": "no", "nrestarts": "0",
                      "journal": [], "post": ["[certs] enabled — zones … 1 account(s)"], "restarts": 0,
                      "on_restart": None, "pid_after": None}
        for k, v in {"SRC_DIR": self.src, "TARGET": f"{self.src}/certs.js", "STORE": self.store,
                     "STORE_BACKUP_DIR": f"{d}/root/relay-backups", "ETC_DIR": f"{d}/etc/nan-relay",
                     "CANDIDATE_ROOT": f"{d}/home/controladmin/", "LOCK": f"{d}/run/lock", "UNIT_FILES": self.unit_files,
                     "SETTLE_S": 0, "run": self.fake_run, "proc_start": lambda pid: self.state["starts"][pid],
                     "is_root": lambda: True}.items():
            setattr(A, k, v)

    def fake_run(self, args, timeout=30, check=True):
        s = self.state
        if args[:2] == ["systemctl", "show"]:
            props = {"ActiveState": s["active"], "NeedDaemonReload": s["ndr"], "MainPID": str(s["pid"]),
                     "NRestarts": s["nrestarts"], "FragmentPath": list(self.unit_files)[0],
                     "DropInPaths": " ".join(list(self.unit_files)[1:]),
                     "EnvironmentFiles": f"{self.d}/etc/nan-relay/api-relay.env (ignore_errors=no)", "LoadCredential": ""}
            return "\n".join(f"{p[2:]}={props.get(p[2:], '')}" for p in args[3:]) + "\n"
        if args[:2] == ["systemctl", "restart"]:
            s["restarts"] += 1
            if s["on_restart"]: s["on_restart"](self)
            s["pid"] = s["pid_after"] if s["pid_after"] is not None else s["pid"] + 1
            s["pid_after"] = None
            s["starts"][s["pid"]] = time.time() + 0.05
            return ""
        if args[0] == "journalctl":
            if "@" in " ".join(args): return "\n".join(s["post"]) + "\n"
            return "\n".join(s["journal"]) + "\n"
        if args[0] == "node":
            return REAL_RUN(args, timeout, check)
        raise AssertionError(f"unexpected command {args}")

    def main(self, *extra, execute=False, pin=None):
        buf = io.StringIO()
        argv = ["--candidate", self.cand, "--candidate-sha", pin or sha(CAND)] + (["--execute"] if execute else []) + list(extra)
        with redirect_stdout(buf):
            rc = A.main(argv)
        self.out = buf.getvalue()
        for secret in ("SECRET_VALUE_NEVER_PRINTED", "SEALED_BLOB_NEVER_PRINTED"):
            self.t.assertNotIn(secret, self.out)
        return rc

    def live(self):
        return sha(open(f"{self.src}/certs.js", "rb").read())

    def jl(self, ago, msg):
        self.state["journal"].append(f"{time.time() - ago:.6f} host node[100]: [certs] {msg}")

    def leftovers(self):
        return sorted(n for n in os.listdir(self.src) if n.startswith(".certs-"))


class T(unittest.TestCase):
    def setUp(self): self.r = Rig(self)
    def tearDown(self): shutil.rmtree(self.r.d, ignore_errors=True)

    def test_dry_run_checks_everything_and_writes_nothing(self):
        before = sorted(os.listdir(self.r.src))
        self.assertEqual(self.r.main(), 0, self.r.out)
        self.assertIn("DRY RUN ok", self.r.out)
        self.assertEqual(sorted(os.listdir(self.r.src)), before)
        self.assertEqual(self.r.live(), A.BASE_SHA); self.assertEqual(self.r.state["restarts"], 0)
        self.assertFalse(os.path.exists(A.STORE_BACKUP_DIR))

    def test_execute_swaps_backs_up_restarts_once_and_verifies(self):
        st0 = open(self.r.store, "rb").read()
        self.assertEqual(self.r.main(execute=True), 0, self.r.out)
        self.assertIn("ACTIVATED", self.r.out)
        self.assertEqual(self.r.live(), sha(CAND)); self.assertEqual(self.r.state["restarts"], 1)
        b = [n for n in os.listdir(self.r.src) if n.startswith("certs.js.before-retention-")]
        self.assertEqual(len(b), 1); self.assertEqual(sha(open(f"{self.r.src}/{b[0]}", "rb").read()), A.BASE_SHA)
        sb = os.listdir(A.STORE_BACKUP_DIR); self.assertEqual(len(sb), 1)
        self.assertEqual(open(f"{A.STORE_BACKUP_DIR}/{sb[0]}", "rb").read(), st0)
        self.assertEqual(os.stat(f"{A.STORE_BACKUP_DIR}/{sb[0]}").st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(A.STORE_BACKUP_DIR).st_mode & 0o777, 0o700)
        self.assertEqual(self.r.leftovers(), [])
        # a second run refuses: the live file is no longer the base
        self.assertEqual(self.r.main(execute=True), 2); self.assertIn("not the base", self.r.out)

    def test_refusals_before_any_change(self):
        cases = [
            ("pin", lambda r: None, {"pin": "0" * 64}, "does not match"),
            ("pin=base", lambda r: None, {"pin": A.BASE_SHA}, "equals the base"),
            ("base", lambda r: open(f"{r.src}/certs.js", "ab").write(b"\n"), {}, "not the base"),
            ("inactive", lambda r: r.state.update(active="failed"), {}, "not active"),
            ("reload", lambda r: r.state.update(ndr="yes"), {}, "NeedDaemonReload"),
            ("unitfile", lambda r: open(list(r.unit_files)[1], "a").write("x"), {}, "unit file changed"),
            ("env", lambda r: os.utime(f"{r.d}/etc/nan-relay/api-relay.env"), {}, "changed after the running process"),
            ("src", lambda r: os.utime(f"{r.src}/api-relay.js"), {}, "newer than the running process"),
            ("node_modules", lambda r: os.utime(f"{r.src}/node_modules/x/i.js"), {}, "newer than the running process"),
        ]
        for label, mut, kw, want in cases:
            with self.subTest(label):
                self.tearDown(); self.r = Rig(self); mut(self.r)
                live = self.r.live()
                self.assertEqual(self.r.main(execute=True, **kw), 2, self.r.out)
                self.assertIn(want, self.r.out)
                self.assertEqual(self.r.live(), live); self.assertEqual(self.r.state["restarts"], 0)
                self.assertFalse(os.path.exists(A.STORE_BACKUP_DIR))

    def test_candidate_path_guard(self):
        out = f"{self.r.d}/elsewhere.js"; open(out, "wb").write(CAND)
        link = f"{self.r.d}/home/controladmin/link.js"; os.symlink(out, link)
        for p in (out, link, f"{self.r.d}/home/controladmin/../elsewhere.js"):
            with self.subTest(p):
                self.r.cand = p
                self.assertEqual(self.r.main(execute=True), 2); self.assertIn("non-symlink path under", self.r.out)
        self.assertEqual(self.r.live(), A.BASE_SHA)

    def test_own_backups_do_not_block_a_rerun(self):
        n = f"{self.r.src}/certs.js.before-retention-20261021T190000Z"; open(n, "wb").write(BASE)
        self.assertEqual(self.r.main(), 0, self.r.out)

    def test_journal_inflight_rules(self):
        N = "ef514ed3.app.enclave.host"; EP = "https://api.enclave.host/t/nucbox-k11-4"
        cases = [
            ([(200, f"{EP} {N}: 202 (order still running, retry in 30s)")], 2, "in flight"),
            ([(200, f"{EP} {N}: 202 (order still running, retry in 30s)"), (100, f"{EP} {N}: 202 (order in flight, retry in 30s)")], 2, "in flight"),
            ([(300, f"zerossl: resuming order https://acme/x for {N}")], 2, "in flight"),
            ([(300, f"{EP} {N}: 202 (order still running, retry in 30s)"), (200, f"{EP} {N}: issuance failed (3): ACME 429")], 0, ""),
            ([(300, f"{EP} {N}: 202 (order still running, retry in 30s)"), (200, f"{EP} issued {N} via zerossl (ec-p256), valid to x")], 0, ""),
            ([(300, f"{EP} {N}: 202 (order in flight, retry in 30s)"), (200, f"{EP} {N}: zerossl failed at the CA (newNonce: x) (retry in 120s)")], 0, ""),
            ([(300, f"{EP} {N}: 202 (order in flight, retry in 30s)"), (250, f"zerossl: x — order for {N} KEPT (outcome unknown at the CA), resumed on the next ask")], 0, ""),
            ([(100, "zerossl: POST https://acme/order/1: timeout — cooling this CA off 120s")], 0, ""),
            ([(5, "zerossl: POST https://acme/order/1: timeout — cooling this CA off 120s")], 2, "of quiet"),
            ([(100, "some new in-flight shape: order still running")], 2, "no parseable host"),
        ]
        for lines, rc, want in cases:
            with self.subTest(lines[-1][1][:50]):
                self.r.state["journal"] = []
                for ago, msg in lines: self.r.jl(ago, msg)
                self.assertEqual(self.r.main(), rc, self.r.out)
                if want: self.assertIn(want, self.r.out)

    def test_node_check_failure_refuses_and_leaves_live_untouched(self):
        bad = CAND + b"\n}}} syntax error\n"; open(self.r.cand, "wb").write(bad)
        self.assertEqual(self.r.main(execute=True, pin=sha(bad)), 2, self.r.out)
        self.assertIn("before the swap", self.r.out)
        self.assertEqual(self.r.live(), A.BASE_SHA); self.assertEqual(self.r.leftovers(), []); self.assertEqual(self.r.state["restarts"], 0)

    def test_inflight_appears_after_staging_refuses_before_swap(self):
        orig = A.check_no_inflight; calls = []
        def second_fails(now=None):
            calls.append(1)
            if len(calls) == 2: raise A.Refused("order(s) in flight per the journal: x")
            return orig(now)
        A.check_no_inflight = second_fails
        try:
            self.assertEqual(self.r.main(execute=True), 2, self.r.out)
        finally:
            A.check_no_inflight = orig
        self.assertEqual(self.r.live(), A.BASE_SHA); self.assertEqual(self.r.leftovers(), []); self.assertEqual(self.r.state["restarts"], 0)

    def test_verify_failures_roll_back_source_only(self):
        def fp_change(r):
            j = json.load(open(r.store)); j["accounts"]["https://ca/dir"] = "OTHER_SEALED"; json.dump(j, open(r.store, "w"))
        cases = [
            ("crash-loop", lambda r: r.state.update(nrestarts="1"), "NRestarts=1"),
            ("same-pid", lambda r: r.state.update(pid_after=r.state["pid"]), "old"),
            ("disabled", lambda r: r.state.update(post=["[certs] disabled (DNS_API unset)"]), "enabled"),
            ("accounts", fp_change, "accounts fingerprint changed"),
        ]
        for label, effect, want in cases:
            with self.subTest(label):
                self.tearDown(); self.r = Rig(self)
                def once(r, effect=effect):
                    r.state["on_restart"] = lambda r2: r2.state.update(nrestarts="0", post=["[certs] enabled"])
                    effect(r)
                self.r.state["on_restart"] = once
                store_after = None
                rc = self.r.main(execute=True)
                self.assertEqual(rc, 3, self.r.out); self.assertIn(want, self.r.out); self.assertIn("ROLLED BACK", self.r.out)
                self.assertEqual(self.r.live(), A.BASE_SHA); self.assertEqual(self.r.state["restarts"], 2)
                if label == "accounts":
                    self.assertIn("OTHER_SEALED", open(self.r.store).read(), "the store is NOT restored by the script")
                self.assertEqual(self.r.leftovers(), [])

    def test_rollback_refuses_when_live_is_neither(self):
        def tamper(r):
            open(f"{r.src}/certs.js", "ab").write(b"//x\n"); r.state["nrestarts"] = "2"
        self.r.state["on_restart"] = tamper
        self.assertEqual(self.r.main(execute=True), 4, self.r.out)
        self.assertIn("ROLLBACK FAILED", self.r.out); self.assertIn("MANUAL", self.r.out)


if __name__ == "__main__":
    unittest.main()
