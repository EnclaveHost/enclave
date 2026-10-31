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
$parent='C:\EnclaveRpcBootMedia-af667437b1764a459adf62912a5ce2bf';$root=Join-Path $parent 'af667437b1764a459adf62912a5ce2bf'
VerifyDirectory 'C:\' $false;VerifyDirectory $parent $true;VerifyDirectory $root $true
$rows=@()
$file=Join-Path $root 'boot.vhdx';SecureFileAcl $file
if((Get-Item -LiteralPath $file).Length -ne 1933574144){throw 'File length mismatch'}
$h=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();if($h -cne '5d01973660220c8069d707e8d54a38d3a68e32956ac8ff9a0075b714974fd175'){throw 'File digest mismatch'}
$rows+=@{name='boot.vhdx';sha256=$h;bytes=1933574144}
$file=Join-Path $root 'seed.iso';SecureFileAcl $file
if((Get-Item -LiteralPath $file).Length -ne 378880){throw 'File length mismatch'}
$h=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();if($h -cne 'c92f5bc01f1c615df4a5f5df697c0cb9e32456ddfb8f88e746e561e1f981b78a'){throw 'File digest mismatch'}
$rows+=@{name='seed.iso';sha256=$h;bytes=378880}
$v=Get-VHD -Path (Join-Path $root 'boot.vhdx')
if($v.Attached -or $v.ParentPath -or $v.Size -ne 3758096384 -or [string]$v.VhdFormat -ne 'VHDX'){throw 'Unexpected target VHDX metadata'}
$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property FreeSpace -OperationTimeoutSec 3
if([long]$disk.FreeSpace -lt (16GB+256MB)){throw 'Post-stage disk floor'}
[pscustomobject]@{verified=$true;root=$root;files=$rows;vhd=@{format=[string]$v.VhdFormat;type=[string]$v.VhdType;virtualBytes=[long]$v.Size;fileBytes=[long]$v.FileSize;attached=[bool]$v.Attached};diskFreeBytes=[long]$disk.FreeSpace;nativeVmAttempted=$false;startAdmitted=$false}|ConvertTo-Json -Depth 5 -Compress
