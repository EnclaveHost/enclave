#!/usr/bin/env python3
"""Offline tests of postflight.py: static read-only guards on every remote text, a Linux pwsh 7 fixture run of the EXACT texts
(Invoke-RestMethod / Get-CimInstance / Start-Sleep replaced by local functions; paths rooted in a temp dir; the frozen files
copied in), and negative controls: every missing/wrong state must NOT evaluate green. Not native Windows evidence."""
import copy, datetime, hashlib, importlib.util, json, os, pathlib, re, shutil, subprocess, tempfile, time, unittest
H = pathlib.Path(__file__).resolve().parent; W = H.parents[2]
spec = importlib.util.spec_from_file_location("pf", H / "postflight.py"); P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
PWSH = os.environ.get("PWSH", str(W / "node-hold-package-20261021/tools/pwsh/pwsh"))
SRC = {**{k: W / "root-control-final-20261022/control-package/files" / k.replace("control/", "", 1) for k in P.FILES if k.startswith("control/")},
       "network/privacy-agent.mjs": W / "g4-challenge-retry-package-20261022/candidate/privacy-agent.mjs",
       "network/host-service-ingress.mjs": W / "g4-challenge-retry-package-20261022/candidate/host-service-ingress.mjs"}
R = "0x" + "2f" * 32
IDS = ["0x" + f"{i + 1:02x}" * 32 for i in range(9)]
SECRETS = ["S3CRET-CFG", "S3CRET-OWN", "S3CRET-REG", "S3CRET-PIN", "S3CRET-DIR", "S3CRET-HS", "S3CRET-CH", "S3CRET-EGRESS"]
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.0000000Z")
nowms = lambda: int(time.time() * 1000)
def appendf(p, s):
    with open(p, "a") as f: f.write(s)

