from pathlib import Path
import base64
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parent.parent
preflight = json.loads((root / "outputs/windows-canary-preflight.json").read_text())
out = root / "work/windows-canary-stage-abe86262"
stage_bytes = (out / "stage.json").read_bytes()
assert stage_bytes.startswith(b"\xff\xfe")
stage = json.loads(stage_bytes.decode("utf-16"))
log = (out / "stage.log").read_text()
assert "STAGE COMPLETE:" in log and log.count("INVARIANTS HOLD:") == 2
assert stage["commit"] == preflight["commit"] and stage["manifestSha256"] == preflight["manifestSha256"]
remote = preflight["toolsDirectory"]
source = root / "work/shield-hardware-canary/stage.ps1"
helper = out / "verify-stage-encoding.mjs"
helper.write_text("""import { loadStage } from './guard.mjs';
const s = loadStage(process.argv[2]);
console.log(JSON.stringify({verified: true, commit: s.commit, port: s.port, managerCommandSha256: s.managerCommandSha256}));
""")
for f in [source, helper]:
    subprocess.run(["scp", "-q", "-o", "BatchMode=yes", str(f),
                    "minipc:" + remote.replace("\\", "/") + "/" + f.name], check=True, timeout=30)
new_script_hash = hashlib.sha256(source.read_bytes()).hexdigest()
helper_hash = hashlib.sha256(helper.read_bytes()).hexdigest()
script = r"""
$ErrorActionPreference='Stop'
$d='@@TOOLS@@';$c='@@CANARY@@'
if((Get-FileHash -LiteralPath (Join-Path $d 'stage.ps1') -Algorithm SHA256).Hash.ToLower() -cne '@@SCRIPT@@'){throw 'stage script mismatch'}
if((Get-FileHash -LiteralPath (Join-Path $d 'verify-stage-encoding.mjs') -Algorithm SHA256).Hash.ToLower() -cne '@@HELPER@@'){throw 'verification helper mismatch'}
$tokens=$null;$errors=$null
[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'stage.ps1'),[ref]$tokens,[ref]$errors)
if(@($errors).Count){throw 'corrected staging script does not parse'}
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'pre-repair invariant drift'}
$f=Join-Path $c 'stage.json'
if((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() -cne '@@OLD@@'){throw 'staged metadata changed; no overwrite'}
$text=[IO.File]::ReadAllText($f,[Text.Encoding]::Unicode)
$before=$text|ConvertFrom-Json
if($before.commit -cne '@@COMMIT@@'){throw 'unexpected stage'}
$temp=Join-Path $c 'stage-encoding.tmp'
if(Test-Path -LiteralPath $temp){throw 'encoding temp already exists'}
[IO.File]::WriteAllText($temp,$text,(New-Object Text.UTF8Encoding($false)))
$after=Get-Content -LiteralPath $temp -Raw -Encoding UTF8|ConvertFrom-Json
if(($before|ConvertTo-Json -Compress) -cne ($after|ConvertTo-Json -Compress)){throw 'encoding changed metadata'}
Move-Item -LiteralPath $temp -Destination $f -Force
$node=Join-Path $before.bundle 'runtime\node\node.exe'
if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLower() -cne $before.nodeSha256){throw 'node pin mismatch'}
& $node (Join-Path $d 'verify-stage-encoding.mjs') $c
if($LASTEXITCODE -ne 0){throw 'actual Node stage decoder failed'}
& (Join-Path $d 'invariants.ps1') -Baseline (Join-Path $d 'baseline.json')
if($LASTEXITCODE){throw 'post-repair invariant drift'}
Write-Output 'ENCODING COMPLETE: exact stage fields preserved; native Node decoder passed'
""".replace("@@TOOLS@@", remote).replace("@@CANARY@@", stage["canaryDir"]).replace(
    "@@SCRIPT@@", new_script_hash).replace("@@HELPER@@", helper_hash).replace(
    "@@OLD@@", hashlib.sha256(stage_bytes).hexdigest()).replace("@@COMMIT@@", stage["commit"])
encoded = base64.b64encode(script.encode("utf-16le")).decode()
result = subprocess.run(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "minipc",
     "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded],
    capture_output=True, text=True, timeout=90,
)
(out / "encoding-repair.log").write_text(result.stdout + "\n" + result.stderr)
print("encoding exit", result.returncode, result.stdout[-3000:], flush=True)
assert result.returncode == 0 and "ENCODING COMPLETE:" in result.stdout
assert result.stdout.count("INVARIANTS HOLD:") == 2
pins = {**preflight["scriptHashes"], "stage.ps1": new_script_hash}
(root / "outputs/windows-canary-staging.json").write_text(json.dumps({
    "status": "staged-not-started", "stage": stage, "scriptHashes": pins,
    "preflightEvidence": "outputs/windows-canary-preflight.json",
    "productionInvariantsPreserved": True,
    "encodingCorrection": {
        "oldEncoding": "UTF-16LE", "newEncoding": "UTF-8",
        "fieldsUnchanged": True, "nativeNodeDecoderPassed": True,
        "stageScriptSha256": new_script_hash,
    },
}, indent=2) + "\n")
