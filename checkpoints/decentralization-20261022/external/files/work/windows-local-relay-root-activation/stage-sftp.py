from pathlib import Path
import subprocess,base64,hashlib,json,datetime,ast
root=Path('/home/steven/Documents/Codex/2026-10-18/wo')
source=root/'work/windows-local-relay-migration/local-relay-20261021-stage.zip'
expected='71ab3123b590b4457ea193c4af1ef3af48f52f3c757789307a1e6674068b1008'
assert hashlib.sha256(source.read_bytes()).hexdigest()==expected,'archive changed'
def ps(script):
 enc=base64.b64encode(script.encode('utf-16le')).decode()
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',enc],capture_output=True,timeout=60)
 print(r.stdout.decode(errors='replace'));print(r.stderr.decode(errors='replace'));r.check_returncode();return r
previous=next(ast.literal_eval(n.value) for n in ast.parse((root/'work/windows-local-relay-root-activation/stage.py').read_text()).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='script' for t in n.targets))
enc=base64.b64encode(previous.encode('utf-16le')).decode()
ps("$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { [string]$_.CommandLine -like '*"+enc+"*' }); 'Previous upload process count: '+$p.Count; if($p.Count){throw 'Previous upload still live; no restart'}; if((Test-Path -LiteralPath 'C:/ProgramData/Enclave/activation-stage/local-relay-20261021') -or (Test-Path -LiteralPath 'C:/ProgramData/Enclave/activation-stage/local-relay-20261021-71ab3123-sftp.zip')){throw 'Target already exists'}")
r=subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=15',str(source),'minipc:C:/ProgramData/Enclave/activation-stage/local-relay-20261021-71ab3123-sftp.zip'],capture_output=True,timeout=60)
print(r.stderr.decode(errors='replace'));r.check_returncode()
ps(r'''$ErrorActionPreference='Stop'
$stage='C:/ProgramData/Enclave/activation-stage/local-relay-20261021'
$zip='C:/ProgramData/Enclave/activation-stage/local-relay-20261021-71ab3123-sftp.zip'
if(Test-Path -LiteralPath $stage){throw 'Stage exists'}
if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne '71ab3123b590b4457ea193c4af1ef3af48f52f3c757789307a1e6674068b1008'){throw 'Archive hash mismatch'}
New-Item -ItemType Directory -Path $stage | Out-Null
& icacls.exe $stage /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not protect stage'}
Expand-Archive -LiteralPath $zip -DestinationPath $stage
'Package staged; no services changed'
''')
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive':str(source.relative_to(root)),'sha256':expected,'staged':True,'servicesChanged':False,'secretsCopied':False,'transport':'SFTP; prior raw stdin upload timed out and retained as unused partial archive; previous remote process absent verified'}
(root/'outputs/decentralization-audit/windows-local-relay-staging.json').write_text(json.dumps(record,indent=2)+'\n')