class Fixture:
    def __init__(self, tmp, host_services=False, challenge=False):
        self.tmp = tmp; self.pd = tmp / "pd"; self.pf = tmp / "pf"; self.hs, self.ch = host_services, challenge
        for d in ("network/state", "logs", "node"): (self.pd / d).mkdir(parents=True, exist_ok=True)
        for k, src in SRC.items(): dst = self.pf / k; dst.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src, dst)
        self.wallet = str(self.pd) + "\\network\\wallet-admission.json"    # the Windows-form path the node and cutover write
        self.agent_start = time.time() - 600; self.priv_start = time.time() - 640; self.gen = "ab" * 16
    def en(self, post):
        e = {"relay": "https://r.example", "checkers": ["0x1"], "directories": ["https://d.example"], "hostEgress": {"apps": "all", "own": [], "note": "S3CRET-EGRESS"}}
        if self.hs: e["hostServices"] = {"zone": "x.example", "token": "S3CRET-HS"}
        if self.ch: e["challengeReplica"] = {"front": {"mode": "managed"}, "key": "S3CRET-CH"}
        if post:
            if self.hs: e["serviceWorkerModule"] = str(self.pf) + "\\network\\host-service-ingress.mjs"
            e["walletAdmission"] = {"file": self.wallet}
        return e
    def write_config(self, post):
        apps = []
        for i in IDS:
            d = self.pd / "network" / i; d.mkdir(exist_ok=True)
            (d / "expected.json").write_text(json.dumps({"appRef": f"catalog://0x{'a' * 64}/1", "configCid": '{"config":{"k":"S3CRET-CFG"}}'}))
            apps.append({"deploymentId": i, "expectedFile": str(d / "expected.json")})
        (self.pd / "network/privacy-config.json").write_text(json.dumps({"apps": apps, "enclaveNetwork": self.en(post)}))
    def write_logs(self, extra_node="", extra_net=""):
        (self.pd / "logs/node.log").write_text("00:00:00 [node] [host-policy] this host is not serving: old process\n")
        (self.pd / "logs/network.log").write_text("00:00:00 [privacy] HOST SERVICES REFUSED (apps unaffected): old\n")
    def p0_texts(self): return P.fill(P.P0, str(self.pd), str(self.pf))
    def post_state(self, rev=5):
        n = nowms(); allows = {i: {"appRef": f"catalog://0x{'a' * 64}/1", "configCid": '{"config":{"k":"S3CRET-CFG"}}', "validUntil": n + 60000} for i in IDS}
        (self.pd / "network/wallet-admission.json").write_text(json.dumps({"version": 1, "runner": R, "generation": self.gen, "revision": rev, "issuedAt": n, "expiresAt": n + 30000, "allows": allows}))
        (self.pd / "network/state/status.json").write_text(json.dumps({"version": 2, "updatedAt": n, "walletAdmission": {"runner": R, "generation": self.gen, "revision": rev, "expiresAt": n + 30000,
            "fresh": True, "error": None, "allows": IDS, "applied": True}, "apps": [{"deploymentId": i, "leaseUntil": n + 500000, "proofUntil": n + 60000, "walletUntil": n + 30000} for i in IDS]}))
        (self.pd / "network/state/egress-routes.json").write_text(json.dumps({"apps": {i: {} for i in IDS}}))
        (self.pd / "node-config.cmd").write_text("@echo off\r\nset ENCLAVE_PLATFORM_HOST_POLICY=production\r\nset ENCLAVE_HOST_OWNERSHIP=S3CRET-OWN\r\nset ENCLAVE_HOST_REGISTRY_PIN=S3CRET-REG\r\n"
                                                 "set ENCLAVE_HOST_CATALOG_PIN=S3CRET-PIN\r\nset \"ENCLAVE_HOST_POLICY_DIR=S3CRET-DIR\"\r\nset ENCLAVE_NETWORK_AGENT_DIR=C:\\ProgramData\\Enclave\\network\r\n"
                                                 "if exist x call node-config.local.cmd\r\n")
        (self.pd / "node-config.local.cmd").write_text("@echo off\r\nset NODE_APP_RAM_GB=4\r\nset ENCLAVE_NETWORK_WALLET_HOLD=1\r\n")
        (self.pd / "run-node.cmd").write_text("@echo off\r\ncall node-config.cmd\r\n")
        (self.pd / "node/platform-host-admission.json").write_text(json.dumps({"hostId": R, "knownRefusal": None}))
        with open(self.pd / "logs/node.log", "a") as f:
            f.write("01:00:00 [node] wallet hold channel: x, generation abababab, written EMPTY (nothing is admitted on the network until a fresh allow)\n")
            f.write("01:00:01 [node] [host-policy] this host is ADMITTED: serving and taking work\n")
        with open(self.pd / "logs/network.log", "a") as f:
            if self.hs: f.write('01:00:02 [privacy] host services: ["directory-replica"]\n')
            if self.ch: f.write("01:00:03 [privacy] challenge replica serving: app-zone-replica, release 3e1560f94542, Shield evidence\n")
    def receipt(self, node_off):
        lines = [{"step": "pins", "nodeLogOffset": node_off}, {"step": "privacy-restart", "newPid": 30716, "newStart": iso(self.priv_start)},
                 {"step": "start-node", "agent": {"pid": 8888, "parent": 7777, "start": iso(self.agent_start)}, "channelGeneration": self.gen},
                 {"final": "DONE: enforcing, channel applied, every expected id re-granted"}]
        return {"params": {"runId": "20261022t030000z-abcdef", "runner": R, "expectedIds": IDS}, "journal": {"lines": [json.dumps(l) for l in lines]}}
    def stub(self):
        host = {"deployments": [{"id": i, "status": "running", "walletHeld": False, "leaseUntil": int(time.time()) + 500, "config": "S3CRET-CFG"} for i in IDS], "leaseReadiness": {}}
        procs = {8888: (self.agent_start, r"node.exe C:\Program Files\Enclave\control\windows\node\agent.mjs"), 30716: (self.priv_start, r"node.exe C:\x\network\privacy-agent.mjs --config S3CRET-CFG")}
        cim = ";".join(f"if($pidv -eq {p}){{return [pscustomobject]@{{ProcessId={p};CreationDate=[DateTime]::Parse('{iso(t)}').ToUniversalTime();CommandLine='{c}'}}}}" for p, (t, c) in procs.items())
        bump = (f"$f='{self.pd}/network/wallet-admission.json';$d=Get-Content -Raw $f|ConvertFrom-Json;$n=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$d.revision=$d.revision+2;$d.issuedAt=$n;$d.expiresAt=$n+30000;"
                f"$d|ConvertTo-Json -Depth 8 -Compress|Set-Content -NoNewline $f;$g='{self.pd}/network/state/status.json';$s=Get-Content -Raw $g|ConvertFrom-Json;$s.updatedAt=$n;$s.walletAdmission.revision=$d.revision;"
                f"$s.walletAdmission.expiresAt=$n+30000;$s|ConvertTo-Json -Depth 8 -Compress|Set-Content -NoNewline $g")
        return ("function Invoke-RestMethod { param([switch]$UseBasicParsing, $TimeoutSec, $Uri) if ($Uri -ne 'http://127.0.0.1:9600/v1/host/state') { throw 'unexpected uri' }; '"
                + json.dumps(host) + "' | ConvertFrom-Json }\n"
                + "function Get-CimInstance { param($ClassName, $Filter, $OperationTimeoutSec) if ($ClassName -ne 'Win32_Process' -or $Filter -notmatch '^ProcessId=\\d+$') { throw 'broad query' }; $pidv=[int]($Filter -replace 'ProcessId=',''); "
                + cim + "; return $null }\n"
                + "function Start-Sleep { param($Seconds) " + (bump if self.bump else "") + " }\n")
    bump = True

