#!/usr/bin/env python3
"""Local tests of probe/recovery-probe.py (nothing reaches minipc: the transport module is loaded for its HEAD only and its
ps() is replaced by a refusal). python3 -m unittest -v test_recovery_probe
  1. every step fits root's transport (<= 7900 encoded) and parses (pwsh 7.4) with 0 errors;
  2. READ-ONLY by AST: every command, .NET member and assignment target is on an allowlist; no file redirection;
  3. the steps run against stubbed Windows cmdlets and produce JSON; the gates judge a healthy fixture and each injected
     fault exactly as intended; a failed step never yields PASS."""
import copy, importlib.util, json, os, pathlib, stat, subprocess, tempfile, time, unittest
H = pathlib.Path(__file__).resolve().parent; P = H.parent / "probe"
PWSH = str(H.parent.parent / "g4-node-final-package-20261021/tools/pwsh/pwsh")
spec = importlib.util.spec_from_file_location("probe", os.environ.get("RECOVERY_PROBE", P / "recovery-probe.py"))   # override: mutant runs only
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
R.load_transport(); R.m.ps = lambda *a, **k: (_ for _ in ()).throw(AssertionError("a test tried to reach minipc"))

READ_CMDS = {"Get-Date", "Get-NetTCPConnection", "ForEach-Object", "Where-Object", "New-Object", "Get-NetIPAddress", "Find-NetRoute", "ConvertTo-Json",
             "ConvertFrom-Json", "Get-NetAdapter", "Get-NetRoute", "Get-NetConnectionProfile", "Get-VMSwitch", "Get-CimInstance", "FileSha", "Get-Item",
             "Get-NetFirewallRule", "Get-NetFirewallPortFilter", "Get-NetFirewallAddressFilter", "Get-NetFirewallProfile", "Get-ItemProperty", "Get-LocalUser",
             "Test-Path", "Get-ScheduledTask", "Get-ScheduledTaskInfo", "Get-ChildItem", "Join-Path", "Select-Object", "Get-Content", "Id", "Pick"}
# the ONLY native call: sc.exe qfailure sshd (read-only), and the scriptblock that relaxes Stop for it (its inner command is
# itself listed and checked: FindAll recurses)
SC = 'EXPR:"$env:SystemRoot\\System32\\sc.exe" qfailure sshd'
READ_EXPR = {SC, "EXPR:{$ErrorActionPreference='Continue';& " + SC[5:] + " 2>&1} "}
READ_MEMBERS = {"new", "GetCurrent", "IsInRole", "ToUniversalTime", "ToString", "Trim", "Substring", "Min", "ReadAllText", "Match"}
WRITE_VARS = ("$env:",)    # no environment / global / script scope writes

def now_plus(sec): return time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(time.time() + sec))

