#!/usr/bin/env python3
"""Offline tests of tools/riso-probe.py: static guards on the remote texts + a Linux pwsh fixture run of the EXACT texts
(Invoke-RestMethod replaced by a local function; paths rooted in a temp dir). No remote access; mocks are not native evidence."""
import importlib.util, json, os, pathlib, re, shutil, subprocess, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent; W = H.parents[2]
spec = importlib.util.spec_from_file_location("rp", H / "riso-probe.py"); R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
PWSH = os.environ.get("PWSH", str(W / "node-hold-package-20261021/tools/pwsh/pwsh"))
SNAP = json.loads((W / "root-live-control-20261022/snapshot.json").read_text())
RUNNING = sorted(l["id"] for l in SNAP["state"]["leases"] if l["status"] == "running")
SECRETS = ["S3CRET-ONE", "S3CRET-TWO", "SECRETVOLNAME", "S3CRET-THREE"]
HEALTH = {"managerEpoch": 7, "supports": {"config": True, "configCid": True, "secrets": True, "gpu": False, "egress": "yes"},
          "volumes": [{"kind": "model", "name": "SECRETVOLNAME"}, {"kind": "other", "name": "x"}], "inference": None}

def pid(n): return "0x" + f"{n:02x}" * 32

class Probe(unittest.TestCase):
    def test_texts_are_read_only_bounded_and_fit(self):
        h = R.head(); ts = R.texts(RUNNING, {}, h)
        self.assertEqual(len(RUNNING), 9); self.assertGreaterEqual(len(ts), 2)
        for t in ts:
            self.assertLessEqual(R.enc_len(h, t), R.LIMIT)
            for bad in ("Win32_Process", "Get-CimInstance", "Get-Process", "Get-ScheduledTask", "Stop-", "Start-", "Set-", "Remove-", "New-Item", "Copy-Item",
                        "Move", "WriteAll", "Out-File", "Add-Content", "Invoke-WebRequest", "-Method", "Register-", "secrets\\", "Get-ChildItem", "Get-Content"):
                self.assertNotIn(bad, t, bad)
            self.assertEqual(set(re.findall(r"https?://[^'\"]+", t)) - {"http://127.0.0.1:8091/health"}, set(), "only the manager's /health")
        self.assertEqual(sum(t.count("'" + i + "|'") for t in ts for i in RUNNING), 9, "each expected id exactly once")
        with self.assertRaises(SystemExit): R.texts(["0xABC"], {}, h)
        with self.assertRaises(SystemExit): R.texts(RUNNING, {RUNNING[0]: "../../x"}, h)

    def test_pwsh_fixture_flags_never_values(self):
        if not pathlib.Path(PWSH).exists(): self.skipTest("no pwsh")
        tmp = pathlib.Path(tempfile.mkdtemp())
        try:
            apps = tmp / "node" / "apps"; apps.mkdir(parents=True); (tmp / "network").mkdir()
            def cfg(cid, obj): (apps / f"cfg-{cid}.json").write_text(json.dumps(obj))
            env = {  # id -> (expectation configCid field, version CID passed in or "")
                1: ("", "bafyversion000001"), 2: (json.dumps({"config": {"encVolumes": [{"maxMb": 64}], "token": "S3CRET-ONE"}, "isolation": {"require": "hyperv-partition-per-app"}}), ""),
                3: (json.dumps({"configCid": "bafyenvcid0000003"}), ""), 4: (json.dumps({"configCid": "bafyabsent0000004"}), ""),
                5: (json.dumps({"config": {"EncVolumes": [1], "volumes": []}}), ""), 6: (json.dumps({"guestBootstrap": {"k": "S3CRET-TWO"}, "isolation": {}}), ""),
                8: (json.dumps({"config": {"encVolumes": False, "volumes": ["  "]}}), ""), 9: ("", ""), 10: ("bafybarecid0000010", ""),
                11: (json.dumps({"config": "not-an-object"}), ""), 12: (json.dumps({"configCid": "bafyenvcid0000012", "config": {"encVolumes": [1]}}), "")}
            cfg("bafyversion000001", {"volumes": ["llama-7b"], "apiKey": "S3CRET-THREE"})
            cfg("bafyenvcid0000003", {"_media": {"icon": "x"}})
            cfg("bafyenvcid0000012", {"volumes": [], "encVolumes": {}})
            pc = {"relay": "x", "apps": []}
            for n, (cc, _) in env.items():
                e = tmp / f"exp-{n}.json"; e.write_text(json.dumps({"appRef": "catalog://0x" + "a" * 64 + "/1", "configCid": cc})); pc["apps"].append({"deploymentId": pid(n), "expectedFile": str(e)})
            (tmp / "network" / "privacy-config.json").write_text(json.dumps(pc))
            ids = [pid(n) for n in sorted(list(env) + [7])]
            items = [f"{pid(n)}|{env[n][1] if n in env else ''}" for n in sorted(list(env) + [7])]
            stub = "function Invoke-RestMethod { param([switch]$UseBasicParsing, $TimeoutSec, $Uri) if ($Uri -ne 'http://127.0.0.1:8091/health') { throw 'unexpected uri' }; '" + json.dumps(HEALTH) + "' | ConvertFrom-Json }\n"
            outs = []
            for text in (R.MGR, R.apps_text(items, pd=str(tmp))):
                f = tmp / "t.ps1"; f.write_text(stub + text)
                r = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(f)], capture_output=True, text=True, timeout=120)
                self.assertEqual(r.returncode, 0, r.stderr[-800:]); outs.append(r.stdout.strip().splitlines()[-1])
            for s in SECRETS + ["llama-7b", "icon", str(tmp)]:
                for o in outs: self.assertNotIn(s, o, "no config value, volume name or path in the output")
            mgr, ap = json.loads(outs[0]), json.loads(outs[1])
            self.assertEqual({k: mgr[k] for k in ("answered", "config", "configCid", "secrets", "encVolumes", "modelVolumes", "nnPreload", "modelVolumesHeld", "inference")},
                             {"answered": True, "config": True, "configCid": True, "secrets": True, "encVolumes": "absent", "modelVolumes": "absent", "nnPreload": "absent", "modelVolumesHeld": 1, "inference": False})
            by = {a["id"]: a for a in ap["apps"]}
            self.assertEqual([by[pid(n)]["src"] for n in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)],
                             ["version", "envelope-inline", "envelope-cid", "envelope-cid", "envelope-inline", "owner-startup", "no-expectation", "envelope-inline", "version", "bare-envelope", "envelope-inline", "envelope-cid"])
            self.assertTrue(by[pid(1)]["flags"]["volNonEmpty"]); self.assertTrue(by[pid(2)]["flags"]["encNonEmpty"]); self.assertTrue(by[pid(3)]["flags"]["mediaOnly"])
            self.assertEqual(by[pid(4)]["flags"], "absent"); self.assertFalse(by[pid(5)]["flags"]["encKey"], "keys are case-sensitive, as in JS")
            self.assertEqual((by[pid(8)]["flags"]["encNonEmpty"], by[pid(8)]["flags"]["volNonEmpty"]), (False, False)); self.assertEqual(by[pid(11)]["flags"], "not-an-object")
            self.assertEqual((by[pid(12)]["cid"], by[pid(12)]["flags"]["encNonEmpty"]), ("bafyenvcid0000012", False), "configCid wins over inline config (strictCid)")
            ev = R.evaluate({"expectedIds": ids, "manager": mgr, "apps": [ap]}, {pid(3): {"volNonEmpty": False}, pid(9): {"volNonEmpty": False, "encNonEmpty": False}})
            v = {r["id"]: r["verdict"] for r in ev["rows"]}
            self.assertEqual([v[pid(n)] for n in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)],
                             ["AT_RISK", "AT_RISK", "SAFE", "UNKNOWN", "SAFE", "UNKNOWN", "UNKNOWN", "SAFE", "SAFE", "UNKNOWN", "UNKNOWN", "SAFE"])
            self.assertNotEqual(ev["riso"], "PASS")
            ok = R.evaluate({"expectedIds": [pid(5), pid(8)], "manager": mgr, "apps": [{"apps": [by[pid(5)], by[pid(8)]]}]}, {})
            self.assertEqual(ok["riso"], "PASS")
            self.assertNotEqual(R.evaluate({"expectedIds": [pid(5), pid(8)], "manager": mgr, "apps": [{"apps": [by[pid(5)]]}]}, {})["riso"], "PASS", "a missing id never passes")
            inf = dict(mgr, inference=True)
            self.assertEqual(R.verdict(by[pid(5)], inf, {})[0], "UNKNOWN"); self.assertEqual(R.verdict(by[pid(5)], inf, {pid(5): {"gpuMilli": 0}})[0], "SAFE")
            self.assertEqual(R.verdict(by[pid(1)], dict(mgr, modelVolumes=True), {})[0], "UNKNOWN", "supported: held-name rules remain")
            self.assertEqual(R.verdict(by[pid(5)], {"answered": False}, {})[0], "UNKNOWN")
        finally: shutil.rmtree(tmp)
if __name__ == "__main__": unittest.main()
