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
$parent='C:\EnclaveRpcTransition-2716589b77df4ba7b3a2a3b34d9ceb21';$root=Join-Path $parent '2716589b77df4ba7b3a2a3b34d9ceb21'
VerifyDirectory 'C:\' $false
VerifyDirectory $parent $true;VerifyDirectory $root $true

$items=@(
@{name='BUNDLE.json';sha256='4247500a5467f113283eb4a34bd25dc60cb21613c78525a2d7cba805fc67f5ed'}
@{name='MEDIA.json';sha256='e048430785e94f76676e3d2d14de69362f1bd29f4f1f28e3fe004315d9056991'}
@{name='SPEC.json';sha256='9b1b2d35ef5e8a7287b42e20eb6102f84f594b3bd8e7943ea5b95f9d502da6bf'}
@{name='cleanup-controller.exe';sha256='b5f9fe59febaf0c5af2aefd4d46286ae87a3be73dd4f0a75e22abbc51f0dfc36'}
@{name='definition-controller.exe';sha256='8d34296e58b83f27d5662adb5f58b3cd80f89bd2953435b2232211fb727b8b41'}
@{name='definition-entry.exe';sha256='fc23708df1e44f1bbea1305b21aa4e7c2546c3a05cf153903cfdaa82bce1eacc'}
@{name='handoff-controller.exe';sha256='0fc47781f75b22e6677d319a52950f05989d6f173dc2c5362e00491eb4527b1c'}
@{name='handoff-entry.exe';sha256='5d52a5e22f48d17465274048a805b1d412c1a24e68f1062351b21406afa47fa2'}
@{name='handoff.json';sha256='918e99aec938a30f1b4fcc9a660ec57afbbee5d9f54ce6408dbaa57725124d64'}
@{name='provider-entry.exe';sha256='3a439f8ca0d8a677734df0008b4aa729136bce19a3facb6878caa7bb9e775cf3'}
@{name='startup-controller.exe';sha256='cb84bfda1dd6083bb431cbb394b47728d4f194fabd4fe9ae7e029d7442f61516'}
)
$results=@();$held=New-Object Collections.Generic.List[object]
try { foreach($item in $items){
 $path=Join-Path $root $item.name;SecureFileAcl $path
 $f=New-Object IO.FileStream($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$held.Add($f)
 if($f.Length -gt 262144 -or $f.Length -lt 1){throw 'Artifact bound'}
 $sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($f))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 if($hash -cne $item.sha256){throw 'Target bundle digest differs'}
 $results+=@{name=$item.name;bytes=$f.Length;sha256=$hash}
 };WriteNew (Join-Path $root 'bundle.verified.json') ([Text.Encoding]::UTF8.GetBytes(($results|ConvertTo-Json -Compress)))
 [pscustomobject]@{verified=$true;root=$root;files=$results;executed=$false;nativeAttempted=$false}|ConvertTo-Json -Depth 5 -Compress
} finally {foreach($f in $held){$f.Dispose()}}
