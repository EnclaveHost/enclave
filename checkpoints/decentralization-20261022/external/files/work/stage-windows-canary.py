"""Stage the verified canary only. Never install or launch a VM."""
from pathlib import Path
import base64
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parent.parent
evidence = json.loads((root / "outputs/windows-canary-preflight.json").read_text())
assert evidence["status"] == "validated-not-staged-or-activated"
out = root / "work/windows-canary-stage-abe86262-v2"
out.mkdir(exist_ok=True)
remote = evidence["toolsDirectory"]
canary = evidence["canaryDir"]
script_hashes = {
    **evidence["scriptHashes"],
    "stage.ps1": hashlib.sha256((root / "work/shield-hardware-canary/stage.ps1").read_bytes()).hexdigest(),
}
checks = "\n".join(
    "if((Get-FileHash -LiteralPath (Join-Path $d '" + name + "') -Algorithm SHA256).Hash.ToLower() -cne '"
    + value + "'){throw 'script pin mismatch: " + name + "'}"
    for name, value in script_hashes.items()
)
script = r"""
$ErrorActionPreference='Stop'
$d='@@TOOLS@@'
@@CHECKS@@
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'pre-stage invariants failed'}
& (Join-Path $d 'stage.ps1') -CanaryDir '@@CANARY@@' -Bundle '@@BUNDLE@@' -Commit '@@COMMIT@@' `
  -ManifestSha256 '@@MANIFEST@@' -DirectRuntimeIdentity (Join-Path $d 'runtime.json') `
  -DirectRuntimeSha256 '@@RUNTIME@@' -CustodyTransport
if(-not $?){throw 'staging failed'}
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'post-stage invariants failed'}
Write-Output 'STAGE COMPLETE: no installer, task, registry or VM operation'
""".replace("@@TOOLS@@", remote).replace("@@CHECKS@@", checks).replace("@@CANARY@@", canary).replace(
    "@@BUNDLE@@", evidence["bundle"]).replace("@@COMMIT@@", evidence["commit"]).replace(
    "@@MANIFEST@@", evidence["manifestSha256"]).replace("@@RUNTIME@@", evidence["runtimeVerification"]["runtimeJsonSha256"])
encoded = base64.b64encode(script.encode("utf-16le")).decode()
result = subprocess.run(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "minipc",
     "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded],
    capture_output=True, text=True, timeout=900,
)
(out / "stage.log").write_text(result.stdout + "\n" + result.stderr)
print("stage exit", result.returncode, result.stdout[-5000:], flush=True)
assert result.returncode == 0
assert "STAGE COMPLETE:" in result.stdout and result.stdout.count("INVARIANTS HOLD:") == 2
subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "minipc:" + canary.replace("\\", "/") + "/stage.json",
                str(out / "stage.json")], check=True, timeout=30)
stage_bytes = (out / "stage.json").read_bytes()
stage = json.loads(stage_bytes.decode("utf-16" if stage_bytes.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"))
assert stage["commit"] == evidence["commit"] and stage["manifestSha256"] == evidence["manifestSha256"]
(root / "outputs/windows-canary-staging.json").write_text(json.dumps({
    "status": "staged-not-started", "stage": stage, "scriptHashes": script_hashes,
    "preflightEvidence": "outputs/windows-canary-preflight.json",
    "productionInvariantsPreserved": True,
}, indent=2) + "\n")
