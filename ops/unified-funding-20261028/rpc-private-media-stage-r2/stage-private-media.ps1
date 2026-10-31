param(
 [Parameter(Mandatory=$true)][ValidateSet('create','probe','verify')][string]$Phase,
 [Parameter(Mandatory=$true)][string]$SpecificationBase64
)
# File preparation only. No VM/provider operations, ACL repair after transfer,
# private-content output, retries, or startup admission.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SpecificationBase64))|ConvertFrom-Json
$admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$id=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($id)
if($id.ImpersonationLevel -ne [Security.Principal.TokenImpersonationLevel]::None -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Primary administrator required'}
if($spec.nonce -cnotmatch '^[0-9a-f]{32}$'){throw 'Invalid nonce'}
$parent='C:\EnclaveRpcPrivateMedia-'+$spec.nonce
$root=Join-Path $parent $spec.nonce
$names=@('boot.vhdx','seed.iso','custody-probe.bin')
if(@($spec.files.PSObject.Properties).Count -ne 3){throw 'Exact media set required'}
foreach($name in $names){
 $entry=$spec.files.$name
 if($null -eq $entry -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or [long]$entry.bytes -le 0){throw 'Invalid media record'}
}
if([long]$spec.files.'boot.vhdx'.bytes -gt 4GB -or [long]$spec.files.'seed.iso'.bytes -gt 64MB -or [long]$spec.files.'custody-probe.bin'.bytes -gt 4096){throw 'Media size bound'}

function AssertPrivateAcl($acl,[bool]$directory){
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 $allowed=@($admin.Value,$system.Value)
 if(-not $directory){$allowed+=@($id.User.Value)}
 if($owner -notin $allowed -or -not $acl.AreAccessRulesProtected){throw 'Private owner/protected DACL required'}
 $raw=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)
 if($null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -eq 0){throw 'Private DACL absent'}
 foreach($ace in $raw.DiscretionaryAcl){
  if(-not ($ace -is [Security.AccessControl.CommonAce]) -or $ace.IsCallback){throw 'Unsupported private ACE'}
  if($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessDenied){continue}
  if($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed){throw 'Unsupported private qualifier'}
  # Inherit-only foreign grants are also forbidden: they could expose new files.
  if($ace.SecurityIdentifier.Value -notin $allowed){throw 'Foreign private-media access'}
 }
}
function AssertDirectory([string]$path){
 $attrs=[IO.File]::GetAttributes($path)
 if(($attrs -band [IO.FileAttributes]::ReparsePoint) -or -not ($attrs -band [IO.FileAttributes]::Directory)){throw 'Directory/reparse refused'}
 AssertPrivateAcl ([IO.Directory]::GetAccessControl($path)) $true
}
function AssertVolumeNamespace {
 $path='C:\';$attrs=[IO.File]::GetAttributes($path)
 if($attrs -band [IO.FileAttributes]::ReparsePoint){throw 'Volume reparse refused'}
 $acl=[IO.Directory]::GetAccessControl($path)
 $installer=(New-Object Security.Principal.NTAccount('NT SERVICE','TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($admin.Value,$system.Value,$installer)){throw 'Volume owner differs'}
 $raw=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)
 if($null -eq $raw.DiscretionaryAcl){throw 'Null volume DACL'}
 foreach($ace in $raw.DiscretionaryAcl){
  if(-not ($ace -is [Security.AccessControl.CommonAce]) -or $ace.IsCallback){throw 'Unsupported volume ACE'}
  if(([int]$ace.AceFlags -band 8) -or $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessDenied){continue}
  if($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed){throw 'Unsupported volume qualifier'}
  if($ace.SecurityIdentifier.Value -in @($admin.Value,$system.Value,$installer)){continue}
  if(([long]$ace.AccessMask -band 0x000d0150) -or ([long]$ace.AccessMask -band 0x50000000)){throw 'Foreign ancestor mutation'}
 }
}
function NewPrivateDirectory([string]$path){
 if([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)){throw 'Namespace already consumed'}
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 [void][IO.Directory]::CreateDirectory($path,$acl);AssertDirectory $path
}
function NewPrivateFile([string]$name,[byte[]]$bytes){
 $path=Join-Path $root $name
 $f=New-Object IO.FileStream($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
 try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
 # Creation inherits only the private directory grants. Pin an explicit DACL
 # before any copy; verification never changes an existing file's permissions.
 $acl=New-Object Security.AccessControl.FileSecurity
 $acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))}
 [IO.File]::SetAccessControl($path,$acl)
 AssertPrivateAcl ([IO.File]::GetAccessControl($path)) $false
}
function InspectFile([string]$name,[long]$length,[string]$digest){
 $path=Join-Path $root $name
 $attrs=[IO.File]::GetAttributes($path)
 if($attrs -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)){throw 'Media file/reparse refused'}
 AssertPrivateAcl ([IO.File]::GetAccessControl($path)) $false
 $f=New-Object IO.FileStream($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
 try{
  if($f.Length -ne $length){throw 'Media length differs'}
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$actual=([BitConverter]::ToString($sha.ComputeHash($f))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  if($digest -and $actual -cne $digest){throw 'Media digest differs'}
  AssertPrivateAcl ([IO.File]::GetAccessControl($path)) $false
  return @{name=$name;bytes=$length;sha256=$actual;privateAcl=$true}
 }finally{$f.Dispose()}
}
function AssertManager {
 $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 8091 -ErrorAction Stop|Select-Object -ExpandProperty OwningProcess -Unique)
 if($listeners.Count -ne 1 -or [int]$listeners[0] -ne [int]$spec.manager.pid){throw 'Manager listener differs'}
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$spec.manager.pid) -Property ProcessId,CreationDate,ExecutablePath -OperationTimeoutSec 3
 if($null -eq $p -or $p.CreationDate.ToUniversalTime().ToString('o') -cne $spec.manager.created -or $p.ExecutablePath -cne $spec.manager.exe){throw 'Manager incarnation differs'}
}
function Resources {
 $os=Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,LastBootUpTime -OperationTimeoutSec 3
 $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property FreeSpace,FileSystem -OperationTimeoutSec 3
 if($os.LastBootUpTime.ToUniversalTime().ToString('o') -cne $spec.boot -or $disk.FileSystem -cne 'NTFS'){throw 'Host identity/filesystem differs'}
 if(([long]$os.FreePhysicalMemory*1024) -lt 62709039104){throw 'Preparation memory floor'}
 $floor=16GB+256MB
 if($Phase -eq 'create'){$floor+=1GB+[long]$spec.files.'boot.vhdx'.bytes+[long]$spec.files.'seed.iso'.bytes}
 if([long]$disk.FreeSpace -lt $floor){throw 'Preparation disk floor'}
 return @{freeBytes=([long]$os.FreePhysicalMemory*1024);diskFreeBytes=[long]$disk.FreeSpace}
}
function AclRefusalChecks {
 $count=0
 foreach($rights in @('Read','Write','FullControl')){
  $acl=New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admin,'FullControl','Allow')))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),$rights,'Allow')))
  $refused=$false;try{AssertPrivateAcl $acl $false}catch{$refused=$true}
  if(-not $refused){throw 'Foreign file ACL fixture accepted'};$count++
 }
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'Read','ObjectInherit','InheritOnly','Allow')))
 $refused=$false;try{AssertPrivateAcl $acl $true}catch{$refused=$true}
 if(-not $refused){throw 'Foreign inheritable ACL fixture accepted'}
 return ($count+1)
}

