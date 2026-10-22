#!/usr/bin/env python3
"""Local tests of g1_canary.py against a FAKE minipc (no network, no PowerShell): the fake interprets the scripts the
harness and the pinned controller send (Task Scheduler, launcher hash/trust semantics, files, clock). It proves the
harness's control flow, journaling, ownership-scoped cleanup and verdict logic - NOT any Windows behaviour (that is what
the native run is for)."""
import base64, contextlib, datetime, hashlib, io, json, os, pathlib, re, shutil, sys, tempfile, threading, unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import g1_canary as G

SRC = {"controller": os.environ.get("G1_TEST_CONTROLLER", str(HERE / "final-inputs/tunnel_install.754d5a70.py")),   # the FINAL pair
       "receiver": os.environ.get("G1_TEST_RECEIVER", str(HERE / "final-inputs/tunnel-receiver.ec077c11.ps1")),
       "transport": str(HERE.parent / "nucbox-tls-20261021/root-activate-reviewed.py")}
WRITES = ("Set-Content", "Add-Content", "WriteAll", "Remove-Item", "New-Item", "Rename-Item", "Move-Item", "Copy-Item", "Set-Acl", "icacls")
FORBIDDEN = ("Stop-Process", "taskkill", "Restart-Service", "New-LocalUser", "Remove-LocalUser", "-Mode apply",
             "-Mode rollback", "-Mode guard", "-Mode confirm", "systemctl", "Set-ExecutionPolicy")
PIDS = {"n": 4001, "o": 4002, "s": 4003}
def sha(b): return hashlib.sha256(b if isinstance(b, bytes) else b.encode()).hexdigest()


