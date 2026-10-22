#!/usr/bin/env python3
"""ROOT's reproduction (root-review/rollback-conflict/prove.py), re-run against the FIXED script. Root's frozen files are read,
never edited: its injection is ported verbatim into tools/cutover-mock.ps1 as scenario 'root-concurrent-local-edit'
(root's own mock lacks Get-VM, so with it the fixed script would only refuse at its Hyper-V pin - a vacuous pass).
PASS = the unsafe mismatch is NOT reproduced: RECOVERY_REQUIRED, flag kept, network enforcement kept, node never started."""
import importlib.util, json, pathlib, shutil, sys, hashlib
P = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location("h", P / "cutover-mock-test.py"); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
root_mock = (P.parent / "root-review/rollback-conflict/cutover-mock.ps1").read_text()
assert "rem concurrent operator change" in root_mock and "rem concurrent operator change" in (P / "cutover-mock.ps1").read_text(), "the injection is root's"
r = m.world()
try:
    lines, c = m.run(r, m.params(r, "root-restore-cas-conflict"), scenario="root-concurrent-local-edit")
    cfg = json.loads((r / "network/privacy-config.json").read_text())
    out = {"script": str(m.SCRIPT), "scriptSha256": hashlib.sha256(m.SCRIPT.read_bytes()).hexdigest(), "final": m.final(lines),
           "localFlagStillSet": b"ENCLAVE_NETWORK_WALLET_HOLD=1" in (r / "node-config.local.cmd").read_bytes(),
           "networkStillEnforces": bool(cfg["enclaveNetwork"].get("walletAdmission")), "nodeStarts": m.starts(r), "recovery": lines[-1].get("recovery")}
    out["unsafeMismatchReproduced"] = out["localFlagStillSet"] and not out["networkStillEnforces"] and out["nodeStarts"] > 0
    out["safeRefusal"] = out["final"].startswith("RECOVERY_REQUIRED") and out["localFlagStillSet"] and out["networkStillEnforces"] and out["nodeStarts"] == 0
    (P / "root-conflict-evidence.json").write_text(json.dumps(out, indent=2) + "\n"); print(json.dumps(out, indent=2))
    sys.exit(0 if out["safeRefusal"] and not out["unsafeMismatchReproduced"] else 1)
finally:
    shutil.rmtree(r)
