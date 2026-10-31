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

$root='C:\EnclaveRpcClock-856c8213f2a149c3a24e27904e2093c6\856c8213f2a149c3a24e27904e2093c6';$nonce='856c8213f2a149c3a24e27904e2093c6';$expected='57c35df39b752694a9cd420b84eed6c1f800c0331c2442dbe8fb743eacaf03f6';$expectedBoot='1a04e76600e411f1a395e342df676a80'
# Existing, previously qualified public native primitive, never its Main entry.
$library='C:\EnclaveRpcTransition-2716589b77df4ba7b3a2a3b34d9ceb21\2716589b77df4ba7b3a2a3b34d9ceb21\handoff-entry.exe'
$l=New-Object IO.FileStream($library,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{
 if($l.Length -gt 262144 -or $l.Length -lt 1){throw 'Bootstrap library bound'}
 $b=New-Object byte[] ([int]$l.Length);$offset=0
 while($offset -lt $b.Length){$n=$l.Read($b,$offset,$b.Length-$offset);if($n -le 0){throw 'Short bootstrap image'};$offset+=$n}
 $hash=[Security.Cryptography.SHA256]::Create();try{$digest=([BitConverter]::ToString($hash.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 if($digest -cne '5d52a5e22f48d17465274048a805b1d412c1a24e68f1062351b21406afa47fa2'){throw 'Bootstrap source image differs'}
 [void][Reflection.Assembly]::Load($b)
}finally{$l.Dispose()}
$origin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds();$deadline=$origin+30000
$envelope=[Enclave.OwnedRpc.BoundedWorker]::EnterSupervisorEnvelope(128MB)
$watchdog=[Enclave.OwnedRpc.BoundedWorker]::ArmOwnerObserver($origin,$deadline,($nonce+$nonce+$nonce+$nonce))
if($envelope.BootstrapPrivateBytes -gt 64MB){throw 'Explicit bootstrap allowance exceeded'}
$boot=[Enclave.OwnedRpc.ProtectedAttempt]::CurrentBoot();if($boot -cne $expectedBoot){throw 'Native boot differs'}
VerifyDirectory 'C:\' $false;VerifyDirectory ([IO.Path]::GetDirectoryName($root)) $true;VerifyDirectory $root $true
$os=Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory -OperationTimeoutSec 3
if(([long]$os.FreePhysicalMemory*1024) -lt 62709039104){throw 'Original pending-aware target floor refused'}
$managerExpected=@(@{pid=38076;created='2026-10-26T17:17:18.5617520Z'},@{pid=41308;created='2026-10-27T08:02:19.4407050Z'},@{pid=40360;created='2026-10-27T08:24:42.8500370Z'},@{pid=41272;created='2026-10-27T08:24:45.0989590Z'})
foreach($row in $managerExpected){$m=Get-CimInstance Win32_Process -Filter ('ProcessId='+$row.pid) -Property ProcessId,CreationDate -OperationTimeoutSec 3;if($m.ProcessId -ne $row.pid -or $m.CreationDate.ToUniversalTime().ToString('o') -cne $row.created){throw 'Original manager incarnation differs'}}
$contract=[Text.Encoding]::UTF8.GetBytes("owned-rpc-inert-v1`n$nonce`n$boot`n$origin`n$deadline`n$expected`ninert-v1`n")
WriteNew (Join-Path $root 'contract.txt') $contract
$contractHash=[Enclave.OwnedRpc.ProtectedAttempt]::Hash($contract)
$pin=[Enclave.OwnedRpc.ProtectedAttempt]::PinController((Join-Path $root 'contract.txt'),$contractHash)
$held=$null;$proc=$null
try{
 $file=Join-Path $root 'clock-sample.exe';$held=New-Object IO.FileStream($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 if($held.Length -ne 44544 -or ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint)){throw 'Pinned clock image bounds'}
 $hash=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($hash.ComputeHash($held))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 if($actual -cne $expected){throw 'Pinned clock image differs'}
 $before=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds();if($before -ge $deadline-8000){throw 'Insufficient original qualification window'}
 $start=New-Object Diagnostics.ProcessStartInfo;$start.FileName=$file;$start.Arguments=($nonce+' '+$nonce+' '+$expected);$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.WorkingDirectory=$root
 WriteNew (Join-Path $root 'qualification.intent') ([Text.Encoding]::UTF8.GetBytes('one read-only child; no production attempt'))
 $proc=[Diagnostics.Process]::Start($start);$handle=$proc.Handle;$pidHeld=$proc.Id;$created=$proc.StartTime.ToUniversalTime().ToFileTimeUtc()
 if(-not $proc.WaitForExit(8000)){$proc.Kill();if(-not $proc.WaitForExit(1000)){throw 'Exact sampler death unconfirmed'};throw 'Sampler exceeded original child allowance'}
 $after=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds();$exit=$proc.ExitCode
 $buffer=New-Object char[] 8193;$count=$proc.StandardOutput.ReadBlock($buffer,0,$buffer.Length);if($count -gt 8192){throw 'Sample output bound'};$stdout=New-Object string($buffer,0,$count)
 if($proc.StandardError.Read() -ne -1 -or $exit -ne 0){throw 'Sampler failed'}
 $sample=$stdout|ConvertFrom-Json
 if(@($sample.PSObject.Properties).Count -ne 5 -or $sample.schema -cne 'owned-rpc-windows-clock/1' -or $sample.attempt -cne $nonce -or $sample.vmAttempt -cne $nonce -or $sample.windowsBoot -cne $boot -or $sample.monotonicMilliseconds -lt $before -or $sample.monotonicMilliseconds -gt $after){throw 'Actual target sample differs'}
 foreach($row in $managerExpected){$m=Get-CimInstance Win32_Process -Filter ('ProcessId='+$row.pid) -Property ProcessId,CreationDate -OperationTimeoutSec 3;if($m.ProcessId -ne $row.pid -or $m.CreationDate.ToUniversalTime().ToString('o') -cne $row.created){throw 'Manager changed during qualification'}}
 [pscustomobject]@{schema='owned-rpc-target-clock-qualification/1';passed=$true;root=$root;sourceSha256=$actual;boot=$boot;origin=$origin;deadline=$deadline;before=$before;after=$after;sample=$sample;samplerPid=$pidHeld;samplerCreation=$created;samplerExit=$exit;samplerExactDeath=$proc.HasExited;supervisorPid=$PID;supervisorCreation=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc();supervisorEnvelope=$envelope;freeBytes=([long]$os.FreePhysicalMemory*1024);prospectiveMiB=39388;floorMiB=18432;managersUnchanged=$true;productionClockAssigned=$false;vmChanged=$false;systemContextQualified=$false}|ConvertTo-Json -Depth 6 -Compress
}finally{if($proc -ne $null){if(-not $proc.HasExited){$proc.Kill();[void]$proc.WaitForExit(1000)};$proc.Dispose()};if($held -ne $null){$held.Dispose()};$pin.Dispose()}