def run_ps(fx, text):
    f = fx.tmp / "t.ps1"; f.write_text(fx.stub() + text)
    r = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(f)], capture_output=True, text=True, timeout=180)
    if r.returncode != 0: raise AssertionError(r.stderr[-1500:])
    return json.loads(r.stdout.strip().splitlines()[-1])

def collect(fx, mutate_post_files=None, pre_mut=None):
    fx.write_config(post=False); fx.write_logs()
    if pre_mut: pre_mut(fx)
    p0 = run_ps(fx, fx.p0_texts()); off = os.path.getsize(fx.pd / "logs/node.log")
    pre_sha = hashlib.sha256((fx.pd / "network/privacy-config.json").read_bytes()).hexdigest()
    fx.write_config(post=True); fx.post_state()
    if mutate_post_files: mutate_post_files(fx)
    rc = fx.receipt(off)
    # the real receipt pins the pre-cutover privacy-config sha (helper params cfgSha = the cutover preflight's cfg); a correctly
    # taken P0 reads the same file, so the fixture binds them the same way (an unreadable pre config has no sha to bind)
    rc["params"]["cfgSha"] = pre_sha
    ts = P.post_texts(rc, str(fx.pd), str(fx.pf), sleep=1); ts["logs"] = ts["logs"](p0)
    post = {k: run_ps(fx, t) for k, (t, _) in ts.items()}
    return rc, p0, post