def healthy():
    procs = [{"Name": "sshd.exe", "pid": 3100, "ppid": 700, "cmd": "sshd.exe", "start": "2026-10-20 08:00:00Z"},
             {"Name": "sshd.exe", "pid": 5000, "ppid": 3100, "cmd": "sshd.exe -R", "start": now_plus(-5)},
             {"Name": "cmd.exe", "pid": 23976, "ppid": 1, "cmd": 'cmd.exe /c "C:\\ProgramData\\Enclave\\run-node.cmd"', "start": "2026-10-21 15:01:03Z"},
             {"Name": "node.exe", "pid": 8644, "ppid": 23976, "cmd": '"node.exe" "C:\\Program Files\\Enclave\\control\\windows\\node\\agent.mjs"', "start": "2026-10-21 15:01:03Z"},
             {"Name": "node.exe", "pid": 38416, "ppid": 3001, "cmd": '"node.exe" "C:\\Program Files\\Enclave\\network\\privacy-agent.mjs" --config x', "start": "2026-10-21 00:05:03Z"},
             {"Name": "node.exe", "pid": 4001, "ppid": 4000, "cmd": "node.exe manager\\main.mjs", "start": "2026-10-21 12:13:07Z"}]
    tasks = [{"path": "\\Enclave\\", "name": n, "state": "Running", "enabled": True, "exe": "cmd.exe", "args": f'/c "C:\\ProgramData\\Enclave\\run-{n.lower()}.cmd"',
              "triggers": [{"kind": "Boot", "enabled": True, "delay": d, "every": ""}], "next": None, "last": "2026-10-20 08:01:00Z"}
             for n, d in (("Node", "PT90S"), ("Network", "PT120S"), ("Shield", "PT30S"))]
    tasks.append({"path": "\\Enclave\\", "name": "Update", "state": "Ready", "enabled": True, "exe": "powershell.exe", "args": "-File update-host.ps1",
                  "triggers": [{"kind": "Boot", "enabled": True, "delay": "PT5M", "every": ""}, {"kind": "Time", "enabled": True, "delay": "", "every": "PT1H"}],
                  "next": now_plus(50 * 60), "last": now_plus(-10 * 60)})
    return {"sshConnection": "192.168.8.10 50522 192.168.8.238 22",
            "tcp": [{"LocalAddress": "0.0.0.0", "LocalPort": 22, "State": "Listen", "RemoteAddress": "0.0.0.0", "RemotePort": 0, "OwningProcess": 3100},
                    {"LocalAddress": "::", "LocalPort": 22, "State": "Listen", "RemoteAddress": "::", "RemotePort": 0, "OwningProcess": 3100},
                    {"LocalAddress": "192.168.8.238", "LocalPort": 22, "State": "Established", "RemoteAddress": "192.168.8.10", "RemotePort": 50522, "OwningProcess": 5000},
                    {"LocalAddress": "127.0.0.1", "LocalPort": 8091, "State": "Listen", "RemoteAddress": "0.0.0.0", "RemotePort": 0, "OwningProcess": 4001}],
            "ips": [{"IPAddress": "192.168.8.238", "InterfaceIndex": 7, "InterfaceAlias": "Ethernet", "PrefixLength": 24, "PrefixOrigin": "Dhcp", "SuffixOrigin": "Dhcp", "ValidSec": 80000, "AddressState": "Preferred"}],
            "routeToClient": [{"prefix": "192.168.8.0/24", "ifIndex": 7, "nextHop": "0.0.0.0"}],
            "adapters": [{"Name": "Ethernet", "InterfaceDescription": "Realtek", "ifIndex": 7, "Status": "Up", "HardwareInterface": True, "Virtual": False, "LinkSpeed": "1 Gbps"}],
            "defaultRoutes": [{"DestinationPrefix": "0.0.0.0/0", "InterfaceIndex": 7, "InterfaceAlias": "Ethernet", "NextHop": "192.168.8.1", "RouteMetric": 0, "InterfaceMetric": 25, "Protocol": "DHCP", "Store": "ActiveStore"}],
            "profiles": [{"InterfaceAlias": "Ethernet", "InterfaceIndex": 7, "NetworkCategory": "Private", "IPv4Connectivity": "Internet"}],
            "vmSwitches": [], "services": {"sshd": {"State": "Running", "StartMode": "Auto", "DelayedAutoStart": False, "ProcessId": 3100, "PathName": "C:\\Windows\\System32\\OpenSSH\\sshd.exe"},
                                          "TermService": {"State": "Stopped", "StartMode": "Manual"}, "WinRM": {"State": "Stopped", "StartMode": "Manual"}},
            "procs": procs, "lastBoot": "2026-10-20 07:58:00Z", "sshdVersion": "9.5.4.1",
            "sha": {"C:\\Windows\\System32\\OpenSSH\\sshd.exe": "a" * 64, "C:\\ProgramData\\ssh\\sshd_config": R.SSHD_CONFIG},
            "fwRule": {"Enabled": "True", "Action": "Allow", "Direction": "Inbound", "Profile": "Any", "port": "22"},
            "fwProfiles": [{"Name": n, "Enabled": "True", "DefaultInboundAction": "NotConfigured"} for n in ("Domain", "Private", "Public")],
            "reg": {"fDenyTSConnections": 1}, "users": [], "exists": ["C:\\ProgramData\\Enclave\\logs\\update.log"], "dirs": {}, "tasks": tasks,
            "updateLog": ["2026-10-19T09:00:00Z update 1.4.0 -> 1.4.1 for 'minipc': UNSIGNED legacy channel x", "2026-10-19T09:03:00Z updated to 1.4.1"],
            "updateLogWritten": "2026-10-19 09:03:00Z", "fail": []}

