#!/usr/bin/env python3
"""ROOT RUNS THIS (prepared by reviewer 9d; NOT run by the reviewer). Native kill-on-close canary on minipc.
Uses root's reviewed transport, unmodified: work/nucbox-tls-20261021/root-activate-reviewed.py ps():
EncodedCommand, ssh -n, a remote watchdog (kills the session's PowerShell after N s or above 512 MB) and FileSha.
  0. read-only identity snapshot (root's G3 probe pattern, root-g3-probe.py e904a9e6): the protected agent processes
     (command line matches agent.mjs: pid + creation) and every VM (Get-VM name/id/state) -> identity-before.json.
  1. pins: kill-canary.mjs here == pins.json; refuses a second run (stage.json exists).
  2. a NEW unique stage C:\\ProgramData\\Enclave\\staging\\hold-kill-<12 hex> (refused if present); scp (SFTP) the canary.
  3. on minipc:
       - the canary, node.exe and firewall each == pin;
       - run the canary with the deployed node.exe:
           - nested under the stage, it creates hold-kill-canary-<hex>\\enclave-circuit-<32 hex> scratch circuits;
           - it runs install / sandbox / kill / remove on them.
       Output -> execution.json.
  4. collection: stage listing, processes whose image is under the stage, pins -> collection.json.
  5. the same identity snapshot -> identity-after.json; PASS requires it EQUAL to before (no agent restarted, no VM
     added/removed/changed state). Native K2 is pinned to 2 (two simultaneous + three sequential circuits).
No production config, binary, service, VM, Node agent/manager or wallet is touched. Output is canary JSON only."""
import pathlib, json, hashlib, importlib.util, uuid, subprocess, sys
P = pathlib.Path(__file__).resolve().parent
WORK = P.parents[1]
NODE = r"C:\Program Files\nodejs\node.exe"
FW = r"C:\Program Files\Enclave\network\enclave-circuit-firewall.exe"
NODE_SHA = "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3"
FW_SHA = "78daec71f51f89a53600cb7d4bfb0492e2f0d642047422e4fbec30b2a5c238a6"
pins = json.loads((P / "pins.json").read_text())
for f, h in pins.items():
    assert hashlib.sha256((P / f).read_bytes()).hexdigest() == h, f"pin mismatch {f}"
assert not (P / "stage.json").exists(), "a run already started: read stage.json/execution.json, do not duplicate"
spec = importlib.util.spec_from_file_location("t", WORK / "nucbox-tls-20261021" / "root-activate-reviewed.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert hashlib.sha256((WORK / "nucbox-tls-20261021" / "root-activate-reviewed.py").read_bytes()).hexdigest() == \
    "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f", "transport helper changed"

IDENT = ("$p=@(Get-CimInstance Win32_Process -OperationTimeoutSec 30|Where-Object{$_.CommandLine -match 'agent\\.mjs'}|"
         "ForEach-Object{[ordered]@{pid=$_.ProcessId;created=[string]$_.CreationDate}});"
         "$v=@(Get-VM|ForEach-Object{[ordered]@{name=$_.Name;id=[string]$_.Id;state=[string]$_.State}});"
         "@{protected=$p;vms=$v}|ConvertTo-Json -Compress -Depth 4")
def identity():
    r = m.ps(IDENT, secs=90)
    assert "error" not in r and isinstance(r.get("protected"), list) and isinstance(r.get("vms"), list), r
    return {"protected": sorted(r["protected"], key=lambda x: x["pid"]), "vms": sorted(r["vms"], key=lambda x: x["id"])}
before = identity()
(P / "identity-before.json").write_text(json.dumps(before, indent=2) + "\n")
assert len(before["protected"]) >= 2 and before["vms"], "protected processes or VMs not observed: " + json.dumps(before)[:400]

d = r"C:\ProgramData\Enclave\staging\hold-kill-" + uuid.uuid4().hex[:12]
(P / "stage.json").write_text(json.dumps({"stage": d, "pins": pins}, indent=2) + "\n")
r = m.ps("$d='" + d + "';if(Test-Path -LiteralPath $d){throw 'stage exists'};New-Item -ItemType Directory -Path $d|Out-Null;"
         "@{created=$d}|ConvertTo-Json -Compress", secs=30)
assert r.get("created") == d, r
for f in pins:
    s = subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", str(P / f),
                        "minipc:/" + d.replace("\\", "/") + "/" + f], capture_output=True, text=True, timeout=60)
    assert s.returncode == 0, s.stderr

ck = ";".join("if((FileSha (Join-Path $d '" + f + "')) -ne '" + h + "'){throw 'pin mismatch " + f + "'}" for f, h in pins.items())
code = ("$d='" + d + "';" + ck + ";if((FileSha '" + NODE + "') -ne '" + NODE_SHA + "'){throw 'node pin'};"
        "if((FileSha '" + FW + "') -ne '" + FW_SHA + "'){throw 'firewall pin'};"
        # native stderr must not become a terminating error under the helper's Stop preference
        "$ErrorActionPreference='Continue';"
        "$o=@(& '" + NODE + "' (Join-Path $d 'kill-canary.mjs') --firewall '" + FW + "' --firewall-sha '" + FW_SHA + "' --node-sha '" + NODE_SHA +
        "' --k2 2 --scratch-parent $d 2>&1 | ForEach-Object {[string]$_});$rc=$LASTEXITCODE;"
        "@{exit=$rc;output=[string]::Join(\"`n\",$o)}|ConvertTo-Json -Compress")
r = m.ps(code, secs=900)
(P / "execution.json").write_text(json.dumps(r, indent=2) + "\n")
print(json.dumps(r, indent=2))

coll = ("$d='" + d + "';$items=@(Get-ChildItem -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue|ForEach-Object{$_.FullName});"
        "$procs=@(Get-CimInstance Win32_Process -OperationTimeoutSec 30|Where-Object{[string]$_.ExecutablePath -like ($d+'\\*')}|ForEach-Object{[string]$_.ProcessId+' '+$_.ExecutablePath});"
        "@{stage=$d;items=$items;processesUnderStage=$procs;nodeSha=FileSha '" + NODE + "';firewallSha=FileSha '" + FW + "'}|ConvertTo-Json -Compress")
c = m.ps(coll, secs=90)
(P / "collection.json").write_text(json.dumps(c, indent=2) + "\n")
print(json.dumps(c, indent=2))
after = identity()
(P / "identity-after.json").write_text(json.dumps(after, indent=2) + "\n")
same = after == before
print("IDENTITY", "UNCHANGED" if same else "CHANGED", len(after["protected"]), "protected,", len(after["vms"]), "VMs")
ok = r.get("exit") == 0 and "KILL-CANARY-RC=0" in r.get("output", "") and not c.get("processesUnderStage") and same
print("ROOT-KILL-CANARY", "PASS" if ok else "NOT PASS (read execution.json / collection.json; do not rerun blindly)")
sys.exit(0 if ok else 1)