AssertVolumeNamespace;AssertManager;$before=Resources
$rows=@();$checks=AclRefusalChecks
if($Phase -eq 'create'){
 NewPrivateDirectory $parent;NewPrivateDirectory $root
 $intent=[Text.Encoding]::UTF8.GetBytes(($spec|ConvertTo-Json -Depth 8 -Compress))
 NewPrivateFile 'media.intent' $intent
 foreach($name in $names){NewPrivateFile $name ([byte[]]@())}
}else{
 AssertDirectory $parent;AssertDirectory $root
 $intent=[Text.Encoding]::UTF8.GetBytes(($spec|ConvertTo-Json -Depth 8 -Compress))
 $sha=[Security.Cryptography.SHA256]::Create()
 try{$intentHash=([BitConverter]::ToString($sha.ComputeHash($intent))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 [void](InspectFile 'media.intent' $intent.Length $intentHash)
 foreach($name in $names){
  $entry=$spec.files.$name
  if($Phase -eq 'probe' -and $name -ne 'custody-probe.bin'){$rows+=InspectFile $name 0 ''}
  else{$rows+=InspectFile $name ([long]$entry.bytes) $entry.sha256}
 }
}
$vhd=$null
if($Phase -eq 'verify'){
 $v=Get-VHD -Path (Join-Path $root 'boot.vhdx')
 if($v.Attached -or $v.ParentPath -or $v.Size -ne 3758096384 -or [string]$v.VhdFormat -ne 'VHDX' -or [string]$v.VhdType -ne 'Dynamic'){throw 'Unexpected VHDX metadata'}
 $vhd=@{virtualBytes=[long]$v.Size;attached=[bool]$v.Attached;type=[string]$v.VhdType}
}
AssertDirectory $parent;AssertDirectory $root;AssertVolumeNamespace;AssertManager;$after=Resources
[pscustomobject]@{success=$true;phase=$Phase;root=$root;files=$rows;vhd=$vhd;before=$before;after=$after;aclRefusals=$checks;privateContentsPrinted=$false;vmChanged=$false;startAdmitted=$false}|ConvertTo-Json -Depth 8 -Compress
