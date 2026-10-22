"""Verify isolated manager scope, then stop only its exact owned task."""
from pathlib import Path
import base64
import json
import subprocess

root = Path(__file__).resolve().parent.parent
preflight = json.loads((root / "outputs/windows-canary-preflight.json").read_text())
staged = json.loads((root / "outputs/windows-canary-staging.json").read_text())
assert staged["status"] == "staged-not-started"
stage = staged["stage"]
assert stage["commit"] == preflight["commit"] and stage["manifestSha256"] == preflight["manifestSha256"]
out = root / "work/windows-canary-scope-abe86262-v2"
out.mkdir(exist_ok=True)
checks = "\n".join(
    "if((Get-FileHash -LiteralPath (Join-Path $d '" + name + "') -Algorithm SHA256).Hash.ToLower() -cne '"
    + value + "'){throw 'script pin mismatch: " + name + "'}"
    for name, value in staged.get("scriptHashes", preflight["scriptHashes"]).items()
)
script = r"""
$ErrorActionPreference='Stop'
$d='@@TOOLS@@'
$c='@@CANARY@@'
@@CHECKS@@
$s=Get-Content -LiteralPath (Join-Path $c 'stage.json') -Raw | ConvertFrom-Json
if($s.commit -cne '@@COMMIT@@' -or $s.manifestSha256 -cne '@@MANIFEST@@' -or
   $s.managerCommandSha256 -cne '@@COMMAND@@'){throw 'stage identity changed'}
$node=Join-Path $s.bundle 'runtime\node\node.exe'
if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLower() -cne $s.nodeSha256){throw 'node pin changed'}
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'before manager invariants failed'}
$approval=Join-Path $c 'approved-steps.txt'
if(Test-Path -LiteralPath $approval){throw 'approval file already exists; reconcile before a repeated check'}
@('approved: manager-start','approved: manager-stop')|Set-Content -LiteralPath $approval -Encoding ASCII
$ok=$false;$failure=$null
try {
  & (Join-Path $d 'run-manager.ps1') -CanaryDir $c -Apply
  $ready=$false
  for($i=0;$i -lt 30;$i++) {
    try {
      $h=Invoke-RestMethod -Uri 'http://127.0.0.1:18091/health' -TimeoutSec 2
      if($h.inventory.state -ceq 'ready'){$ready=$true;break}
    } catch {}
    Start-Sleep -Seconds 1
  }
  if(-not $ready){throw 'canary manager did not reach ready inventory'}
  & $node (Join-Path $d 'canary.mjs') scope --canary-dir $c --port 18091 --direct-sha '@@DIRECT@@'
  if($LASTEXITCODE -ne 0){throw 'actual manager scope check failed'}
  & (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
  if($LASTEXITCODE){throw 'running manager invariants failed'}
  $ok=$true
} catch {
  $failure=$_
} finally {
  & (Join-Path $d 'run-manager.ps1') -CanaryDir $c -Apply -Stop
  if(-not $?){throw 'own manager cleanup failed'}
}
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'after manager stop invariants failed'}
if(@(Get-ScheduledTask -TaskPath '\Enclave-Canary\' -TaskName 'Manager-abe86262' -ErrorAction SilentlyContinue).Count){throw 'own manager task still exists'}
if(@(Get-NetTCPConnection -LocalPort 18091 -State Listen -ErrorAction SilentlyContinue).Count){throw 'canary listener still exists'}
if($failure){throw $failure}
if(-not $ok){throw 'scope was not proven'}
Write-Output 'SCOPE COMPLETE: production unchanged, no guest created, own manager stopped'
""".replace("@@TOOLS@@", preflight["toolsDirectory"]).replace("@@CHECKS@@", checks).replace(
    "@@CANARY@@", stage["canaryDir"]).replace("@@COMMIT@@", stage["commit"]).replace(
    "@@MANIFEST@@", stage["manifestSha256"]).replace("@@COMMAND@@", stage["managerCommandSha256"]).replace(
    "@@DIRECT@@", stage["directIgvmSha256"])
encoded = base64.b64encode(script.encode("utf-16le")).decode()
result = subprocess.run(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "minipc",
     "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded],
    capture_output=True, text=True, timeout=180,
)
(out / "scope.log").write_text(result.stdout + "\n" + result.stderr)
print("scope exit", result.returncode, result.stdout[-5000:], flush=True)
assert result.returncode == 0
assert "SCOPE COMPLETE:" in result.stdout and result.stdout.count("INVARIANTS HOLD:") == 3
begin = result.stdout.index('{\n')
decoder = json.JSONDecoder()
scope, _ = decoder.raw_decode(result.stdout[begin:])
assert scope["ok"] is True and scope["records"] == 0 and not scope["foreign"]
(root / "outputs/windows-canary-manager-scope.json").write_text(json.dumps({
    "status": "native-scope-proven-manager-stopped", "stage": stage,
    "scope": scope, "guestCreated": False, "productionInvariantsPreserved": True,
}, indent=2) + "\n")
