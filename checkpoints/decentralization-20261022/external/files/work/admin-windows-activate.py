from pathlib import Path
import subprocess,base64,json,hashlib,datetime
root=Path.cwd();out=root/'work/admin-windows-restoration';m=json.loads((out/'manifest.json').read_text());pf=json.loads((root/'outputs/admin-control-audit/runtime-preflight.json').read_text())
assert len(pf['results'])>=8 and all(x['refusal'] is None for x in pf['results'])
assert (datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(pf['at'].replace('Z','+00:00'))).total_seconds()<600
stage=r'C:\ProgramData\Enclave\admin-restoration-20261020'
def ps(s):
 p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(s.encode('utf-16-le')).decode()],capture_output=True,text=True,timeout=45)
 if p.returncode:raise RuntimeError(p.stderr[:600] or p.stdout[:600])
 return p.stdout
ps("$ErrorActionPreference='Stop';New-Item -ItemType Directory -Force -Path '"+stage+"'|Out-Null")
for f in m['files']:
 p=out/f['file'];assert hashlib.sha256(p.read_bytes()).hexdigest()==f['afterSha256']
 proc=subprocess.run(['scp','-q','-o','BatchMode=yes',str(p),'minipc:'+stage.replace('\\','/')+'/'+f['file']],capture_output=True,text=True,timeout=30)
 assert proc.returncode==0,proc.stderr[:200]
rows=';'.join("@{name='%s';before='%s';after='%s'}"%(f['file'],f['sha256'],f['afterSha256']) for f in m['files'])
s=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$root='C:\Program Files\Enclave\control\windows\node'
$stage='STAGE'
$files=@(ROWS)
$journal=Join-Path $stage 'activation.json'
if(Test-Path $journal){throw 'activation already attempted; inspect journal, do not resend'}
foreach($f in $files){
 if((Get-FileHash (Join-Path $root $f.name)).Hash.ToLower() -ne $f.before){throw 'live source changed'}
 if((Get-FileHash (Join-Path $stage $f.name)).Hash.ToLower() -ne $f.after){throw 'stage bytes changed'}
}
$listener=@(Get-NetTCPConnection -LocalPort 9600 -State Listen)
if($listener.Count -ne 1){throw 'unexpected listener count'}
$oldPid=$listener[0].OwningProcess
$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
if($proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch 'agent\.mjs'){throw 'unexpected node process'}
foreach($f in $files){& $proc.ExecutablePath --check (Join-Path $stage $f.name);if($LASTEXITCODE -ne 0){throw 'syntax check failed'}}
$before=Invoke-RestMethod 'http://127.0.0.1:8091/vms'
$before.vms|Select-Object id,name,status,appId|ConvertTo-Json -Depth 4|Set-Content (Join-Path $stage 'vms-before.json')
foreach($f in $files){Copy-Item (Join-Path $root $f.name) (Join-Path $stage ('backup-'+$f.name))}
@{phase='prepared';oldPid=$oldPid;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content $journal
try {
 foreach($f in $files){Copy-Item (Join-Path $stage $f.name) (Join-Path $root $f.name) -Force}
 foreach($f in $files){if((Get-FileHash (Join-Path $root $f.name)).Hash.ToLower() -ne $f.after){throw 'activation copy mismatch'}}
}catch{
 foreach($f in $files){Copy-Item (Join-Path $stage ('backup-'+$f.name)) (Join-Path $root $f.name) -Force}
 throw
}
@{phase='files-installed';oldPid=$oldPid;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content $journal
Stop-Process -Id $oldPid -Force
$r=@{phase='node-restart-requested';oldPid=$oldPid;managerRestarted=$false;vmCount=@($before.vms).Count;at=[DateTime]::UtcNow.ToString('o')}
$r|ConvertTo-Json|Set-Content $journal
$r|ConvertTo-Json
'''.replace('STAGE',stage).replace('ROWS',rows)
(out/'activate.ps1').write_text(s)
result=json.loads(ps(s));(root/'outputs/admin-control-audit/windows-activation.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