@unittest.skipUnless(pathlib.Path(PWSH).exists(), "no pwsh")
class Fixtures(unittest.TestCase):
    def setUp(self): self.tmp = pathlib.Path(tempfile.mkdtemp())
    def tearDown(self): shutil.rmtree(self.tmp)
    def check_no_secrets(self, *objs):
        s = json.dumps(objs)
        for x in SECRETS: self.assertNotIn(x, s, "no config value or secret leaves the host")
    def test_green_baseline_and_not_configured_optionals(self):
        fx = Fixture(self.tmp); rc, p0, post = collect(fx); self.check_no_secrets(p0, post)
        v = P.evaluate(rc, p0, post, pd=str(fx.pd), pf=str(fx.pf))
        self.assertEqual(v["required"], "PASS", json.dumps(v["checks"], indent=1))
        self.assertEqual(v["optional"], {"H1_hostServices": "NOT_CONFIGURED", "C1_challengeReplica": "NOT_CONFIGURED"})
        self.assertEqual(post["logs"]["node"]["notServing"], 0, "lines before the cutover offset are never counted")
        Fixtures.green = (rc, p0, post, str(fx.pd), str(fx.pf))
    def test_configured_host_services_and_challenge(self):
        fx = Fixture(self.tmp, host_services=True, challenge=True); rc, p0, post = collect(fx); self.check_no_secrets(p0, post)
        v = P.evaluate(rc, p0, post, pd=str(fx.pd), pf=str(fx.pf))
        self.assertEqual((v["required"], v["optional"]), ("PASS", {"H1_hostServices": "PASS", "C1_challengeReplica": "PASS"}), json.dumps(v["checks"], indent=1))
    def test_unreadable_or_foreign_p0_baseline_is_never_green(self):
        """Root's counterexample at the native-text level: the EXACT P0 text against a privacy-config that is not JSON, or JSON
        without enclaveNetwork, reports present=false; with an otherwise green post the verdict must stay NOT green."""
        for name, body in (("invalid-json", "{not json"), ("no-enclaveNetwork", json.dumps({"apps": []}))):
            with self.subTest(name):
                tmp = self.tmp / name; tmp.mkdir(); fx = Fixture(tmp)
                rc, p0, post = collect(fx, pre_mut=lambda f, b=body: (f.pd / "network/privacy-config.json").write_text(b))
                self.assertIs(p0["blocks"]["present"], False); self.assertTrue(all(p0["blocks"][k] == "absent" for k in P.BLOCKS))
                rc["params"]["cfgSha"] = p0["blocks"]["cfgSha"]      # even a "bound" sha of an unreadable file is no baseline
                v = P.evaluate(rc, p0, post, pd=str(fx.pd), pf=str(fx.pf))
                self.assertEqual(v["checks"]["P1_propagation"]["verdict"], "UNKNOWN", json.dumps(v["checks"]["P1_propagation"])); self.assertNotEqual(v["required"], "PASS")
    def test_native_level_negatives(self):
        cases = {"status file missing": (lambda fx: (fx.pd / "network/state/status.json").unlink(), "W3_networkApplies", "FAIL"),
                 "platform policy off in local": (lambda fx: appendf(fx.pd / "node-config.local.cmd", "set ENCLAVE_PLATFORM_HOST_POLICY=off\r\n"), "A1_platformPolicy", "FAIL"),
                 "hostEgress dropped by enrollment": (lambda fx: fx.__setattr__("_", (lambda c: (c["enclaveNetwork"].pop("hostEgress"), (fx.pd / "network/privacy-config.json").write_text(json.dumps(c))))(json.loads((fx.pd / "network/privacy-config.json").read_text()))), "P1_propagation", "FAIL"),
                 "persisted platform refusal": (lambda fx: (fx.pd / "node/platform-host-admission.json").write_text(json.dumps({"hostId": R, "knownRefusal": {"status": "authority", "reason": "banned", "at": 1}})), "A1_platformPolicy", "FAIL"),
                 "configCid binding differs": (lambda fx: (fx.pd / "network" / IDS[3] / "expected.json").write_text(json.dumps({"appRef": f"catalog://0x{'a' * 64}/1", "configCid": "other"})), "W4_grants", "FAIL")}
        for name, (mut, check, want) in cases.items():
            with self.subTest(name):
                tmp = self.tmp / re.sub(r"\W", "_", name); tmp.mkdir(); fx = Fixture(tmp); rc, p0, post = collect(fx, mut)
                v = P.evaluate(rc, p0, post, pd=str(fx.pd), pf=str(fx.pf))
                self.assertEqual(v["checks"][check]["verdict"], want, json.dumps(v["checks"][check])); self.assertNotEqual(v["required"], "PASS")
        tmp = self.tmp / "frozen"; tmp.mkdir(); fx = Fixture(tmp); fx.bump = False; rc, p0, post = collect(fx)
        v = P.evaluate(rc, p0, post, pd=str(fx.pd), pf=str(fx.pf)); self.assertEqual(v["checks"]["W2_channel"]["verdict"], "FAIL", "a channel whose revision does not advance is dead")

class Static(unittest.TestCase):
    def test_texts_read_only_bounded_and_fit(self):
        m = P.head(); fx = Fixture.__new__(Fixture); fx.gen = "ab" * 16; fx.agent_start = fx.priv_start = time.time()
        rc = Fixture.receipt(fx, 1234); ts = P.post_texts(rc); ts["logs"] = ts["logs"]({"networkLog": 10}); ts["p0"] = (P.fill(P.P0), 60)
        self.assertEqual(sorted(ts), ["bind", "blocks", "channel", "env", "host", "logs", "p0", "proc"])
        for k, (t, s) in ts.items():
            self.assertLessEqual(P.enc_len(m.HEAD, t, s), P.LIMIT, k)
            for bad in ("Stop-", "Start-Process", "Start-ScheduledTask", "Set-", "Remove-", "New-Item", "Copy-Item", "Move-Item", "Out-File", "Add-Content", "Register-",
                        "Invoke-WebRequest", "-Method", "Restart-", "WriteAll", "Get-Process", "Get-ScheduledTask", "Get-NetTCPConnection"):
                self.assertNotIn(bad, t, (k, bad))
            self.assertEqual(set(re.findall(r"https?://[^'\"]+", t)) - {"http://127.0.0.1:9600/v1/host/state"}, set(), k)
            if "Win32_Process" in t: self.assertIn("-Filter ('ProcessId='+[int]$id)", t, "only the two journaled PIDs, never a listing")
        self.assertIn("Start-Sleep -Seconds 25;", ts["channel"][0])
        # PowerShell aliases beat functions (h = Get-History, r = Invoke-History, ...): no helper may be a bare 1-2 letter name
        for k, (t, s) in ts.items():
            self.assertEqual([n for n in re.findall(r"function ([A-Za-z0-9]+)", t) if len(n) <= 2], [], k)
        bad = dict(rc); bad["journal"] = {"lines": [json.dumps({"final": "DONE: x"})]}
        with self.assertRaises(SystemExit): P.post_texts(bad)

