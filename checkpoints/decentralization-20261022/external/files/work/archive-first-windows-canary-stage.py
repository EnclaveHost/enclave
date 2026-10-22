"""Archive only the stopped, unbooted first stage; preserve logs and private scratch key ACLs."""
from pathlib import Path
import base64
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parent.parent
preflight = json.loads((root / "outputs/windows-canary-preflight.json").read_text())
previous = json.loads((root / "outputs/windows-canary-staging.json").read_text())
stage = previous["stage"]
assert previous["status"] == "staged-not-started"
out = root / "work/windows-canary-scope-abe86262"
archive = stage["canaryDir"] + "-initial-unbooted"
script = r"""
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$d='@@TOOLS@@';$c='@@CANARY@@';$archive='@@ARCHIVE@@'
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'pre-archive drift'}
if(@(Get-VM|Where-Object {$_.Name.StartsWith('enclave-canary-')}).Count){throw 'canary VMs exist'}
if(@(Get-ScheduledTask -TaskPath '\Enclave-Canary\' -TaskName 'Manager-abe86262' -EA SilentlyContinue).Count){throw 'task exists'}
if(@(Get-NetTCPConnection -LocalPort 18091 -State Listen -EA SilentlyContinue).Count){throw 'listener exists'}
if(Test-Path -LiteralPath $archive){throw 'archive destination exists'}
if(Test-Path -LiteralPath (Join-Path $c 'created-vms.json')){throw 'a VM creation journal exists'}
$s=Get-Content -LiteralPath (Join-Path $c 'stage.json') -Raw|ConvertFrom-Json
if($s.commit -cne '@@COMMIT@@' -or $s.managerCommandSha256 -cne '@@COMMAND@@' -or
   $s.canaryDir -cne $c){throw 'stage differs from reviewed attempt'}
if((Get-FileHash -LiteralPath (Join-Path $c 'canary-env.cmd') -Algorithm SHA256).Hash.ToLower() -cne $s.managerCommandSha256){throw 'command drift'}
Move-Item -LiteralPath $c -Destination $archive
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'post-archive drift'}
Write-Output 'ARCHIVE COMPLETE: only stopped unbooted canary files moved; production unchanged'
""".replace("@@TOOLS@@", preflight["toolsDirectory"]).replace("@@CANARY@@", stage["canaryDir"]).replace(
    "@@ARCHIVE@@", archive).replace("@@COMMIT@@", stage["commit"]).replace(
    "@@COMMAND@@", stage["managerCommandSha256"])
encoded = base64.b64encode(script.encode("utf-16le")).decode()
result = subprocess.run(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "minipc",
     "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded],
    capture_output=True, text=True, timeout=90,
)
(out / "archive.log").write_text(result.stdout + "\n" + result.stderr)
print("archive exit", result.returncode, result.stdout[-2000:], flush=True)
assert result.returncode == 0 and result.stdout.count("INVARIANTS HOLD:") == 2 and "ARCHIVE COMPLETE:" in result.stdout
source = root / "work/shield-hardware-canary/stage.ps1"
subprocess.run(["scp", "-q", "-o", "BatchMode=yes", str(source),
                "minipc:" + preflight["toolsDirectory"].replace("\\", "/") + "/stage.ps1"], check=True, timeout=30)
(root / "outputs/windows-canary-manager-attempt1.json").write_text(json.dumps({
    "status": "failed-closed-missing-canary-egress-config",
    "managerStopped": True, "canaryTasks": 0, "canaryListeners": 0, "guestCreated": False,
    "productionInvariantsPreserved": True, "archive": archive, "stage": stage,
    "correction": "Explicit canary-local app routes path in generated command; missing routes refuse outbound requests. No production routing or proxy is borrowed.",
    "correctedStageScriptSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
}, indent=2) + "\n")
