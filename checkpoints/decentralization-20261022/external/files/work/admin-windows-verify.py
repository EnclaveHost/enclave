from pathlib import Path
import subprocess,base64,json
s=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$r='C:\Program Files\Enclave\control\windows\node';$files=@('host.mjs','chain.mjs','host-admission.bundle.mjs');$out=@();foreach($f in $files){$p=Join-Path $r $f;$t=[IO.File]::ReadAllText($p);$out+=[pscustomobject]@{file=$f;sha256=(Get-FileHash $p).Hash.ToLower();bytes=(Get-Item $p).Length;walletVisibility=($t -match 'forPrivate:d.isPublic===false');catalogBypass=($t -match 'version && !hostWalletPolicy|!this.hostAdmission && v.yanked|Only this host owner') }};$v=Invoke-RestMethod 'http://127.0.0.1:8091/vms';[pscustomobject]@{files=$out;vms=@($v.vms|Select-Object id,name,status,appId);nodePid=@(Get-NetTCPConnection -LocalPort 9600 -State Listen|Select-Object -ExpandProperty OwningProcess);walletConfigured=([IO.File]::ReadAllText('C:\ProgramData\Enclave\run-node.cmd') -match 'ENCLAVE_HOST_OWNERSHIP')}|ConvertTo-Json -Depth 5'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(s.encode('utf-16-le')).decode()],capture_output=True,text=True,timeout=45)
if r.returncode:raise RuntimeError(r.stderr[:500])
d=json.loads(r.stdout);p=Path('outputs/admin-control-audit/windows-after.json');p.write_text(json.dumps(d,indent=2)+'\n');print(json.dumps({'files':d['files'],'vmCount':len(d['vms']),'nodePid':d['nodePid'],'walletConfigured':d['walletConfigured']}))

expected=json.loads(Path('work/admin-windows-restoration/manifest.json').read_text())
assert all(next(x for x in d['files'] if x['file']==f['file'])['sha256']==f['afterSha256'] for f in expected['files'])
assert {x['id']:x['status'] for x in d['vms']}=={x['id']:x['status'] for x in expected['beforeVMs']},'guest inventory changed'
activation=json.loads(Path('outputs/admin-control-audit/windows-activation.json').read_text())
assert d['nodePid'] and activation['oldPid'] not in d['nodePid'],'node has not restarted'
assert not any(f['catalogBypass'] for f in d['files'])
print('verified exact installed hashes, new node process, same guests and statuses')
