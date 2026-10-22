from pathlib import Path
import base64
import datetime
import hashlib
import json
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
repo = root / "work/enclave"
out = root / "work/windows-bundle-abe86262"
commit = subprocess.check_output(["git", "rev-parse", "abe86262^{commit}"], cwd=repo, text=True).strip()
remote = r"C:\Users\claude\enclave-staging\bundle-abe86262"
inputs = [out / "control-abe86262.tar.gz", out / "MANIFEST-control-abe86262.txt"]
assert all(p.is_file() for p in inputs), "Linux staging has not completed"
builder = out / "build-bundle.ps1"
builder.write_bytes(subprocess.check_output(["git", "show", commit + ":windows/installer/build-bundle.ps1"], cwd=repo))
inputs.append(builder)
resume = sys.argv[1:] == ["--resume"]
if sys.argv[1:] and not resume:
    raise SystemExit("usage: build-windows-bundle-native.py [--resume]")

def ps(script, label, timeout=60):
    encoded = base64.b64encode(script.encode("utf-16le")).decode()
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "minipc",
         "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded],
        capture_output=True, text=True, timeout=timeout,
    )
    (out / (label + ".log")).write_text(result.stdout + "\n" + result.stderr)
    print(label, "exit", result.returncode, result.stdout[-4000:], flush=True)
    if result.returncode:
        raise RuntimeError(label + " failed; inspect saved log")
    return result

ps("$ErrorActionPreference='Stop';$p='" + remote + "';" +
   ("if(-not(Test-Path -LiteralPath $p)){throw 'no existing native stage to resume'};" if resume else
    "if(Test-Path -LiteralPath $p){throw 'native staging directory already exists'};") +
   "if((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 8*1024*1024){throw 'less than 8 GiB free'};"
   "New-Item -ItemType Directory -Force -Path $p|Out-Null", "native-resume-prepare" if resume else "native-prepare")
for f in inputs:
    subprocess.run(
        ["scp", "-q", "-o", "BatchMode=yes", str(f), "minipc:" + remote.replace("\\", "/") + "/" + f.name],
        check=True, timeout=180,
    )
checks = "\n".join(
    "if((Get-FileHash -LiteralPath '" + f.name + "' -Algorithm SHA256).Hash.ToLower() -cne '"
    + hashlib.sha256(f.read_bytes()).hexdigest() + "'){throw 'input hash mismatch: " + f.name + "'}"
    for f in inputs
)
source = builder.read_text()
definitions = source[source.index("$Binaries ="):source.index("$NodeZip   =")]
script = r"""
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Set-Location '@@REMOTE@@'
@@CHECKS@@
@@DEFINITIONS@@
# Reconstruct the builder's historical input layout from exact pinned public binaries.
# Installed files are only read. No configs, private keys or ProgramData state are copied.
$sources='@@REMOTE@@\inputs'
New-Item -ItemType Directory -Force $sources|Out-Null
foreach($k in $Binaries.Keys){
  $found=$null
  foreach($candidate in @((Join-Path 'C:\Users\claude' $Binaries[$k][0]),(Join-Path 'C:\Program Files\Enclave' $k))){
    if((Test-Path -LiteralPath $candidate -PathType Leaf) -and
       (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLower() -ceq $Binaries[$k][1]){$found=$candidate;break}
  }
  if(-not $found){throw ('no exact pinned input for '+$k)}
  $dest=Join-Path $sources $Binaries[$k][0]
  New-Item -ItemType Directory -Force (Split-Path -Parent $dest)|Out-Null
  if(Test-Path -LiteralPath $dest){
    if((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower() -cne $Binaries[$k][1]){throw 'existing scratch input differs'}
  }else{Copy-Item -LiteralPath $found -Destination $dest}
}
foreach($k in $Folders.Keys){
  $found=$null
  foreach($candidate in @((Join-Path 'C:\Users\claude' $Folders[$k][0]),(Join-Path 'C:\Program Files\Enclave' $k))){
    if(-not(Test-Path -LiteralPath $candidate -PathType Container)){continue}
    $lines=Get-ChildItem -LiteralPath $candidate -File|Sort-Object Name|ForEach-Object{
      "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)"
    }
    $hash=(([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::ASCII.GetBytes(($lines -join "`n")+"`n")))|ForEach-Object{$_.ToString("x2")}) -join ''
    if($hash -ceq $Folders[$k][1]){$found=$candidate;break}
  }
  if(-not $found){throw ('no exact pinned folder for '+$k)}
  $dest=Join-Path $sources $Folders[$k][0]
  New-Item -ItemType Directory -Force $dest|Out-Null
  Get-ChildItem -LiteralPath $found -File|ForEach-Object{Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dest $_.Name)}
}
# Only package/compile. The tray executable's --write-icon mode returns before UI or installed-state access.
# The installer, updater, services and VM launchers are never invoked.
& '.\build-bundle.ps1' -Control '.\control-abe86262.tar.gz' -Manifest '.\MANIFEST-control-abe86262.txt' `
  -Sources $sources -Out '@@REMOTE@@\out' -Version '2026.10.20.1'
if(-not $?){throw 'bundle builder failed'}
$bundle='@@REMOTE@@\out\work\enclave-host'
$manifest=Get-Content -LiteralPath (Join-Path $bundle 'manifest.json') -Raw|ConvertFrom-Json
if($manifest.commit -cne '@@COMMIT@@'){throw 'wrong full source commit'}
foreach($f in $manifest.files){
  if((Get-FileHash -LiteralPath (Join-Path $bundle $f.path) -Algorithm SHA256).Hash.ToLower() -cne $f.sha256){throw ('bundle file mismatch: '+$f.path)}
}
[ordered]@{
  commit=$manifest.commit;bundle=$bundle;version=$manifest.version;fileCount=@($manifest.files).Count;
  manifestSha256=(Get-FileHash -LiteralPath (Join-Path $bundle 'manifest.json') -Algorithm SHA256).Hash.ToLower();
  controlManifestSha256=$manifest.controlManifestSha256;
  archiveSha256=(Get-FileHash -LiteralPath '@@REMOTE@@\out\enclave-host-2026.10.20.1.zip' -Algorithm SHA256).Hash.ToLower();
  verified=$true;activated=$false
}|ConvertTo-Json|Set-Content -LiteralPath '@@REMOTE@@\verified.json' -Encoding UTF8
Get-Content -LiteralPath '@@REMOTE@@\verified.json'
""".replace("@@REMOTE@@", remote).replace("@@CHECKS@@", checks).replace("@@COMMIT@@", commit).replace("@@DEFINITIONS@@", definitions)
ps(script, "native-resume-build" if resume else "native-build", timeout=1800)
for name, local in [
    ("verified.json", "native-verified.json"),
    ("out/work/enclave-host/manifest.json", "bundle-manifest.json"),
    ("out/SHA256SUMS", "SHA256SUMS"),
]:
    subprocess.run(
        ["scp", "-q", "-o", "BatchMode=yes", "minipc:" + remote.replace("\\", "/") + "/" + name, str(out / local)],
        check=True, timeout=60,
    )
evidence = json.loads((out / "native-verified.json").read_text(encoding="utf-8-sig"))
assert hashlib.sha256((out / "bundle-manifest.json").read_bytes()).hexdigest() == evidence["manifestSha256"]
evidence["verifiedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
evidence["inputs"] = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs}
(root / "outputs/windows-independent-bundle.json").write_text(json.dumps(evidence, indent=2) + "\n")
print("Bundle compiled and verified; not installed or activated.", flush=True)