class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = pathlib.Path(tempfile.mkdtemp(prefix="recovery-probe-")); cls.steps = cls.tmp / "steps.json"
        cls.steps.write_text(json.dumps(R.STEPS))
        sysroot = str(cls.tmp / "win"); sc = pathlib.Path(sysroot + "\\System32\\sc.exe")      # a Linux file named '...win\System32\sc.exe'
        sc.write_text("#!/bin/sh\nprintf '[SC] QueryServiceConfig2 SUCCESS\\n\\nSERVICE_NAME: sshd\\n        RESET_PERIOD (in seconds)    : 86400\\n        REBOOT_MESSAGE               :\\n        COMMAND_LINE                 :\\n        FAILURE_ACTIONS              : RESTART -- Delay = 60000 milliseconds.\\n'\n")
        sc.chmod(sc.stat().st_mode | stat.S_IEXEC); cls.env = dict(os.environ, SystemRoot=sysroot)
    def run_mock(self, fx):
        f = self.tmp / "fixture.json"; f.write_text(json.dumps(fx))
        c = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(H / "mock-run.ps1"), "-Fixture", str(f), "-StepsJson", str(self.steps)],
                           capture_output=True, text=True, timeout=180, env=self.env)
        self.assertEqual(c.returncode, 0, c.stderr[-800:])
        raw = json.loads(c.stdout.strip().splitlines()[-1]); return {k: json.loads(v) for k, v in raw.items()}
    def results(self, out): return {k: v["result"] for k, v in R.gates(out).items()}

    def test_fits_transport_and_parses(self):
        for k, v in R.STEPS.items(): self.assertLessEqual(R.enc_len(v), 7900, k)
        lint = json.loads(subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(H / "ast-lint.ps1"), "-StepsJson", str(self.steps)],
                                         capture_output=True, text=True, timeout=120).stdout)
        for k, v in lint.items(): self.assertEqual(v["errors"] or [], [], k)
        print("\nencoded sizes:", {k: R.enc_len(v) for k, v in R.STEPS.items()})
    def test_read_only_by_ast(self):
        lint = json.loads(subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(H / "ast-lint.ps1"), "-StepsJson", str(self.steps)],
                                         capture_output=True, text=True, timeout=120).stdout)
        for k, v in lint.items():
            cmds = set(v["commands"] or [])
            self.assertEqual(cmds - READ_CMDS - READ_EXPR, set(), f"{k}: a command outside the read-only allowlist")
            self.assertEqual(set(v["members"] or []) - READ_MEMBERS, set(), f"{k}: a .NET member outside the read-only allowlist")
            self.assertEqual(v["redirections"] or [], [], f"{k}: a file redirection")
            self.assertFalse([a for a in (v["assignments"] or []) if a.startswith(WRITE_VARS) or ":" in a.split("[")[0]], f"{k}: a scoped/env assignment {v['assignments']}")
        # nothing names a key file, a config file's CONTENT, or the hold/privacy configs at all
        texts = "\n".join(R.STEPS.values())
        presence = "Test-Path -LiteralPath 'C:\\ProgramData\\ssh\\enc-ctl-tunnel_authorized_keys'"
        self.assertEqual(texts.count("authorized_keys"), texts.count(presence), "a keys file is only ever tested for PRESENCE")
        texts = texts.replace(presence, "")
        for bad in ("authorized_keys", "administrators_authorized_keys", "privacy-config", "node-config", "wallet-admission", "ReadAllBytes", "Set-", "Remove-", "Start-", "Stop-", "Restart-", "Register-", "Disable-", "Enable-"):
            self.assertNotIn(bad, texts.replace("Start-Sleep", ""), bad)
        self.assertIn("FileSha 'C:\\ProgramData\\ssh\\sshd_config'", texts, "sshd_config: its SHA only")
    def test_healthy_fixture_gates(self):
        out = self.run_mock(healthy()); g = self.results(out)
        self.assertNotIn("probe", g, {k: v for k, v in out.items() if v.get("error")})
        for k in ("L1 lanSession", "L2 listener", "L3 sshdService", "L4 sshdConfigPinned", "L5 addressStable", "L6 returnPath", "L7 firewallRule", "T1 tunnelQuiet", "U1 updaterIdle", "B1 noPendingReboot"):
            self.assertEqual(g[k], "PASS", (k, R.gates(out)[k]))
        self.assertEqual((g["U2 noNewerRelease"], g["A1 independentAdminPath"], g["B2 bootStartsNode"]), ("UNKNOWN", "UNKNOWN", "FAIL"))
        self.assertEqual(out["sshd"]["failureActions"][-1], "FAILURE_ACTIONS              : RESTART -- Delay = 60000 milliseconds.")
        self.assertEqual(out["update"]["updateLog"]["attempts"], ["2026-10-19T09:00:00Z 1.4.0->1.4.1"], "versions and times only, never the log line")
        self.assertEqual(out["session"]["thisSession"][0]["pid"], 5000)
    def test_each_fault_flips_exactly_its_gate(self):
        def f(mut): fx = healthy(); mut(fx); return fx
        cases = [("L1 lanSession", lambda fx: fx.update(sshConnection="127.0.0.1 50522 127.0.0.1 22", tcp=fx["tcp"] + [{"LocalAddress": "127.0.0.1", "LocalPort": 22, "State": "Established", "RemoteAddress": "127.0.0.1", "RemotePort": 50522, "OwningProcess": 5001}],
                                                    ips=fx["ips"] + [{"IPAddress": "127.0.0.1", "InterfaceIndex": 1, "InterfaceAlias": "Loopback", "PrefixLength": 8, "PrefixOrigin": "WellKnown", "SuffixOrigin": "WellKnown", "ValidSec": 10**9, "AddressState": "Preferred"}],
                                                    routeToClient=[{"prefix": "127.0.0.0/8", "ifIndex": 1, "nextHop": "0.0.0.0"}], profiles=fx["profiles"] + [{"InterfaceAlias": "Loopback", "InterfaceIndex": 1, "NetworkCategory": "Private", "IPv4Connectivity": "NoTraffic"}])),
                 ("L3 sshdService", lambda fx: fx["services"]["sshd"].update(StartMode="Manual")),
                 ("L4 sshdConfigPinned", lambda fx: fx["sha"].update({"C:\\ProgramData\\ssh\\sshd_config": "b" * 64})),
                 ("L5 addressStable", lambda fx: fx["ips"][0].update(ValidSec=600)),
                 ("L6 returnPath", lambda fx: fx.update(routeToClient=[{"prefix": "0.0.0.0/0", "ifIndex": 9, "nextHop": "10.0.0.1"}])),
                 ("L7 firewallRule", lambda fx: fx["fwRule"].update(Profile="Public")),
                 ("T1 tunnelQuiet", lambda fx: fx.update(users=["enc-ctl-tunnel"])),
                 ("T1 tunnelQuiet", lambda fx: fx["tasks"].append({"path": "\\", "name": "EnclaveTunnelGuard-r1", "state": "Ready", "enabled": True, "exe": "powershell.exe", "args": "", "triggers": [], "next": None, "last": None})),
                 ("U1 updaterIdle", lambda fx: fx["tasks"][3].update(next=now_plus(5 * 60))),
                 ("U1 updaterIdle", lambda fx: fx["tasks"][3].update(state="Running")),
                 ("U1 updaterIdle", lambda fx: fx["procs"].append({"Name": "powershell.exe", "pid": 777, "ppid": 1, "cmd": "powershell -File C:\\Program Files\\Enclave\\update-host.ps1", "start": now_plus(-60)})),
                 ("B1 noPendingReboot", lambda fx: fx.update(exists=["HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired"]))]
        base = self.results(self.run_mock(healthy()))
        for gate, mut in cases:
            g = self.results(self.run_mock(f(mut)))
            changed = {k for k in g if g[k] != base.get(k)}
            self.assertEqual(g[gate], "FAIL", (gate, R.gates(self.run_mock(f(mut)))[gate]))
            self.assertEqual(changed, {gate}, f"{gate}: only its gate changes, got {changed}")
    def test_failed_step_is_never_pass(self):
        fx = healthy(); fx["fail"] = ["processes", "tcp"]; out = self.run_mock(fx); g = self.results(out)
        self.assertIn("step threw", out["processes"]["error"])
        self.assertEqual(g["probe"], "FAIL")
        for k in ("U1 updaterIdle", "B1 noPendingReboot"): self.assertEqual(g[k], "UNKNOWN", k)      # processes failed
        for k in ("L1 lanSession", "L2 listener"): self.assertEqual(g[k], "UNKNOWN", k)              # the :22 reads errored inside the step
        self.assertEqual(self.results({})["L1 lanSession"], "UNKNOWN"); self.assertEqual(self.results({})["probe"], "FAIL")

if __name__ == "__main__": unittest.main()