class Negatives(unittest.TestCase):
    """Evaluator negative controls on the green fixture outputs: none may evaluate green."""
    @classmethod
    def setUpClass(cls):
        if not hasattr(Fixtures, "green"):
            tmp = pathlib.Path(tempfile.mkdtemp()); cls.tmp = tmp
            if not pathlib.Path(PWSH).exists(): raise unittest.SkipTest("no pwsh")
            fx = Fixture(tmp); rc, p0, post = collect(fx); Fixtures.green = (rc, p0, post, str(fx.pd), str(fx.pf))
    def ev(self, f=None, rc_f=None, p0_f=None):
        rc, p0, post, pd, pf = copy.deepcopy(Fixtures.green)
        if f: f(post)
        if rc_f: rc_f(rc)
        if p0_f: p0 = p0_f(p0)
        return P.evaluate(rc, p0, post, pd=pd, pf=pf)
    def expect(self, check, verdict, **kw):
        v = self.ev(**kw); self.assertEqual(v["checks"][check]["verdict"], verdict, json.dumps(v["checks"][check])); self.assertNotEqual(v["required"], "PASS"); return v
    def test_green_is_green(self): self.assertEqual(self.ev()["required"], "PASS")
    def test_cutover_final(self):
        def fin(t): return lambda rc: rc["journal"]["lines"].__setitem__(-1, json.dumps({"final": t}))
        self.expect("C0_cutoverDone", "UNKNOWN", rc_f=fin("DONE_PARTIAL: x")); self.expect("C0_cutoverDone", "FAIL", rc_f=fin("ROLLED_BACK: x"))
        self.expect("C0_cutoverDone", "FAIL", rc_f=fin("DONE_CHECK: x"))
    def test_channel_and_status(self):
        for path, val, check, want in [(("channel", "b", "status", "ageMs"), 9000, "W3_networkApplies", "FAIL"), (("channel", "b", "status", "wallet", "applied"), False, "W3_networkApplies", "FAIL"),
                                       (("channel", "a", "status", "wallet", "generation"), "cd" * 16, "W3_networkApplies", "FAIL"), (("channel", "b", "status", "wallet", "runnerOk"), False, "W3_networkApplies", "FAIL"),
                                       (("channel", "b", "status", "wallet", "errorNull"), False, "W3_networkApplies", "FAIL"), (("channel", "b", "doc", "expiresInMs"), -5, "W2_channel", "FAIL"),
                                       (("channel", "b", "doc", "revision"), 1, "W2_channel", "FAIL"), (("channel", "a", "doc", "generation"), "cd" * 16, "W2_channel", "FAIL"),
                                       (("channel", "b", "doc", "runnerOk"), False, "W2_channel", "FAIL"), (("channel", "b", "doc", "version"), 2, "W2_channel", "FAIL")]:
            def f(post, path=path, val=val):
                o = post
                for k in path[:-1]: o = o[k]
                o[path[-1]] = val
            with self.subTest(path=path): self.expect(check, want, f=f)
        self.expect("W2_channel", "UNKNOWN", f=lambda p: p.__setitem__("channel", {}))
    def test_grants(self):
        def idf(k, v, i=2): return lambda p: p["bind"]["ids"][i].__setitem__(k, v)
        for k, v in [("docAllow", False), ("appRefMatch", False), ("configCidMatch", False), ("validInMs", -1), ("validInMs", 200000), ("statusAllow", False),
                     ("walletInMs", -1), ("leaseInMs", -1), ("proofInMs", -1), ("egress", False), ("statusApp", 0), ("expectation", False)]:
            with self.subTest(k=k, v=v): self.expect("W4_grants", "FAIL", f=idf(k, v))
        self.expect("W4_grants", "FAIL", f=lambda p: p["host"]["ids"][0].__setitem__("walletHeld", True))
        self.expect("W4_grants", "FAIL", f=lambda p: p["host"]["ids"][0].__setitem__("status", "held"))
        self.expect("W4_grants", "UNKNOWN", f=lambda p: p.__setitem__("host", {"what": "host", "answered": False}))
        self.expect("W4_grants", "UNKNOWN", f=lambda p: p["bind"]["ids"].pop(4))
    def test_identities(self):
        self.expect("W1_identities", "FAIL", f=lambda p: p["proc"]["agent"].__setitem__("start", "2026-01-01T00:00:00.0000000Z"))
        self.expect("W1_identities", "FAIL", f=lambda p: p["proc"]["agent"].__setitem__("alive", False))
        self.expect("W1_identities", "FAIL", f=lambda p: p["proc"]["privacy"].__setitem__("start", "2026-01-01T00:00:00.0000000Z"))
        self.expect("W1_identities", "UNKNOWN", f=lambda p: (p["proc"]["privacy"].__setitem__("start", "x"), p["logs"]["node"].__setitem__("privacyRestart", 1)))
        self.expect("W1_identities", "UNKNOWN", f=lambda p: p.__setitem__("proc", {}))
    def test_admin_policy(self):
        env = lambda k, v, f="nodeConfig": (lambda p: p["env"][f].__setitem__(k, v))
        self.expect("A1_platformPolicy", "FAIL", f=env("platformPolicy", "off"))
        self.expect("A1_platformPolicy", "FAIL", f=env("platformPolicy", "unset"))
        self.expect("A1_platformPolicy", "FAIL", f=env("platformPolicy", "other"))
        self.expect("A1_platformPolicy", "FAIL", f=lambda p: p["logs"]["node"].__setitem__("notServing", 1))
        self.expect("A1_platformPolicy", "FAIL", f=lambda p: p["logs"]["node"].__setitem__("notServingChange", 1))
        self.expect("A1_platformPolicy", "UNKNOWN", f=lambda p: p["logs"]["node"].__setitem__("admitted", 0))
        self.expect("A1_platformPolicy", "UNKNOWN", f=lambda p: p["logs"].__setitem__("node", {"rotated": True}))
        self.expect("A1_platformPolicy", "FAIL", f=lambda p: p["blocks"]["platformAdmission"].update(knownRefusalNull=False, knownRefusalStatus="authority"))
        self.expect("A1_platformPolicy", "FAIL", f=lambda p: p["blocks"]["platformAdmission"].update(hostIdOk=False))
    def test_owner_wallet_admission(self):
        self.expect("A2_walletAdmission", "FAIL", f=lambda p: p["env"]["nodeConfig"].__setitem__("ENCLAVE_HOST_POLICY_DIR", False))
        self.expect("A2_walletAdmission", "FAIL", f=lambda p: p["env"]["local"].__setitem__("walletHold", False))
        self.expect("A2_walletAdmission", "FAIL", f=lambda p: p["logs"]["node"].__setitem__("channelOff", 1))
        self.expect("A2_walletAdmission", "FAIL", f=lambda p: p["logs"]["node"].__setitem__("channelNotWritten", 1))
        self.expect("A2_walletAdmission", "UNKNOWN", f=lambda p: p["logs"]["node"].__setitem__("channelStarted", 0))
    def test_propagation(self):
        self.expect("P1_propagation", "UNKNOWN", p0_f=lambda p0: None)
        self.expect("P1_propagation", "FAIL", f=lambda p: p["blocks"]["blocks"].__setitem__("walletFile", "absent"))
        self.expect("P1_propagation", "FAIL", f=lambda p: p["blocks"]["blocks"].__setitem__("hostEgress", "0" * 64))
        self.expect("P1_propagation", "FAIL", f=lambda p: p["blocks"]["blocks"].__setitem__("keys", [k for k in p["blocks"]["blocks"]["keys"] if k != "directories"]))
        self.expect("P1_propagation", "UNKNOWN", f=lambda p: p["blocks"]["blocks"].__setitem__("keys", p["blocks"]["blocks"]["keys"] + ["surprise"]))
        self.expect("P1_propagation", "UNKNOWN", f=lambda p: p["proc"].__setitem__("nowMs", int(time.time() * 1000) - 400_000))
        self.expect("P1_propagation", "UNKNOWN", f=lambda p: p["blocks"]["blocks"].__setitem__("hostEgress", None), p0_f=lambda p0: (p0["blocks"].__setitem__("hostEgress", None), p0)[1])
        self.expect("H1_hostServices", "UNKNOWN", f=lambda p: p["blocks"]["blocks"].__setitem__("hostServices", None))
        # a valid baseline but an unread POST hash: unread, never compared (not 'changed', not 'unchanged')
        self.expect("P1_propagation", "UNKNOWN", f=lambda p: p["blocks"]["blocks"].__setitem__("hostEgress", None))
        self.expect("F1_files", "FAIL", f=lambda p: p["proc"]["files"].__setitem__("control/windows/node/network-enroll.mjs", "2d97a0e10e40ceaa0be897708dc3cfa48742619450605efc107b22674caae2ac"))
    def test_optional_services(self):
        def hs(p): p["blocks"]["blocks"].update(hostServices="1" * 64, serviceWorker=Fixtures.green[4] + "\\network\\host-service-ingress.mjs")
        v = self.ev(f=hs); self.assertEqual(v["checks"]["H1_hostServices"]["verdict"], "UNKNOWN", "configured but never started: not green")
        v = self.ev(f=lambda p: (hs(p), p["logs"]["network"].update(hostServicesUp=1, hostServicesRefused=1))); self.assertEqual(v["checks"]["H1_hostServices"]["verdict"], "FAIL")
        v = self.ev(f=lambda p: (hs(p), p["blocks"]["blocks"].update(serviceWorker="C:\\elsewhere.mjs"), p["logs"]["network"].update(hostServicesUp=1))); self.assertEqual(v["checks"]["H1_hostServices"]["verdict"], "FAIL")
        v = self.ev(f=lambda p: (hs(p), p["logs"].__setitem__("network", {"unbounded": True}))); self.assertEqual(v["checks"]["H1_hostServices"]["verdict"], "UNKNOWN")
        v = self.ev(f=lambda p: (p["blocks"]["blocks"].__setitem__("challengeReplica", "2" * 64), p["logs"]["network"].update(challengeNotStarted=1))); self.assertEqual(v["checks"]["C1_challengeReplica"]["verdict"], "FAIL")
        v = self.ev(f=lambda p: p["blocks"]["blocks"].__setitem__("challengeReplica", "2" * 64)); self.assertEqual(v["checks"]["C1_challengeReplica"]["verdict"], "UNKNOWN")
    def test_p0_baseline_and_binding(self):
        def blank(p0):
            p0["blocks"].update(present=False, keys=[], **{k: "absent" for k in P.BLOCKS}); return p0
        self.expect("P1_propagation", "UNKNOWN", p0_f=blank)
        self.expect("P1_propagation", "UNKNOWN", p0_f=lambda p0: (p0["blocks"].__setitem__("cfgSha", "absent"), p0)[1])
        self.expect("P1_propagation", "UNKNOWN", p0_f=lambda p0: (p0["blocks"].__setitem__("keys", []), p0)[1])
        self.expect("P1_propagation", "UNKNOWN", p0_f=lambda p0: (p0["blocks"].__setitem__("hostEgress", "garbled"), p0)[1])
        self.expect("P1_propagation", "UNKNOWN", p0_f=lambda p0: (p0.__setitem__("blocks", None), p0)[1])
        # a stale P0 from ANOTHER operator config (valid in itself) is not bound to this cutover
        self.expect("P1_propagation", "UNKNOWN", p0_f=lambda p0: (p0["blocks"].__setitem__("cfgSha", "9" * 64), p0)[1])
        self.expect("P1_propagation", "UNKNOWN", rc_f=lambda rc: rc["params"].pop("cfgSha"))
        self.expect("P1_propagation", "UNKNOWN", f=lambda p: p["blocks"]["blocks"].__setitem__("cfgSha", "absent"))
    def test_r1_counterexample_is_now_unknown(self):
        """Root's finding against r1 60e7a18b: an unreadable baseline (present=false, all absent) + a post whose only key is
        walletAdmission evaluated P1 PASS. r1 reproduces it; this revision does not."""
        spec = importlib.util.spec_from_file_location("r1", H / "r1/postflight.py"); R1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(R1)
        rc, p0, post, pd, pf = copy.deepcopy(Fixtures.green)
        p0["blocks"].update(present=False, keys=[], cfgSha="absent", **{k: "absent" for k in P.BLOCKS})
        post["blocks"]["blocks"].update(keys=["walletAdmission"], **{k: "absent" for k in P.BLOCKS})
        self.assertEqual(R1.evaluate(rc, p0, post, pd=pd, pf=pf)["checks"]["P1_propagation"]["verdict"], "PASS", "r1 was falsely green")
        v = P.evaluate(rc, p0, post, pd=pd, pf=pf); self.assertEqual(v["checks"]["P1_propagation"]["verdict"], "UNKNOWN"); self.assertNotEqual(v["required"], "PASS")
    def test_receipt_params_bind(self):
        for name, f in (("empty ids", lambda rc: rc["params"].__setitem__("expectedIds", [])), ("missing ids", lambda rc: rc["params"].pop("expectedIds")),
                        ("duplicate ids", lambda rc: rc["params"].__setitem__("expectedIds", rc["params"]["expectedIds"] + rc["params"]["expectedIds"][:1])),
                        ("garbled id", lambda rc: rc["params"]["expectedIds"].__setitem__(0, "0xABC")), ("bad runner", lambda rc: rc["params"].__setitem__("runner", "0x2F" * 1)),
                        ("missing runner", lambda rc: rc["params"].pop("runner"))):
            with self.subTest(name):
                v = self.ev(rc_f=f); self.assertEqual(v["checks"]["B0_receiptBinding"]["verdict"], "UNKNOWN"); self.assertNotEqual(v["required"], "PASS")
        v = self.ev(rc_f=lambda rc: rc["params"].__setitem__("expectedIds", []), f=lambda p: p["bind"].__setitem__("ids", []))
        self.assertEqual(v["checks"]["W4_grants"]["verdict"], "UNKNOWN", "an empty id list is never a vacuous grant PASS")
    def test_empty_evidence_is_never_green(self):
        rc, p0, post, pd, pf = copy.deepcopy(Fixtures.green)
        v = P.evaluate(rc, p0, {}, pd=pd, pf=pf); self.assertNotEqual(v["required"], "PASS")
        self.assertTrue(all(c["verdict"] != "PASS" for k, c in v["checks"].items() if k not in ("C0_cutoverDone", "B0_receiptBinding")), json.dumps(v["checks"], indent=1))
