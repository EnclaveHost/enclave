from pathlib import Path
import subprocess,base64,hashlib,json,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo')
source=root/'work/windows-local-relay-migration/local-relay-20261021-stage.zip'
expected='71ab3123b590b4457ea193c4af1ef3af48f52f3c757789307a1e6674068b1008'
data=source.read_bytes()
assert hashlib.sha256(data).hexdigest()==expected,'local archive changed'
script=r'''$ErrorActionPreference='Stop'
$base=Join-Path $env:ProgramData 'Enclave\activation-stage'
$stage=Join-Path $base 'local-relay-20261021'
$zip=Join-Path $base 'local-relay-20261021-71ab3123.zip'
if((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $zip)){throw 'Stage or archive already exists; nothing overwritten'}
if(-not(Test-Path -LiteralPath $base)){throw 'Existing activation-stage parent is absent'}
$f=[IO.File]::Open($zip,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{[Console]::OpenStandardInput().CopyTo($f);$f.Flush($true)}finally{$f.Dispose()}
if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne '71ab3123b590b4457ea193c4af1ef3af48f52f3c757789307a1e6674068b1008'){throw 'Uploaded archive hash mismatch'}
New-Item -ItemType Directory -Path $stage | Out-Null
& icacls.exe $stage /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not protect stage directory'}
Expand-Archive -LiteralPath $zip -DestinationPath $stage
Write-Output 'STAGED archive 71ab3123b590b4457ea193c4af1ef3af48f52f3c757789307a1e6674068b1008; no services changed'
'''
enc=base64.b64encode(script.encode('utf-16le')).decode()
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',enc],input=data,capture_output=True,timeout=150)
(root/'work/windows-local-relay-root-activation/stage.out').write_bytes(r.stdout+r.stderr)
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive':str(source.relative_to(root)),'sha256':expected,'exit':r.returncode,'staged':r.returncode==0,'servicesChanged':False,'secretsCopied':False}
(root/'outputs/decentralization-audit/windows-local-relay-staging.json').write_text(json.dumps(record,indent=2)+'\n')
print(r.stdout.decode(errors='replace'));print(r.stderr.decode(errors='replace'));raise SystemExit(r.returncode)