class Fake:
    """minipc as the scripts see it"""
    def __init__(self, t0, **opt):
        self.t = t0; self.opt = opt; self.dirs = {"C:\\ProgramData", "C:\\ProgramData\\Enclave", "C:\\ProgramData\\Enclave\\staging"}
        self.files = {}; self.tasks = {}; self.sent = []; self.lock = threading.RLock(); self.s_started = threading.Event(); self.HEAD = ""
        self.watch_from = None; self.watch_in = threading.Event(); self.watch_done = threading.Event()

    def iso(self, t=None): return datetime.datetime.fromtimestamp(self.t if t is None else t, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    def now(self): return self.t
    def sleep(self, s): self.t += s

    def fire(self, name):
        k = self.tasks[name]; L = k["L"]; d = re.search(r"\$d='([^']*)'", L).group(1)
        want = re.findall(r"-ne '([0-9a-f]{64})'", L); k["lastRun"] = self.t; k["runs"] += 1
        if self.opt.get("hang") == name[-1]: k["state"] = "Running"; return
        got = [sha(self.files.get(d + "\\tunnel-receiver.ps1", {}).get("b", b"")), sha(self.files.get(d + "\\params.json", {}).get("b", b""))]
        bad = [f"hash {n}" for n, w, g in zip(("tunnel-receiver.ps1", "params.json"), want, got) if w != g]
        if bad and not self.opt.get("brokenLauncher"):
            self.files[d + "\\launcher-refused-preflight.txt"] = {"b": "; ".join(bad).encode(), "t": self.t, "owner": "S-1-5-18"}; k["lastResult"] = 9; return
        p = json.loads(self.files[d + "\\params.json"]["b"])
        r = {"mode": "preflight", "runId": p["runId"], "sandbox": p["sandbox"], "at": self.iso(), "decision": "facts", "finishedAt": self.iso(),
             "facts": {"sshd": "sandbox", "configSha": "absent", "keysSha": "absent", "userPresent": False, "backupPresent": False, "state": None}}
        self.files[d + "\\receipt-preflight.json"] = {"b": json.dumps(r).encode(), "t": self.t, "owner": "S-1-5-18"}; k["lastResult"] = 0
        k.setdefault("hits", []).append(self.t)

    def due(self):
        for n, k in list(self.tasks.items()):
            if k["at"] is not None and k["runs"] == 0 and self.t >= k["at"]: self.fire(n)

    real = {"cfgSha": "c" * 64, "user": False, "keys": False, "sshd": "Running", "sshdPid": 4242}
    def anc(self, x): return {"ancestors": list(self.opt.get("ancestors", []))} if "ancestors=@(A $d)" in x else {}   # C3 (3aaa0d0b+)

    def ps(self, text, secs=150):
        with self.lock:
            assert len(self.sent) < 3000, "runaway loop (a deadline that never expires)"
            self.sent.append(text); self.t += 2; self.due()
            o = self.handle(text, secs)
            return {"payload": base64.b64encode(json.dumps(o).encode()).decode()}

    def handle(self, x, secs):
        m = lambda p: re.search(p, x)
        if "$G1='pre'" in x:
            ch = [{"path": p, "exists": True, "owner": "S-1-5-18" if p == "C:\\ProgramData" else "S-1-5-32-544", "reparse": False, "sddl": "D:...",
                   "risky": list(self.opt.get("risky", [])) if p.endswith("staging") else [], "create": ["S-1-5-32-545"]}
                  for p in ("C:\\", "C:\\ProgramData", "C:\\ProgramData\\Enclave", "C:\\ProgramData\\Enclave\\staging")]
            return {"utc": self.iso(), "tzMin": -420, "psv": "5.1", "schedule": "Running", "elevated": True, "outerExists": False, "clash": 0, "opLog": False, "chain": ch,
                    **({"real": dict(self.real)} if "$o.real=" in x else {})}
        if "$G1='parse'" in x: return {"errors": []}
        if "$G1='stage'" in x:
            paths = re.search(r"foreach\(\$p in @\('(.*?)'\)\)", x).group(1).split("','"); items = []
            for p in paths:
                e = p in self.dirs or p in self.files; it = {"path": p, "exists": e}
                if e: it.update({"owner": "S-1-5-32-544", "reparse": False, "protected": True, "sddl": "D:P", "write": []})
                if p in self.files: it["sha"] = sha(self.files[p]["b"])
                items.append(it)
            return {"items": items}
        if "$G1='inspect'" in x:
            n = m(r"\$n='([^']*)'").group(1); k = self.tasks.get(n)
            if not k: return {"registered": False, "now": self.iso()}
            return {"registered": True, "now": self.iso(), "path": "\\", "state": k["state"], "user": "SYSTEM", "logon": "ServiceAccount", "level": "Highest",
                    "group": "", "actions": 1, "exe": G.PS_EXE, "argSha": sha(k["args"]), "argLen": len(k["args"]), "wd": "",
                    "triggerCount": 1 if (k["at"] is not None or self.opt.get("nullTriggers")) else 0,
                    "triggers": [{"cls": "MSFT_TaskTimeTrigger", "startUtc": self.iso(k["at"]), "enabled": True}] if k["at"] is not None else [],
                    "limit": "PT5M", "swa": True, "enabled": True, "lastRun": self.iso(k["lastRun"]) if k["lastRun"] else None,
                    "lastResult": k["lastResult"], "missed": 0, "xmlSha": "0" * 64}
        if "$G1='tamper'" in x:
            f = m(r"\$f='([^']*)'").group(1); b = base64.b64decode(m(r"FromBase64String\('([^']*)'\)").group(1))
            before = sha(self.files[f]["b"]); self.files[f]["b"] = b
            return {"before": before, "after": sha(b), "owner": "S-1-5-32-544", "at": self.iso()}
        if "$G1='trace'" in x:                                    # waits for the watcher's window, then reports starts
            self.lock.release()
            try: self.watch_done.wait(3)
            finally: self.lock.acquire()
            starts = [{"pid": PIDS[n[-1]], "ppid": self.opt.get("tracePpid", 1234), "session": 0, "sid": self.opt.get("traceSid", "S-1-5-18"),
                       "created": self.iso(k["lastRun"] + self.opt.get("traceSkew", 0))} for n, k in self.tasks.items() if k["lastRun"]]
            return {"from": self.iso(), "sched": 1234, "on": True, "starts": starts, "errs": [],
                    "cleanup": {"unregistered": True, "subscribers": 0}, "to": self.iso()}
        if "$G1='watch'" in x:
            start = self.watch_from = self.t; self.watch_in.set(); self.lock.release()
            try: self.s_started.wait(2)
            finally: self.lock.acquire()
            self.t += int(m(r"AddSeconds\((\d+)\)").group(1)); self.due()
            want = dict(re.findall(r"'([0-9a-f]{64})'='([nos])'", x)); hits = []
            for h, role in want.items():
                for n, k in self.tasks.items():
                    if sha(k["args"].split("-EncodedCommand ")[1]) == h and k["lastRun"] and k["lastRun"] >= start and not self.opt.get("noHits"):
                        hits.append({"role": role, "pid": PIDS[role], "created": self.iso(k["lastRun"]), "session": 0, "exe": G.PS_EXE,
                                     "owner": self.opt.get("owner", "NT AUTHORITY\\SYSTEM"), "orc": self.opt.get("orc", 0), "oerr": None,
                                     "alive": True, "ppid": 1234, "parent": "svchost.exe", "parentSchedule": True})
            self.watch_done.set(); return {"from": self.iso(start), "polls": 10, "hits": hits, "to": self.iso()}
        if "$G1='collect'" in x:
            n = m(r"\$n='([^']*)'").group(1); d = m(r"\$d='([^']*)'").group(1); k = self.tasks.get(n); o = {"registered": bool(k), "now": self.iso()}
            if k: o.update({"state": k["state"], "lastRun": self.iso(k["lastRun"]) if k["lastRun"] else None, "lastResult": k["lastResult"], "missed": 0})
            f = self.files.get(d + "\\receipt-preflight.json"); o["receipt"] = None
            if f:
                j = json.loads(f["b"]); fa = j["facts"]
                o["receipt"] = {"owner": f["owner"], "created": self.iso(f["t"]), "decision": j["decision"], "mode": j["mode"], "runId": j["runId"],
                                "sandbox": j["sandbox"], "at": j["at"], "finishedAt": j["finishedAt"], "factsSshd": fa["sshd"],
                                "factsAllAbsent": fa["configSha"] == "absent" and fa["keysSha"] == "absent" and not fa["userPresent"] and not fa["backupPresent"] and fa["state"] is None}
            f = self.files.get(d + "\\launcher-refused-preflight.txt"); o["refused"] = {"owner": f["owner"], "created": self.iso(f["t"]), "text": f["b"].decode()} if f else None
            o["files"] = sorted(p.rsplit("\\", 1)[1] for p in self.files if p.rsplit("\\", 1)[0] == d)
            return o
        if "$G1='events'" in x: return {"enabled": False, "events": []}
        if "$G1='stop'" in x:
            n = m(r"\$n='([^']*)'").group(1); self.tasks[n]["state"] = "Ready"; self.tasks[n]["stopped"] = True; return {"state": "Ready"}
        if "$G1='verify'" in x:
            pre = m(r"-TaskName '([^']*)\*'").group(1); outer = m(r"Test-Path -LiteralPath '([^']*)'").group(1)
            real = dict(self.real, sshdPid=self.real["sshdPid"] + 1) if self.opt.get("realChange") else dict(self.real)
            return {"tasks": sorted(n for n in self.tasks if n.startswith(pre)), "outer": outer in self.dirs, **({"real": real} if "$o.real=" in x else {})}
        if "logon=[string]$k.Principal.LogonType;level=" in x and "$G1=" not in x:     # a controller's own definition read (7d P6)
            n = m(r"-TaskName '([^']*)'").group(1); k = self.tasks.get(n) or {}
            return {"actions": 1, "exe": G.PS_EXE, "logon": "ServiceAccount", "level": "Highest", "triggers": 1 if k.get("at") is not None else 0}
        if "Register-ScheduledTask" in x:
            i = x.index("$L='") + 4; j = x.index("';$arg='"); L = x[i:j].replace("''", "'")
            pre = m(r"\$arg='([^']*)'\+").group(1); n = m(r"Register-ScheduledTask -TaskName '([^']*)'").group(1)
            at = m(r"New-ScheduledTaskTrigger -Once -At \(\(Get-Date\)\.AddMinutes\((\d+)\)\)")
            assert n not in self.tasks, "re-registration of an existing name"
            args = pre + base64.b64encode(L.encode("utf-16-le")).decode()
            if self.opt.get("corrupt") == n[-1]: args += " "
            self.tasks[n] = {"L": L, "args": args, "at": self.t + int(at.group(1)) * 60 if at else None, "state": "Ready", "lastRun": None, "lastResult": 267011, "runs": 0}
            null_bug = self.opt.get("nullTriggers") and "@($k.Triggers).Count" in x       # PS: @($null).Count is 1; |?{$_} fixes it
            return {"state": "Ready", "user": "SYSTEM", "triggers": 1 if (at or null_bug) else 0, "argSha": sha(args)}
        if "Start-ScheduledTask" in x:
            n = m(r"Start-ScheduledTask -TaskName '([^']*)'").group(1)
            if self.watch_from is None:                      # the real race: a start before the watcher polls is unobservable
                self.lock.release()
                try: self.watch_in.wait(2)
                finally: self.lock.acquire()
            self.fire(n); self.s_started.set(); return {"started": True, "state": self.tasks[n]["state"]}
        if "Unregister-ScheduledTask" in x:
            n = m(r"Unregister-ScheduledTask -TaskName '([^']*)'").group(1); self.tasks.pop(n, None); return {"gone": True}
        if "CreateDirectory($d,$ds)" in x:
            d = m(r"\$d='([^']*)'").group(1)
            if d.rsplit("\\", 1)[0] not in self.dirs: return {"dir": d, "error": "staging root absent"}
            if d in self.dirs: return {"dir": d, "error": "exists"}
            self.dirs.add(d); return {"dir": d, "parentSddlUnchanged": True, "created": True}
        if "/setowner" in x and "dirSddl" in x:
            d = m(r"\$d='([^']*)'").group(1)
            return {"dirSddl": "D:P", **self.anc(x), "trust": [], "files": {p.rsplit("\\", 1)[1]: {"sha": sha(v["b"]), "sddl": "D:AI"} for p, v in self.files.items() if p.rsplit("\\", 1)[0] == d}}
        if "Remove-Item -LiteralPath $d -Recurse -Force" in x:
            d = m(r"\$d='([^']*)'").group(1)
            for p in [p for p in self.dirs if p == d or p.startswith(d + "\\")]: self.dirs.discard(p)
            for p in [p for p in self.files if p.startswith(d + "\\")]: del self.files[p]
            return {"dir": d, "removed": True}
        if "files=[ordered]@{}" in x and "trust=" in x:
            d = m(r"\$d='([^']*)'").group(1)
            return {**self.anc(x), "trust": [], "files": {p.rsplit("\\", 1)[1]: sha(v["b"]) for p, v in self.files.items() if p.rsplit("\\", 1)[0] == d}}
        raise AssertionError("unrecognised script: " + x[:200])


class FakeSub:
    def __init__(self, fake): self.fake = fake
    def run(self, a, check=False, timeout=None, **k):
        assert a[0] == "scp" and a[-1].startswith("minipc:"), a
        dst = a[-1][len("minipc:"):].replace("/", "\\")
        assert dst.rsplit("\\", 1)[0] in self.fake.dirs, "scp into a dir the run did not create"
        self.fake.files[dst] = {"b": pathlib.Path(a[-2]).read_bytes(), "t": self.fake.t, "owner": "S-1-5-32-544"}


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="g1t-"))
        work = self.tmp / "work"; (work / "nucbox-tls-20261021").mkdir(parents=True)
        shutil.copyfile(SRC["transport"], work / "nucbox-tls-20261021/root-activate-reviewed.py")
        G.RUNS = work / "tunnel-native-task-canary-20261021" / "runs"
        man = {k: {"path": str(v if k != "transport" else work / "nucbox-tls-20261021/root-activate-reviewed.py"),
                   "sha256": sha(pathlib.Path(v).read_bytes())} for k, v in SRC.items()}
        self.man = self.tmp / "manifest.json"; self.man.write_text(json.dumps(man))
        self.orig_load = G.Canary.load; self.orig_clock = dict(G.CLOCK); self.orig_limit = G.LIMIT

    def tearDown(self):
        G.Canary.load = self.orig_load; G.CLOCK.update(self.orig_clock); G.LIMIT = self.orig_limit; shutil.rmtree(self.tmp)

    def plan(self, **kw):
        tvf = None
        if kw.get("tv"):                                               # a native trace-validation result (trace_validate.py)
            import test_trace_validate as TV
            r = TV.GOOD if kw["tv"] == "valid" else TV.mut(starts__0__sid="S-1-5-18")
            tvf = self.tmp / "tv.json"; tvf.write_text(json.dumps({"result": r}))
        a = type("A", (), {"manifest": str(self.man), "offset_min": kw.get("offset", 2), "trace_validation": str(tvf) if tvf else None})()
        out = io.StringIO()
        with contextlib.redirect_stdout(out): G.cmd_plan(a)
        return json.loads(out.getvalue())

    def wire(self, **opt):
        fake = Fake(1_800_000_000.0, **opt); orig = self.orig_load
        def load(c):
            mm = orig(c); fake.HEAD = c.tm.HEAD; mm._m = fake; mm.subprocess = FakeSub(fake); return mm
        G.Canary.load = load; G.CLOCK.update(now=fake.now, sleep=fake.sleep, mono=fake.now); return fake

    def go(self, p, fake, parse=True):
        A = lambda **k: type("A", (), k)()
        if parse:
            with contextlib.redirect_stdout(io.StringIO()): G.cmd_parse(A(run=p["run"], plan_sha=p["planSha"]))
        out = io.StringIO(); code = 0
        with contextlib.redirect_stdout(out):
            try: G.cmd_run(A(run=p["run"], plan_sha=p["planSha"]))
            except SystemExit as e: code = e.code
        res = json.loads((G.RUNS / p["run"] / "G1-RESULT.json").read_text())
        J = [json.loads(l) for l in (G.RUNS / p["run"] / "journal.jsonl").read_text().splitlines()]
        for t in fake.sent:
            for f in FORBIDDEN: self.assertNotIn(f, t, f"forbidden text sent: {f}")
            if "$G1='pre'" in t or "$G1='verify'" in t:            # C2 reads the real sshd config/account/keys: read-only
                for f in WRITES: self.assertNotIn(f, t, f"write verb in a real-system read: {f}")
            elif "$G1='parse'" not in t: self.assertNotIn("C:\\ProgramData\\ssh", t)
        return code, res, J

    def assertJournalPaired(self, J):
        """every result follows an earlier, still-open attempt of the same step (the watcher runs concurrently)"""
        open_ = []
        for e in J:
            if e["phase"] == "attempt": open_.append(e["step"])
            else: self.assertIn(e["step"], open_, e); open_.remove(e["step"])
        self.assertEqual(open_, [])
        self.assertEqual([e["seq"] for e in J], list(range(1, len(J) + 1)))

    # ------------------------------------------------------------------------------------------------------------
    def test_01_happy_path_pass_and_clean(self):
        p = self.plan(); fake = self.wire(); code, res, J = self.go(p, fake)
        self.assertEqual(res["verdict"]["G1"], "PASS", res["verdict"]); self.assertEqual(code, 0)
        self.assertTrue(res["verdict"]["checks"]["real.unchanged"])
        self.assertTrue(res["cleanup"]["clean"]); self.assertEqual(fake.tasks, {}); self.assertFalse(any(d.startswith(p["outer"]) for d in fake.dirs))
        self.assertJournalPaired(J)
        steps = [e["step"] for e in J if e["phase"] == "attempt"]
        self.assertNotIn("start-o", steps); self.assertNotIn("start-n", steps); self.assertNotIn("cleanup-stop", steps)
        # each task is dropped only after a collect showed its terminal receipt
        first_drop = steps.index("cleanup-drop"); last_collect = max(i for i, s in enumerate(steps) if s.startswith("collect-"))
        self.assertLess(last_collect, first_drop)
        plan = json.loads((G.RUNS / p["run"] / "PLAN.json").read_text())
        cap = int(re.search(r"\[a-z0-9\]\{6,(\d+)\}", pathlib.Path(SRC["controller"]).read_text()).group(1))   # the controller's RUN cap
        fits = plan["productionRunLenFits"]; self.assertEqual(fits[0], 6)
        self.assertEqual(fits[1] >= cap, cap <= 16, (fits, cap))     # e6696e33 accepts 24 but only <= 20 fits; 3aaa0d0b caps at 16

    def test_02_unsafe_parent_refused_before_any_mutation(self):
        p = self.plan(); fake = self.wire(risky=["S-1-5-32-545:0x40"]); code, res, J = self.go(p, fake)
        self.assertEqual(res["verdict"]["G1"], "NOT-RUN"); self.assertIn("move/rename", " ".join(res["verdict"]["why"]))
        steps = [e["step"] for e in J if e["phase"] == "attempt"]
        self.assertEqual([s for s in steps if not s.startswith(("cleanup-", "parse-"))], ["preflight"]); self.assertEqual(fake.tasks, {})
        self.assertTrue(res["cleanup"]["clean"]); self.assertEqual(code, 2)

    def test_03_no_bypass_flag_exists(self):
        import subprocess
        r = subprocess.run([sys.executable, str(HERE / "g1_canary.py"), "run", "--run", "g100000000", "--plan-sha", "0" * 64, "--force"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn("unrecognized arguments: --force", r.stderr)

    def test_04_stored_args_mismatch_aborts_and_drops_own_tasks(self):
        p = self.plan(); fake = self.wire(corrupt="o"); code, res, J = self.go(p, fake)
        self.assertEqual(res["verdict"]["G1"], "FAIL"); self.assertIn("register-o", res["verdict"]["why"])
        steps = [e["step"] for e in J if e["phase"] == "attempt"]
        self.assertNotIn("register-s", steps); self.assertEqual(fake.tasks, {}); self.assertTrue(res["cleanup"]["clean"])
        self.assertTrue(all(k.get("runs", 0) == 0 for k in fake.tasks.values()))

    def test_05_launcher_that_runs_tampered_params_fails(self):
        p = self.plan(); fake = self.wire(brokenLauncher=True); code, res, J = self.go(p, fake)
        v = res["verdict"]; self.assertEqual(v["G1"], "FAIL")
        self.assertFalse(v["checks"]["n.refusedByLauncher"]); self.assertFalse(v["checks"]["n.receiverNeverRan"]); self.assertTrue(res["cleanup"]["clean"])

    def test_06_no_direct_identity_is_incomplete_not_pass(self):
        p = self.plan(); fake = self.wire(noHits=True); code, res, J = self.go(p, fake)
        self.assertTrue(res["verdict"]["G1"].startswith("INCOMPLETE"), res["verdict"]); self.assertEqual(code, 2)

    def test_07_running_task_is_stopped_by_name_then_dropped(self):
        p = self.plan(); fake = self.wire(hang="o"); code, res, J = self.go(p, fake)
        self.assertNotEqual(res["verdict"]["G1"], "PASS")
        steps = [e["step"] for e in J if e["phase"] == "attempt"]
        self.assertEqual(steps.count("cleanup-stop"), 1); self.assertTrue(res["cleanup"]["clean"]); self.assertEqual(fake.tasks, {})

    def test_08_crash_then_cleanup_command_from_journal(self):
        p = self.plan(); fake = self.wire(); real = G.cleanup
        G.cleanup = lambda c, m: (_ for _ in ()).throw(KeyboardInterrupt())
        try:
            with self.assertRaises(KeyboardInterrupt): self.go(p, fake)
        finally:
            G.cleanup = real
        self.assertTrue(fake.tasks)                       # left behind by the "crash"
        with contextlib.redirect_stdout(io.StringIO()): G.cmd_cleanup(type("A", (), {"run": p["run"]})())
        self.assertEqual(fake.tasks, {}); self.assertFalse(any(d.startswith(p["outer"]) for d in fake.dirs))
        fake.tasks["SomeoneElsesTask"] = {"L": "", "args": "", "at": None, "state": "Running", "lastRun": None, "lastResult": 0, "runs": 0}
        with contextlib.redirect_stdout(io.StringIO()): G.cmd_cleanup(type("A", (), {"run": p["run"]})())
        self.assertIn("SomeoneElsesTask", fake.tasks)     # never touched

    def test_09_plan_refusals(self):
        bad = json.loads(self.man.read_text()); bad["receiver"]["sha256"] = "0" * 64; self.man.write_text(json.dumps(bad))
        with self.assertRaises(SystemExit) as e: self.plan()
        self.assertIn("never 'latest'", str(e.exception))
        self.setUp()
        with self.assertRaises(SystemExit): self.plan(offset=1)
        self.setUp()
        r = self.tmp / "recv.ps1"; r.write_bytes(pathlib.Path(SRC["receiver"]).read_bytes() + b"\r\nUnregister-ScheduledTask -TaskName x\r\n")
        man = json.loads(self.man.read_text()); man["receiver"] = {"path": str(r), "sha256": sha(r.read_bytes())}; self.man.write_text(json.dumps(man))
        with self.assertRaises(SystemExit) as e: self.plan()
        self.assertIn("unregisters", str(e.exception))
        self.setUp(); G.LIMIT = 7000
        with self.assertRaises(SystemExit) as e: self.plan()
        self.assertIn("over the transport limit", str(e.exception)); self.assertEqual(list(G.RUNS.iterdir()), [])

    def test_10_run_requires_reviewed_plan_and_clean_parse(self):
        p = self.plan(); fake = self.wire()
        A = lambda **k: type("A", (), k)()
        with self.assertRaises(SystemExit) as e: G.cmd_run(A(run=p["run"], plan_sha="f" * 64))
        self.assertIn("reviewed plan", str(e.exception))
        with self.assertRaises(SystemExit) as e: G.cmd_run(A(run=p["run"], plan_sha=p["planSha"]))
        self.assertIn("parse", str(e.exception))
        (G.RUNS / p["run"] / "src/ctl/tunnel_install.py").write_text("# changed\n")
        with self.assertRaises(SystemExit) as e: G.cmd_run(A(run=p["run"], plan_sha=p["planSha"]))
        self.assertIn("changed since plan", str(e.exception)); self.assertEqual(fake.sent, [])

    def test_11_the_run_never_reruns(self):
        p = self.plan(); fake = self.wire(); self.go(p, fake)
        with self.assertRaises(SystemExit) as e:
            G.cmd_run(type("A", (), {"run": p["run"], "plan_sha": p["planSha"]})())
        self.assertIn("already ran", str(e.exception))

    def test_12_launchers_are_the_controllers_and_preflight_only(self):
        p = self.plan(); fake = self.wire(); self.go(p, fake)
        regs = [t for t in fake.sent if "Register-ScheduledTask" in t]; self.assertEqual(len(regs), 3)
        for t in regs: self.assertIn("-Mode preflight -Dir $d", t.replace("''", "'"))
        plan = json.loads((G.RUNS / p["run"] / "PLAN.json").read_text())
        for k, r in plan["roles"].items():
            pj = json.loads((G.RUNS / p["run"] / "stage" / k / "params.json").read_text())
            self.assertIs(pj["sandbox"], True); self.assertEqual(pj["sandboxRoot"], plan["outer"]); self.assertTrue(r["dir"].startswith(plan["outer"] + "\\"))
            self.assertNotIn("publicKey", pj)
        self.assertLessEqual(max(plan["encoded"].values()), G.LIMIT)


    def test_13_controller_trigger_count_false_negative_is_reported_not_bypassed(self):
        """PS 5.1: @($null).Count is 1. If a trigger-less task's Triggers is $null, the controller's argsMatch is false and
        it never starts apply/rollback; the canary must report that and NOT start s itself"""
        p = self.plan(); fake = self.wire(nullTriggers=True); code, res, J = self.go(p, fake)
        v = res["verdict"]; steps = [e["step"] for e in J if e["phase"] == "attempt"]
        if "@($k.Triggers).Count" not in pathlib.Path(SRC["controller"]).read_text():      # a controller with the fix (7d P5)
            self.assertEqual(v["G1"], "PASS", v); self.assertIn("start-s", steps); return
        self.assertEqual(v["G1"], "FAIL"); self.assertIn("never start apply/rollback", v["failed"][0]); self.assertNotIn("start-s", steps)
        self.assertTrue(v["checks"]["o.receipt"] and v["checks"]["n.refusedByLauncher"] and v["checks"]["o.firedByTrigger"])
        self.assertTrue(res["cleanup"]["clean"]); self.assertEqual(fake.tasks, {})


    def test_14_c2_real_system_changed_is_fail(self):
        p = self.plan(); fake = self.wire(realChange=True); code, res, J = self.go(p, fake)
        self.assertEqual(res["verdict"]["G1"], "FAIL"); self.assertFalse(res["verdict"]["checks"]["real.unchanged"]); self.assertTrue(res["cleanup"]["clean"])

    def test_15_c3_ancestor_problem_aborts_before_any_task(self):
        p = self.plan(); fake = self.wire(ancestors=["rename S-1-5-32-545 C:\\ProgramData\\Enclave"]); code, res, J = self.go(p, fake)
        self.assertEqual(res["verdict"]["G1"], "FAIL"); self.assertIn("seal-", res["verdict"]["why"])
        self.assertNotIn("register-n", [e["step"] for e in J]); self.assertTrue(res["cleanup"]["clean"]); self.assertEqual(fake.tasks, {})

    def test_16_c4_execution_policy_in_receiver_refused_at_plan(self):
        r = self.tmp / "recv.ps1"; r.write_bytes(pathlib.Path(SRC["receiver"]).read_bytes() + b"\r\n# Set-ExecutionPolicy -Scope Process Bypass\r\n")
        man = json.loads(self.man.read_text()); man["receiver"] = {"path": str(r), "sha256": sha(r.read_bytes())}; self.man.write_text(json.dumps(man))
        with self.assertRaises(SystemExit) as e: self.plan()
        self.assertIn("execution-policy", str(e.exception)); self.assertEqual(list(G.RUNS.iterdir()), [])

    def test_17_c1_deadlines_are_monotonic_not_wall_clock(self):
        p = self.plan(); fake = self.wire(hang="o"); G.CLOCK["now"] = lambda: 1_800_000_000.0     # the wall clock stops
        code, res, J = self.go(p, fake)                                                          # must still terminate
        self.assertEqual([e["step"] for e in J if e["phase"] == "attempt"].count("cleanup-stop"), 1); self.assertTrue(res["cleanup"]["clean"])


    def test_18_no_case_insensitive_variable_collision_in_any_sent_script(self):
        """PowerShell: $H and $h are ONE variable (g13f5b009e's watch died on it); the parser cannot see this"""
        import ps_case_lint
        p = self.plan(); fake = self.wire(); self.go(p, fake)
        bad = {i: c for i, t in enumerate(fake.sent) if (c := ps_case_lint.collisions(t))}
        self.assertEqual(bad, {}, bad)
        self.assertTrue(ps_case_lint.collisions("$H=1;$h=2"))           # the fixture itself detects the bug class


    def test_19_start_trace_sid_is_direct_token_proof_when_getowner_races(self):
        p = self.plan(tv="valid"); fake = self.wire(owner=None, orc=None); code, res, J = self.go(p, fake)
        v = res["verdict"]; self.assertEqual(v["G1"], "PASS", v); self.assertTrue(all(i["via"] == ["startTraceSid"] for i in v["identity"].values()))

    def test_20_null_owner_without_trace_is_incomplete_and_keeps_diagnostics(self):
        p = self.plan(); fake = self.wire(owner=None, orc=8, traceSid=None); code, res, J = self.go(p, fake)
        v = res["verdict"]; self.assertTrue(v["G1"].startswith("INCOMPLETE"), v); self.assertEqual(code, 2)
        self.assertTrue(all(i["ownerRc"] == 8 and "ownerErr" in i for i in v["identity"].values()))

    def test_21_no_weakening_admin_sid_is_not_system_proof(self):
        p = self.plan(tv="valid"); fake = self.wire(owner=None, orc=None, traceSid="S-1-5-32-544"); code, res, J = self.go(p, fake)
        self.assertTrue(res["verdict"]["G1"].startswith("INCOMPLETE"), res["verdict"])     # receipts are S-1-5-18 here too: not counted

    def test_22_trace_start_from_another_parent_is_not_joined(self):
        p = self.plan(tv="valid"); fake = self.wire(owner=None, orc=None, tracePpid=999); code, res, J = self.go(p, fake)
        self.assertTrue(res["verdict"]["G1"].startswith("INCOMPLETE"), res["verdict"])


    def test_23_trace_sid_does_not_count_without_native_validation(self):
        p = self.plan(); fake = self.wire(owner=None, orc=None); code, res, J = self.go(p, fake)
        v = res["verdict"]; self.assertTrue(v["G1"].startswith("INCOMPLETE"), v)
        self.assertTrue(all(i["traceSid"] == "S-1-5-18" and i["traceValidated"] is False and i["via"] == [] for i in v["identity"].values()))

    def test_24_validation_that_saw_system_for_a_user_child_is_rejected(self):
        p = self.plan(tv="provider-system"); fake = self.wire(owner=None, orc=None); code, res, J = self.go(p, fake)
        plan = json.loads((G.RUNS / p["run"] / "PLAN.json").read_text())
        self.assertIs(plan["traceValidation"]["VALID"], False); self.assertIn("sidIsSessionUser", plan["traceValidation"]["failed"])
        self.assertTrue(res["verdict"]["G1"].startswith("INCOMPLETE"))

    def test_25_pid_reuse_time_mismatch_is_not_joined(self):
        p = self.plan(tv="valid"); fake = self.wire(owner=None, orc=None, traceSkew=10); code, res, J = self.go(p, fake)
        v = res["verdict"]; self.assertTrue(v["G1"].startswith("INCOMPLETE"), v); self.assertTrue(all(i["traceJoined"] == 0 for i in v["identity"].values()))

    def test_26_getowner_alone_still_passes_without_validation(self):
        p = self.plan(); fake = self.wire(); code, res, J = self.go(p, fake)
        self.assertEqual(res["verdict"]["G1"], "PASS"); self.assertTrue(all(i["via"] == ["getOwner"] for i in res["verdict"]["identity"].values()))


def main():
    r = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(T))
    return 0 if r.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
