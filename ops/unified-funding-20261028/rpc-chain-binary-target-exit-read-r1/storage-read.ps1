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

$expected=@(@{pid=41544;creation='134379669504007904'},@{pid=36920;creation='134379669703184426'},@{pid=54816;creation='134379669927805216'})
$prior=@(foreach($row in $expected){
 $exactPresent=$false;$actualCreation=$null
 try{$x=[Diagnostics.Process]::GetProcessById([int]$row.pid);try{$h=$x.Handle;$actualCreation=$x.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();$exactPresent=(-not $x.HasExited -and $actualCreation -ceq $row.creation)}finally{$x.Dispose()}}catch [ArgumentException]{}
 if($exactPresent){throw 'Prior exact staging reader still live'}
 @{pid=$row.pid;expectedCreation=$row.creation;exactPresent=$exactPresent;actualCreation=$actualCreation}
})
$parent='C:\EnclaveRpcTransition-c21fb012a73e4730aeef0360e7f4be19';$root='C:\EnclaveRpcTransition-c21fb012a73e4730aeef0360e7f4be19\c21fb012a73e4730aeef0360e7f4be19'
VerifyDirectory 'C:\' $false;VerifyDirectory $parent $true;VerifyDirectory $root $true
$items=@(@{name='cleanup-controller.exe';sha256='e8f5624e9109bf7ae22a7c3f4bd0bf6089747c25095fb450865e75807e633394';bytes=257024},@{name='definition-controller.exe';sha256='b2a54e2f10a2c84c3c359fda4657676fdbab4933fb0f5ce525d6437c971cb2da';bytes=257024},@{name='definition-entry.exe';sha256='46511864f38953d8a57287892f2eaef601940ce144a9f656ca60aa42bd988c07';bytes=257024},@{name='provider-entry.exe';sha256='76701f93d0c67f36f4074979e84a020fea8e506c7060ee1758b7411d2b5412a8';bytes=257024},@{name='startup-controller.exe';sha256='a73090235be3a6b2e7bd91828365ae68f4cef91f0e730511944257f53b5eb3df';bytes=257024})
$images=@(foreach($item in $items){
 $path=Join-Path $root $item.name
if([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse image'}
$f=New-Object IO.FileStream($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{
 if($f.Length -ne $item.bytes){throw 'Image length differs'}
 $sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($f))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 if($hash -cne $item.sha256){throw 'Image digest differs'}
 $acl=[IO.File]::GetAccessControl($path);if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $admin.Value){throw 'Image custody differs'}
 $raw=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)
 if($raw.DiscretionaryAcl -eq $null -or $raw.DiscretionaryAcl.Count -ne 2){throw 'Image DACL differs'}
 foreach($r in $raw.DiscretionaryAcl){if(-not ($r -is [Security.AccessControl.CommonAce]) -or $r.IsCallback -or $r.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $r.SecurityIdentifier.Value -notin @($admin.Value,$system.Value) -or $r.AccessMask -ne 2032127){throw 'Image authority differs'}}
 $sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
}finally{$f.Dispose()}
 @{name=$item.name;bytes=$item.bytes;sha256=$hash;sddl=$sddl}
})
$matches=@(Get-CimInstance Win32_Process -Filter "Name='provider-entry.exe' OR Name='startup-controller.exe' OR Name='cleanup-controller.exe' OR Name='definition-controller.exe' OR Name='definition-entry.exe'" -Property ProcessId,CreationDate,ExecutablePath -OperationTimeoutSec 3|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)}|Select-Object ProcessId,CreationDate)
if($matches.Count -ne 0){throw 'Staged executable unexpectedly active'}
$managers=@(foreach($row in @(@{pid=41272;creation='134375630850989593'},@{pid=40360;creation='134375630828500376'},@{pid=41308;creation='134375617394407059'},@{pid=38076;creation='134375086385617521'})){
 $x=[Diagnostics.Process]::GetProcessById($row.pid);try{$h=$x.Handle;$creation=$x.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();if($x.HasExited -or $creation -cne $row.creation){throw 'Original manager incarnation changed'};@{pid=$row.pid;creation=$creation;alive=$true}}finally{$x.Dispose()}
})
$vms=@(Get-VM|Select-Object Id,State,MemoryAssigned)
if($vms.Count -gt 32){throw 'VM observation bound'}
[pscustomobject]@{success=$true;atUtc=[DateTime]::UtcNow.ToString('o');priorExactProcesses=$prior;root=$root;files=$images;stagedProcesses=$matches;managers=$managers;vms=$vms;readOnly=$true;executed=$false;rpcReady=$false}|ConvertTo-Json -Depth 6 -Compress
