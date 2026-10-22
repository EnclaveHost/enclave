from pathlib import Path
import base64
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parent.parent
source = root / "work/shield-hardware-canary"
out = root / "work/windows-canary-preflight-abe86262"
out.mkdir(exist_ok=True)
bundle = json.loads((root / "outputs/windows-independent-bundle.json").read_text())
runtime = json.loads((root / "outputs/shield-direct-runtime-verification.json").read_text())
remote = r"C:\Users\claude\enclave-staging\canary-tools-abe86262"
canary = r"C:\ProgramData\Enclave\staging\canary-abe86262"

def ps(script, label, timeout=60):
    encoded = base64.b64encode(script.encode("utf-16le")).decode()
    r = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "minipc",
         "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded],
        capture_output=True, text=True, timeout=timeout,
    )
    (out / (label + ".log")).write_text(r.stdout + "\n" + r.stderr)
    print(label, "exit", r.returncode, r.stdout[-3000:], flush=True)
    if r.returncode:
        raise RuntimeError(label + " failed")
    return r

ps("$ErrorActionPreference='Stop';$d='" + remote + "';if(Test-Path -LiteralPath $d){throw 'tools directory exists'};"
   "New-Item -ItemType Directory -Path $d|Out-Null", "prepare")
files = [f for f in source.iterdir() if f.suffix in [".ps1", ".mjs"]]
files.append(root / "work/shield-direct-build-0ed5a8ba/runtime.json")
for f in files:
    subprocess.run(["scp", "-q", "-o", "BatchMode=yes", str(f),
                    "minipc:" + remote.replace("\\", "/") + "/" + f.name], check=True, timeout=60)
pins = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in files}
checks = "\n".join(
    "if((Get-FileHash -LiteralPath (Join-Path $d '" + name + "') -Algorithm SHA256).Hash.ToLower() -cne '"
    + value + "'){throw 'script pin mismatch: " + name + "'}"
    for name, value in pins.items()
)
script = r"""
$ErrorActionPreference='Stop'
$d='@@TOOLS@@'
@@CHECKS@@
. (Join-Path $d 'lib.ps1')
$before=Snapshot
if(@($before.vms|Where-Object{$_.name.StartsWith('enclave-canary-')}).Count){throw 'pre-existing canary VM needs reconciliation'}
$before|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $d 'baseline.json') -Encoding UTF8
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'initial invariants failed'}
# This validates actual build provenance and all pins without staging keys/files or launching services.
& (Join-Path $d 'stage.ps1') -CanaryDir '@@CANARY@@' -Bundle '@@BUNDLE@@' -Commit '@@COMMIT@@' `
  -ManifestSha256 '@@MANIFEST@@' -DirectRuntimeIdentity (Join-Path $d 'runtime.json') `
  -DirectRuntimeSha256 '@@RUNTIME@@' -CustodyTransport -ValidateOnly
if(-not $?){throw 'staging validation failed'}
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'post-validation invariants failed'}
Write-Output 'PRECHECK COMPLETE: no installer, service, registry or VM mutation'
""".replace("@@TOOLS@@", remote).replace("@@CHECKS@@", checks).replace("@@CANARY@@", canary).replace(
    "@@BUNDLE@@", bundle["bundle"]).replace("@@COMMIT@@", bundle["commit"]).replace(
    "@@MANIFEST@@", bundle["manifestSha256"]).replace("@@RUNTIME@@", runtime["runtimeJsonSha256"])
validation = ps(script, "validate", timeout=900)
assert "PRECHECK COMPLETE" in validation.stdout and "VALIDATED: no files or system state changed" in validation.stdout
assert validation.stdout.count("INVARIANTS HOLD:") == 2
subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "minipc:" + remote.replace("\\", "/") + "/baseline.json",
                str(out / "baseline.json")], check=True, timeout=30)
baseline = json.loads((out / "baseline.json").read_text(encoding="utf-8-sig"))
evidence = {
    "status": "validated-not-staged-or-activated", "commit": bundle["commit"], "bundle": bundle["bundle"],
    "manifestSha256": bundle["manifestSha256"], "canaryDir": canary, "toolsDirectory": remote,
    "baseline": baseline, "scriptHashes": pins, "runtimeVerification": runtime,
}
(root / "outputs/windows-canary-preflight.json").write_text(json.dumps(evidence, indent=2) + "\n")
print("Actual bundle staging validation passed; host baseline preserved.", flush=True)
