from pathlib import Path
import base64,subprocess,json,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo'); src=root/'work/shield-hardware-canary';out=root/'work/canary-native-review';out.mkdir(exist_ok=True)
remote='C:\\Users\\claude\\AppData\\Local\\Temp\\enclave-canary-review-20261020'
def run(script,name):
 enc=base64.b64encode(script.encode('utf-16le')).decode()
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc','powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+enc],capture_output=True,text=True,timeout=60)
 (out/(name+'.log')).write_text(r.stdout+'\n'+r.stderr);print(name,'exit',r.returncode,r.stdout[-3000:],r.stderr[-300:],flush=True)
 if r.returncode:raise RuntimeError(name+' failed')
 return r
run("$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path '"+remote+"' | Out-Null",'mkdir')
for f in ['lib.ps1','assert-vm.ps1','cleanup.ps1','run-manager.ps1','stage.ps1','invariants.ps1','gcs.ps1','registration-fixtures.ps1','stage-fixtures.ps1','installer-key-block.ps1']:
 subprocess.run(['scp','-q','-o','BatchMode=yes',str(src/f),'minipc:'+remote.replace('\\','/')+'/'+f],check=True,timeout=30)
for f in ['build-bundle.ps1']:
 subprocess.run(['scp','-q','-o','BatchMode=yes',str(root/'work/enclave/windows/installer'/f),'minipc:'+remote.replace('\\','/')+'/'+f],check=True,timeout=30)
run("$ErrorActionPreference='Stop'; $bad=0; Get-ChildItem -LiteralPath '"+remote+"' -Filter '*.ps1' | ForEach-Object { $tok=$null;$err=$null;[void][Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tok,[ref]$err); if($err.Count){$err|ForEach-Object{Write-Output $_.Message};$bad+=$err.Count}else{Write-Output ('PARSE PASS '+$_.Name)} };exit $bad",'parse')
script=r'''
$ErrorActionPreference='Stop'
$dir='@@DIR@@'
$global:called=0
$global:fakeVm=[pscustomobject]@{Name='enclave-canary-test';Id=[guid]'12345678-1234-1234-1234-123456789abc';Notes=''}
function global:Get-VM { param($Id); $global:called++; return $global:fakeVm }
$rid='hv'+('1'*32);$dep='0x'+('2'*64)
$notes=[ordered]@{v=1;id=$rid;name=$dep;instanceId='test'}|ConvertTo-Json -Compress
$b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($notes)).TrimEnd('=').Replace('+','-').Replace('/','_')
$global:fakeVm.Notes='enclave-canary-vbslike-domain/manager|'+$b64
$good=& (Join-Path $dir 'assert-vm.ps1') -VmId $global:fakeVm.Id.Guid -VmName $global:fakeVm.Name -RecordId $rid -Deployment $dep -InstanceId 'test'
if(-not ($good|ConvertFrom-Json).verified -or $global:called -ne 1){throw 'positive native Notes validation failed'}
Write-Output 'PASS native canary Notes identity'
foreach($case in 'production-marker','wrong-id','wrong-name','wrong-instance') {
 $global:fakeVm.Name='enclave-canary-test';$global:fakeVm.Notes='enclave-canary-vbslike-domain/manager|'+$b64
 $wantId=$rid;$wantInstance='test'
 switch($case){'production-marker'{$global:fakeVm.Notes='enclave-vbslike-app-domain/manager|'+$b64};'wrong-id'{$wantId='hv'+('3'*32)};'wrong-name'{$global:fakeVm.Name='enclave-app-production'};'wrong-instance'{$wantInstance='different'}}
 $rejected=$false
 try{& (Join-Path $dir 'assert-vm.ps1') -VmId $global:fakeVm.Id.Guid -VmName 'enclave-canary-test' -RecordId $wantId -Deployment $dep -InstanceId $wantInstance|Out-Null}catch{$rejected=$true}
 if(-not $rejected){throw "accepted $case"};Write-Output "PASS reject $case"
}
. (Join-Path $dir 'lib.ps1')
$approval=Join-Path $dir 'approvals-fixture';New-Item -ItemType Directory -Force $approval|Out-Null
Set-Content -LiteralPath (Join-Path $approval 'approved-steps.txt') 'unapproved: cleanup'
$no=$false;try{[void](Require-Approval $approval 'cleanup' -Apply)}catch{$no=$true};if(-not $no){throw 'substring granted approval'}
Write-Output 'PASS exact approval matching'
$r=Require-Approval $approval 'cleanup';if($r -isnot [bool] -or $r -ne $false){throw 'plan-only result is not strict false'}
Write-Output 'PASS plan-only boolean'
Write-Output 'NATIVE FIXTURES ONLY: no real Get-VM, registry, task, installer or stage mutation invoked'
'''.replace('@@DIR@@',remote)
run(script,'native-fixtures')
run("& '"+remote+"\\registration-fixtures.ps1' -Scripts '"+remote+"'; if (-not $?) { exit 1 }",'registration-fixtures')
run("& '"+remote+"\\stage-fixtures.ps1' -Scripts '"+remote+"'; if (-not $?) { exit 1 }",'stage-fixtures')
(out/'evidence.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'remote':remote,'scope':'Native PowerShell parse and pure fixture verification. Get-VM replaced by a local function; only scratch files written. No registry, scheduled task, installer, VM creation or removal executed.','parseFiles':11,'fixtureChecks':16},indent=2)+'\n')
