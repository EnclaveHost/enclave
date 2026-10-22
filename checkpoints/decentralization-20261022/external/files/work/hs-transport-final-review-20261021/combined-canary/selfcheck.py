#!/usr/bin/env python3
"""LOCAL self-check of the combined-canary helpers (reviewer 9d). No ssh, no remote call: builds every remote text, checks the
encoded length (<= 7900, cmd.exe 8191) and leftover placeholders, compiles the provider program, runs the privacy-config
transform on a synthetic config, and builds an r5d bundle with a FAKE receipt sha into a temp dir."""
import base64, importlib.util, json, pathlib, subprocess, sys, tempfile
H = pathlib.Path(__file__).resolve().parent; res = {}
def load(n):
    sp = importlib.util.spec_from_file_location(n.replace("-", "_"), H / n); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m
a1 = load("root-a1-provider.py")
for mode, st in (("preflight", None), ("stage", "a1"), ("stage", "a5"), ("execute", "a1"), ("execute", "a5"), ("rollback", "a5"), ("rollback", "a1")):
    p = a1.params("ca-east", mode, st)
    compile("import base64, json\nP = json.loads(base64.b64decode(%r))\n" % base64.b64encode(json.dumps(p).encode()).decode() + a1.REMOTE, "remote", "exec")
res["a1"] = {"remoteCompiles": 7, "a1DropinSha": a1.dropin_sha("a1"), "a5DropinSha": a1.dropin_sha("a5"), "expectAddedA1": a1.params("ca-east", "execute", "a1")["expectAdded"]}
a2 = load("root-a2-minipc.py"); a2.verify_local(); m = a2.m
S = r"C:\ProgramData\Enclave\staging\a2-0123456789ab"
texts = {"PRE": a2.PRE.replace("TARGETS", ",".join(a2.q(v[1]) for v in a2.FILES.values())).replace("CFGX", a2.CFG),
         "AGENT": a2.AGENT.replace("PIDX", "12345").replace("STARTX", a2.q("2026-10-21T00:05:03.7361540Z"))}
for k, v in a2.FILES.items():
    if v[4] == "put":
        for n, t in (("PUT", a2.PUT), ("UNPUT", a2.UNPUT)):
            texts[f"{n}-{k}"] = t.replace("TX", a2.q(v[1])).replace("SX", a2.q(a2.staged(S, k))).replace("OX", a2.q(v[2])).replace("NX", a2.q(v[3])).replace("PX", a2.q(S + "\\put-private"))
b64 = lambda v: base64.b64encode(json.dumps(v).encode()).decode()
for c in ("http", "dns", "none"):
    js = a2.JS.replace("WANT", b64(a2.HS.get(c))).replace("WORKERX", b64(a2.WORKER)); assert '"' not in js, "double quote in the node program"
    texts["CONF-" + c] = a2.CONF.replace("CFGX", a2.CFG).replace("EXPX", a2.q("0" * 64)).replace("JSX", base64.b64encode(js.encode()).decode())
# run_script texts (built as a2.run_script would, without sending)
cap = {}
a2.m.ps = lambda text, secs=150: cap.setdefault("t", []).append((text, secs)) or {}
for k, v in a2.FILES.items():
    if v[4] == "swap": a2.change(S, k); a2.change(S, k, back=True)
a2.run_script(S, "node-restart.ps1", {"Mode": "restart", "ExpectRunNodeSha": a2.RUN_NODE, "ExpectAgentPid": 9108, "ExpectAgentStart": "2026-10-21T07:42:22.7980880Z",
              "ExpectCmdPid": 39108, "ExpectCmdStart": "2026-10-21T07:42:22.7016010Z", "ExpectManagerPid": 35464, "ExpectManagerStart": "2026-10-21T12:13:07.5552110Z", "MaxPauseSec": 120}, 330)
for i, (t, s) in enumerate(cap["t"]): texts[f"run_script-{i}"] = t
L = lambda t: len(base64.b64encode((m.HEAD.replace("SECS", "330") + t).encode("utf-16-le")))
ph = ("TARGETS", "CFGX", "PIDX", "STARTX", "TX", "SX", "OX", "NX", "PX", "EXPX", "JSX", "WANT", "WORKERX")
strip = {}   # the base64 program inserted last into CONF is data, not text to scan
for c in ("http", "dns", "none"):
    js = a2.JS.replace("WANT", b64(a2.HS.get(c))).replace("WORKERX", b64(a2.WORKER)); strip["CONF-" + c] = base64.b64encode(js.encode()).decode()
res["a2"] = {"encoded": {k: L(t) for k, t in texts.items()},
             "placeholdersLeft": {k: [p for p in ph if p in t.replace(strip.get(k, "\0"), "").replace("ExpectCurrent", "").replace("TimeoutSec", "")] for k, t in texts.items()}}
res["a2"]["maxEncoded"] = max(res["a2"]["encoded"].values())
# the privacy-config transform on a synthetic config (key order as the live one, probe 18:10Z)
with tempfile.TemporaryDirectory() as d:
    src = pathlib.Path(d, "cfg.json"); dst = pathlib.Path(d, "out.json")
    en = {k: k for k in ["relay", "checkers", "apps", "control", "wgBinary", "nodeBinary", "workerModule", "firewallBinary", "directories", "paid", "hostEgress", "paceMbps"]}
    src.write_text(json.dumps({"version": 2, "apps": [], "enclaveNetwork": en}, indent=2))
    out = {}
    for c in ("http", "dns", "none"):
        js = a2.JS.replace("WANT", b64(a2.HS.get(c))).replace("WORKERX", b64(a2.WORKER))
        r = subprocess.run(["node", "-e", js, str(src), str(dst)], capture_output=True, text=True); assert r.returncode == 0, r.stderr
        e = json.loads(dst.read_text())["enclaveNetwork"]; out[c] = {"keys": list(e)[-3:], "hostServices": e.get("hostServices"), "worker": e.get("serviceWorkerModule")}
        src.write_text(dst.read_text())
    res["a2"]["configTransform"] = out
# r5d: deterministic config + a bundle with a FAKE receipt sha (shape only)
with tempfile.TemporaryDirectory() as d:
    r = subprocess.run(["node", str(H / "make-r5d.mjs"), "--old-receipt-sha", "f" * 64, "--out", d + "/b"], capture_output=True, text=True); assert r.returncode == 0, r.stderr
    j = json.loads(r.stdout); man = json.loads(pathlib.Path(d, "b/upgrade-manifest.json").read_text())
    res["r5d"] = {"r5dConfigSha": j["r5dConfigSha"], "diff": j["diff"], "replace": man["replace"], "add": man["add"], "unchanged": len(man["unchanged"]), "config": man["config"]}
print(json.dumps(res, indent=1))
bad = res["a2"]["maxEncoded"] > 7900 or any(res["a2"]["placeholdersLeft"].values())
print("SELFCHECK", "FAIL" if bad else "PASS"); sys.exit(1 if bad else 0)
