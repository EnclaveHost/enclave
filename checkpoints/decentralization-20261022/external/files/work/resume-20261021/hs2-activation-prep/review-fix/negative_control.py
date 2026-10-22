"""NEGATIVE CONTROL (read-only): the ORIGINAL pinned helper 114fbbe6 / lib 6e14639c, loaded from the parent directory
without modification and driven with the same stubs as test_hs2.py (no host, no ssh). Receipts go to a temp dir, never
to the running helper's receipts/. Shows each gap root reported is real in the original.  run: python3 negative_control.py"""
import copy, hashlib, importlib.util, json, pathlib, shutil, subprocess, sys, tempfile
ORIG = pathlib.Path(__file__).resolve().parent.parent
assert hashlib.sha256((ORIG / "root-hs2-activate.py").read_bytes()).hexdigest() == "114fbbe6d941d0d8ffa3dc34fe97e766b48c014dd7bbb9f7fac8265dd0e9039e"
assert hashlib.sha256((ORIG / "hs2lib.py").read_bytes()).hexdigest() == "6e14639cf57a5750eeb111d917935c5a16cdde4a7632560ccae62f11e701a82b"
sys.path.insert(0, str(ORIG))
import hs2lib as L

SUMS = {"windows/common.ps1": "779498ac137d417c472f324c2f1e5ed3789792d4e62b9bfcb60b88ddd76feb2b", "windows/fill-data.ps1": "c327e2f1a272f3b0d2a84bdfd0c4d57ee669bbee37c8252657c71ffb89ac947d",
        "windows/start.ps1": "21167adf3ee4a8b7a25697f3d71ba8c0154f3fadddf998ee607d42d6a86e84bd", "windows/health.ps1": "e203ce1cd52d923d8d7492305c9851dea53b4c14af3d195d3c0ba37180333d93",
        "windows/stop.ps1": "4efd8647e134b6663681bf274be8b39056b725798aba673f6608882446f9376e", "windows/rollback.ps1": "75e9536392085bc3e502df14132f2bc4057cbc35c38729c1d1a1c8dff2daa8d3"}
LOCAL = {f"bafy{'a' * 30}{i:04d}.{e}": 1000 + i for i in range(936) for e in ("bin", "car")}
LST = [("tcp", "127.0.0.1", 18188), ("tcp", "127.0.0.1", 18189), ("udp", "127.0.0.1", 18153), ("tcp", "127.0.0.1", 18153), ("tcp", "127.0.0.1", 18154), ("tcp", "127.0.0.1", 18190)]
BASE = {"freeRamMiB": 37618, "freeDiskMiB": 910702, "tcpListenOnStagePorts": 0, "udpOnStagePorts": 0, "listeners": [], "taskState": "Ready", "taskRealTriggers": 0, "taskPrincipal": "LOCAL SERVICE",
        "receiptLast": "complete", "receiptSha256": L.PINS["receiptSha256"], "receiptFilesMatch": 24, "receiptFilesBad": 0, "hostServicesJson": L.PINS["hostServicesJson"], "supervisorJson": L.PINS["supervisorJson"],
        "manifestSha256": L.PINS["manifestSha256"], "artifactsFiles": 1872, "artifactsOther": 0, "artifactsBytes": 1, "hs2NodeProcesses": 0, "supervisorProcesses": 0, "node": "v24.16.0",
        "scripts": SUMS, "staging": None, "stagingMarker": None, "sessionElevated": True}
RUNNING = {**BASE, "taskState": "Running", "listeners": LST}
SIX = ["PASS  gate: platform host policy admits this host now  {}", "PASS  directory-replica /health  {}", "PASS  bootstrap-replica serves the manifest (1 verified by sha256, 936 by HEAD size)  {}",
       "PASS  route-dns answers SOA and NS for app.enclave.host (authoritative, NOERROR)  {}", "PASS  route-dns answers 4 static platform label(s) with their configured addresses  {}",
       "PASS  policy-mirror /health (agrees with the book's anchor; serves the anchored document)  {}"]

def run(argv, probes, results, local_ok=True):
    tmp = pathlib.Path(tempfile.mkdtemp()); shutil.copy(ORIG / "hs2lib.py", tmp / "hs2lib.py")
    spec = importlib.util.spec_from_file_location("orig", ORIG / "root-hs2-activate.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    m.HERE = tmp; (tmp / "receipts").mkdir(); (tmp / "receipts" / "fill-x.json").write_text(json.dumps({"exit": 0}))
    def lp():
        if not local_ok: raise SystemExit("REFUSED: the local snapshot lacks x.bin")
        return SUMS, LOCAL
    m.local_pins = lp
    calls, probes, results = [], list(probes), list(results)
    def probe():
        x = probes.pop(0) if len(probes) > 1 else probes[0]
        if isinstance(x, BaseException): raise x
        return copy.deepcopy(x)
    def ps(script, seconds):
        calls.append(script); x = results.pop(0) if results else (0, {}, "")
        if isinstance(x, BaseException): raise x
        return x
    m.probe, m.ps = probe, ps
    sys.argv = ["x"] + argv
    try: m.main(); outcome = "returned"
    except SystemExit as e: outcome = f"exit {e.code}"
    except BaseException as e: outcome = f"UNCAUGHT {type(e).__name__}"
    stopped = any("stop.ps1" in c for c in calls)
    shutil.rmtree(tmp, ignore_errors=True)
    return outcome, stopped

T = subprocess.TimeoutExpired(["ssh"], 1260)
cases = [
    ("ssh timeout during start", ["--start"], [BASE, BASE], [T]),
    ("post-start probe raises (original probe: SystemExit)", ["--start"], [BASE, SystemExit("REFUSED: the read-only probe failed (ssh 255)"), BASE], [(0, {"startRc": 0, "healthRc": 0, "health": SIX}, "")]),
    ("healthRc 2 with six PASS lines", ["--start"], [BASE, RUNNING], [(0, {"startRc": 0, "healthRc": 2, "health": SIX}, "")]),
    ("duplicate health line instead of one check", ["--start"], [BASE, RUNNING], [(0, {"startRc": 0, "healthRc": 0, "health": SIX[:5] + [SIX[0]]}, "")]),
    ("unexpected health check name", ["--start"], [BASE, RUNNING], [(0, {"startRc": 0, "healthRc": 0, "health": SIX[:5] + ["PASS  anything  {}"]}, "")]),
]
out = []
for name, argv, probes, results in cases:
    o, s = run(argv, probes, results); out.append({"case": name, "original": o, "stopAttempted": s})
o, s = run(["--stop"], [RUNNING], [(0, {"stopRc": 0}, "")], local_ok=False)
out.append({"case": "emergency --stop with the local snapshot missing", "original": o, "stopAttempted": s})
o, s = run(["--stop"], [{**RUNNING, "scripts": {**SUMS, "windows/stop.ps1": "f" * 64}}, BASE], [(0, {"stopRc": 0}, "")])
out.append({"case": "--stop when stop.ps1 drifted (runs it anyway?)", "original": o, "stopAttempted": s})
print(json.dumps(out, indent=1))