class Runner(unittest.TestCase):
    """run-postflight.py with a FAKE transport (no ssh): saves O_EXCL receipts, evaluates, refuses a non-DONE cutover."""
    def test_runner_with_fake_transport(self):
        if not hasattr(Fixtures, "green"): self.skipTest("needs the fixture outputs")
        rc, p0, post, pd, pf = copy.deepcopy(Fixtures.green)
        spec = importlib.util.spec_from_file_location("rp", H / "run-postflight.py"); RP = importlib.util.module_from_spec(spec); spec.loader.exec_module(RP)
        real = P.head(); sent = []
        class M: HEAD = real.HEAD
        import base64, gzip
        def ps(text, secs=150):
            sent.append(text); w = re.search(r"what='([a-z0-9]+)'", text).group(1)
            if w == "parse":
                inner = gzip.decompress(base64.b64decode(re.search(r"FromBase64String\('([^']+)'\)", text).group(1))).decode()
                return {"what": "parse", "sha256": hashlib.sha256(inner.encode()).hexdigest(), "errors": 0, "ids": []}
            return copy.deepcopy(p0 if w == "p0" else post[w])
        M.ps = staticmethod(ps); RP.P.head = lambda: M
        tmp = pathlib.Path(tempfile.mkdtemp()); RP.OUT = tmp
        try:
            (tmp / "r.json").write_text(json.dumps(rc)); (tmp / "p0.json").write_text(json.dumps(p0))
            orig = RP.P.evaluate; RP.P.evaluate = lambda r, a, b: orig(r, a, b, pd=pd, pf=pf)
            self.assertEqual(RP.main(["--pre"]), 0); self.assertEqual(RP.main(["--post", "--receipt", str(tmp / "r.json"), "--p0", str(tmp / "p0.json")]), 0)
            self.assertEqual(len(list(tmp.glob("verdict-*.json"))), 1); self.assertEqual(len(sent), 9, "p0 parse + p0 + the 7 post texts, once each")
            bad = copy.deepcopy(rc); bad["journal"]["lines"][-1] = json.dumps({"final": "ROLLED_BACK: x"}); (tmp / "b.json").write_text(json.dumps(bad))
            with self.assertRaises(SystemExit): RP.main(["--post", "--receipt", str(tmp / "b.json")])
        finally: RP.P.evaluate = orig; shutil.rmtree(tmp)
if __name__ == "__main__": unittest.main()
