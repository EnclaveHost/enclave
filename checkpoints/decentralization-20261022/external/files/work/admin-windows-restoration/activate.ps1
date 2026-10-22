$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$root='C:\Program Files\Enclave\control\windows\node'
$stage='C:\ProgramData\Enclave\admin-restoration-20261020'
$files=@(@{name='host.mjs';before='b29f47dbefa65c2a1dd831856a5561865618c6a31e3240b20c19102cef750898';after='eeb6b5d641ce83aff9e96fc97ccbead4b762260a93bc78c2f3a8e2231684fc78'};@{name='chain.mjs';before='6bd9df748aeff581b0ce7fe5843d91018b6a6578cfc38ecab3d856116d2373cc';after='192dd90d1789e6d2f4cad9053b2b25365707ec5da9b6752c2f9037a53abf9cc7'};@{name='host-admission.bundle.mjs';before='2d4c8bd58e9c184d4c8ed9983ebcf3db5a33e725b6e23986368720f7f77528aa';after='3ec5461286b86a0d13f3511a2ca09713c28ede91b2ebe76f70b6d6c14643ee9b'})
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
