$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$id=[Security.Principal.WindowsIdentity]::GetCurrent();$pr=New-Object Security.Principal.WindowsPrincipal($id)
if($id.ImpersonationLevel -ne [Security.Principal.TokenImpersonationLevel]::None -or -not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Primary administrator required'}
function VerifyDirectory([string]$path,[bool]$strict){
 $attrs=[IO.File]::GetAttributes($path)
 if(($attrs -band [IO.FileAttributes]::ReparsePoint) -or -not ($attrs -band [IO.FileAttributes]::Directory)){throw 'Directory/reparse refused'}
 $acl=[IO.Directory]::GetAccessControl($path);$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 $installer=(New-Object Security.Principal.NTAccount('NT SERVICE','TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value
 if($owner -ne $admin.Value -and $owner -ne $system.Value -and ($strict -or $owner -ne $installer)){throw 'Namespace owner differs'}
 if($strict -and -not $acl.AreAccessRulesProtected){throw 'Protected directory DACL required'}
 $raw=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)
 if($raw.DiscretionaryAcl -eq $null){throw 'Null directory DACL refused'}
 foreach($r in $raw.DiscretionaryAcl){
  if(-not ($r -is [Security.AccessControl.CommonAce]) -or $r.IsCallback){throw 'Unsupported directory ACE'}
  if((([int]$r.AceFlags -band 8) -ne 0) -or $r.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessDenied){continue}
  if($r.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed){throw 'Unsupported directory qualifier'}
  $sid=$r.SecurityIdentifier.Value
  if($sid -eq $admin.Value -or $sid -eq $system.Value -or (-not $strict -and $sid -eq $installer)){continue}
  $mask=[long]$r.AccessMask;$danger=0x000d0150;if($strict){$danger=0x000d0156}
  if(($mask -band $danger) -or ($mask -band 0x50000000)){throw 'Foreign namespace mutation right'}
 }
}
function NewDirectory([string]$path){
 if([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)){throw 'Input namespace already consumed'}
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 [void][IO.Directory]::CreateDirectory($path,$acl);VerifyDirectory $path $true
}
function SecureFileAcl([string]$path){
 if([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse file refused'}
 $acl=New-Object Security.AccessControl.FileSecurity;$acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))}
 [IO.File]::SetAccessControl($path,$acl)
}
function WriteNew([string]$path,[byte[]]$bytes){
 $f=New-Object IO.FileStream($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
 try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()};SecureFileAcl $path
}

# Only fixed fresh fixture namespaces; no VM/provider/manager operations.
$library='C:\EnclaveRpcHandoffInputs-fd2196083e5a4b0d92b1065f7a14957e\fd2196083e5a4b0d92b1065f7a14957e\entry.exe'
$bytes=[IO.File]::ReadAllBytes($library)
function Hash([byte[]]$raw){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
if((Hash $bytes) -cne '28ffe56cf25737589b5602c73f050a6461f21cfd97a3419ddfd13444b4b157a3'){throw 'Reviewed native assembly differs'}
[void][Reflection.Assembly]::Load($bytes)
if([Enclave.OwnedRpc.ProtectedAttempt]::CurrentBoot() -cne '@BOOT@'){throw 'Native boot differs'}
$origin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds();$deadline=[Math]::Min($origin+20000L,@DEADLINE@L)
$envelope=[Enclave.OwnedRpc.BoundedWorker]::EnterSupervisorEnvelope(128MB)
$watchdog=[Enclave.OwnedRpc.BoundedWorker]::ArmOwnerObserver($origin,$deadline,('@TOKEN@'))
if(-not $envelope.MembershipVerified -or -not $envelope.LimitsVerified){throw 'Preparation containment differs'}
VerifyDirectory 'C:\' $false
$os=Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory -OperationTimeoutSec 3
$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property FreeSpace -OperationTimeoutSec 3
if(([long]$os.FreePhysicalMemory*1024) -lt 62709039104 -or [long]$disk.FreeSpace -lt (21GB+256MB)){throw 'Retained fixture headroom refused'}
function FreshRoot([string]$kind,[string]$nonce){$parent='C:\EnclaveRpc'+$kind+'-'+$nonce;$root=Join-Path $parent $nonce;NewDirectory $parent;NewDirectory $root;WriteNew (Join-Path $root 'QUALIFICATION-ONLY.txt') ([Text.Encoding]::UTF8.GetBytes('SYNTHETIC FILE FIXTURE ONLY. NOT A REAL VM, CUT, CAPACITY OR PRODUCTION ADMISSION.'));return $root}
function Bytes([string]$value){return [Text.Encoding]::UTF8.GetBytes($value)}
$handoff=FreshRoot 'LegacyHandoff' '@HANDOFF@';$vm=FreshRoot 'Vm' '@VM@';$media=FreshRoot 'PrivateMedia' '@MEDIA@'
$contract=Bytes ((@('owned-rpc-legacy-handoff-v1','@HANDOFF@','@BOOT@','@ORIGIN@','@CUTDEADLINE@',('a'*64),'legacy-memory-cut-seed-v1',('b'*64),'') -join "`n"))
$activation=@{schema='legacy-pool-seed/2';creationMode='retained-fenced-rpc-only/1';manifest=('b'*64);boot='@BOOT@';configPath='C:\Fixture\pool.txt';poolHash=('c'*64);capacityBytes=79267102720L;initialBytes=16154361856L;initialCount=4;physicalBytes=120070115328L;nonPoolReserveBytes=20401094656L;floorBytes=19327352832L;variationBytes=1073741824L;prospectiveBytes=41301311488L;cutHash=('d'*64);inventoryHash=('e'*64);providerSettled=$false;capacityAdmitted=$false;reservationMayRelease=$false}
$activationRaw=Bytes ($activation|ConvertTo-Json -Compress)
WriteNew (Join-Path $handoff 'contract.txt') $contract;WriteNew (Join-Path $handoff 'pool.activation') $activationRaw;WriteNew (Join-Path $handoff 'pool.complete') (Bytes (Hash $activationRaw))
$boot=New-Object byte[] 32768;$seed=Bytes 'INERT-TARGET-SEED-NO-CREDENTIALS'
WriteNew (Join-Path $media 'boot.vhdx') $boot;WriteNew (Join-Path $media 'seed.iso') $seed
$plan=Bytes ((@('owned-rpc-definition/1','@VM@','@BOOT@',('f'*64),('a'*64),$vm,'@ORIGIN@','@DEADLINE@',(Hash $boot),(Hash $seed),'generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false','') -join "`n"))
$receipt=Bytes '{"fixture":"synthetic-off-definition-NOT-A-VM"}'
$system=Bytes (@{receipt=(Hash $receipt);system='Msvm_ComputerSystem.CreationClassName="Msvm_ComputerSystem",Name="00000000-0000-0000-0000-000000000001"'}|ConvertTo-Json -Compress)
WriteNew (Join-Path $vm 'definition-plan.txt') $plan;WriteNew (Join-Path $vm 'definition.receipt') $receipt;WriteNew (Join-Path $vm 'definition.system') $system;WriteNew (Join-Path $vm 'definition.off') (Bytes ((Hash $system)+';'+(Hash $plan)+';owned-off-zero;start-authorized=false'))
if([Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds() -ge $deadline){throw 'Preparation deadline expired'}
[pscustomobject]@{success=$true;fixtureOnly=$true;pid=$PID;creation=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString());origin=$origin;deadline=$deadline;envelope=$envelope;collect=@{root=$handoff;contractHash=(Hash $contract);activation=$activation};copy=@{sourceRoot=$media;planHash=(Hash $plan)};vmRoot=$vm;dummyFiles=@(@{name='boot.vhdx';bytes=$boot.Length;sha256=(Hash $boot)},@{name='seed.iso';bytes=$seed.Length;sha256=(Hash $seed)});vmChanged=$false}|ConvertTo-Json -Depth 8 -Compress
