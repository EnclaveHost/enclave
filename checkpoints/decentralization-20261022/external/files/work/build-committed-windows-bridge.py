from pathlib import Path
import base64
import datetime
import hashlib
import json
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
repo = root / "work/enclave"
commit = "45801c22be3a317d687f30efe92b6f0b47124a86"
out = root / "work/windows-bridge-45801c22"
out.mkdir(exist_ok=True)
archive = out / "source.tar"
subprocess.run(
    ["git", "archive", "--format=tar", "-o", str(archive), commit, "windows/vbslike/host"],
    cwd=repo, check=True,
)
with tarfile.open(archive) as tf:
    sources = {
        f.name: hashlib.sha256(tf.extractfile(f).read()).hexdigest()
        for f in tf.getmembers() if f.isfile()
    }
remote = r"C:\Users\claude\enclave-staging\committed-bridge-45801c22"

def ps(script, label, timeout=60):
    encoded = base64.b64encode(script.encode("utf-16le")).decode()
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "minipc",
         "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded],
        capture_output=True, text=True, timeout=timeout,
    )
    (out / (label + ".log")).write_text(result.stdout + "\n" + result.stderr)
    print(label, "exit", result.returncode, result.stdout[-3500:], flush=True)
    if result.returncode:
        raise RuntimeError(label + " failed; inspect recorded log")
    return result

ps("$ErrorActionPreference='Stop'; $p='" + remote + "'; "
   "if(Test-Path -LiteralPath $p){throw 'build directory already exists'}; "
   "$os=Get-CimInstance Win32_OperatingSystem; "
   "if($os.FreePhysicalMemory -lt 8*1024*1024){throw 'less than 8 GiB free on build host'}; "
   "New-Item -ItemType Directory -Path $p|Out-Null; "
   "cargo --version; rustc --version; Write-Output ('freeKiB='+$os.FreePhysicalMemory)", "prepare")
manifest = out / "sources.json"
manifest.write_text(json.dumps(sources, indent=2) + "\n")
for f in [archive, manifest]:
    subprocess.run(
        ["scp", "-q", "-o", "BatchMode=yes", str(f), "minipc:" + remote.replace("\\", "/") + "/" + f.name],
        check=True, timeout=60,
    )
script = r"""
$ErrorActionPreference='Stop'
$d='@@REMOTE@@'
Set-Location $d
if((Get-FileHash -LiteralPath 'source.tar' -Algorithm SHA256).Hash.ToLower() -cne '@@ARCHIVE@@'){throw 'source archive hash mismatch'}
tar.exe -xf source.tar
if($LASTEXITCODE){throw 'source extraction failed'}
$pins=Get-Content -LiteralPath 'sources.json' -Raw|ConvertFrom-Json
foreach($p in $pins.PSObject.Properties){
  if((Get-FileHash -LiteralPath $p.Name -Algorithm SHA256).Hash.ToLower() -cne $p.Value){throw ('source mismatch '+$p.Name)}
}
Set-Location (Join-Path $d 'windows\vbslike\host')
$env:CARGO_TARGET_DIR=Join-Path $d 'target'
$start=Get-Date
# The native compiler is used only in this staging directory; no executable is installed or launched.
& cargo build --release --locked --offline -j 1 --bin shielded-bridge --bin bridge-auth-check
if($LASTEXITCODE){throw 'native bridge compilation failed'}
$bins=@('shielded-bridge.exe','bridge-auth-check.exe')|ForEach-Object {
  $p=Join-Path $env:CARGO_TARGET_DIR ('release\'+$_)
  [ordered]@{name=$_;bytes=(Get-Item -LiteralPath $p).Length;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}
}
[ordered]@{
  commit='@@COMMIT@@';sourceArchiveSha256='@@ARCHIVE@@';sourceCount=@($pins.PSObject.Properties).Count;
  rustc=(& rustc --version);cargo=(& cargo --version);command='cargo build --release --locked --offline -j 1 --bin shielded-bridge --bin bridge-auth-check';
  durationSeconds=[int]((Get-Date)-$start).TotalSeconds; binaries=@($bins); activated=$false
}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $d 'build.json') -Encoding UTF8
Get-Content -LiteralPath (Join-Path $d 'build.json')
""".replace("@@REMOTE@@", remote).replace("@@COMMIT@@", commit).replace(
    "@@ARCHIVE@@", hashlib.sha256(archive.read_bytes()).hexdigest()
)
ps(script, "build", timeout=900)
for name in ["build.json", "target/release/shielded-bridge.exe", "target/release/bridge-auth-check.exe"]:
    subprocess.run(
        ["scp", "-q", "-o", "BatchMode=yes", "minipc:" + remote.replace("\\", "/") + "/" + name,
         str(out / Path(name).name)], check=True, timeout=60,
    )
evidence = json.loads((out / "build.json").read_text(encoding="utf-8-sig"))
for item in evidence["binaries"]:
    assert hashlib.sha256((out / item["name"]).read_bytes()).hexdigest() == item["sha256"]
evidence["verifiedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
evidence["sourceFiles"] = sources
evidence["remote"] = remote
(out / "verified.json").write_text(json.dumps(evidence, indent=2) + "\n")
print("Native binaries retrieved and verified; no installation or activation.", flush=True)
