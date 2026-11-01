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

$expected=@(@{pid=47608;creation='134379652697817105'},@{pid=47384;creation='134379652886753129'},@{pid=57624;creation='134379653062501357'})
$prior=@(foreach($row in $expected){
 $exactPresent=$false;$actualCreation=$null
 try{$x=[Diagnostics.Process]::GetProcessById([int]$row.pid);try{$h=$x.Handle;$actualCreation=$x.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();$exactPresent=(-not $x.HasExited -and $actualCreation -ceq $row.creation)}finally{$x.Dispose()}}catch [ArgumentException]{}
 if($exactPresent){throw 'Prior exact staging reader still live'}
 @{pid=$row.pid;expectedCreation=$row.creation;exactPresent=$exactPresent;actualCreation=$actualCreation}
})
$parent='C:\EnclaveRpcTransition-f6f885d68da7405c83e063e038d0ca27';$root='C:\EnclaveRpcTransition-f6f885d68da7405c83e063e038d0ca27\f6f885d68da7405c83e063e038d0ca27'
VerifyDirectory 'C:\' $false;VerifyDirectory $parent $true;VerifyDirectory $root $true
$items=@(@{name='cleanup-controller.exe';sha256='423c5a7c1465d61f4627fb8f86c31c3d6e42ced5079fe76bc7e0a77335bb5149';bytes=253952},@{name='definition-controller.exe';sha256='0621219a379ae8c41c1dba10d5ef3c58951be3267c37d00ef5feb1dc6cb62b0e';bytes=253440},@{name='definition-entry.exe';sha256='676c5396facfed46c0fc13e2454be3c3cbf0395cbc6a622cecdeaa63bbc2584b';bytes=253440},@{name='provider-entry.exe';sha256='f2fe087638637f9bba69f32de62a8ac5098d52a4228d9760ef6e133c4da79d4e';bytes=253952},@{name='startup-controller.exe';sha256='7e792a66ae694beba0eb99f1fe4b6e4db52a4a42334e9b0a9574b63f731b7044';bytes=253952})
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
