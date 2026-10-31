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
$parent='C:\EnclaveRpcHandoffInputs-fd2196083e5a4b0d92b1065f7a14957e';$root=Join-Path $parent 'fd2196083e5a4b0d92b1065f7a14957e'
VerifyDirectory 'C:\' $false
VerifyDirectory $parent $true;VerifyDirectory $root $true
$controller=Join-Path $root 'entry.exe';$entry=Join-Path $root 'owned-entry.exe';$obs=Join-Path $root 'observation.json';$manifest=Join-Path $root 'handoff.json';$manifestSha='032257047b619407ea36686fe5f827f504221663b7b10ba7f6700ce2e572e823'
$controllerSha='28ffe56cf25737589b5602c73f050a6461f21cfd97a3419ddfd13444b4b157a3';$entrySha='b2cf9f95a9be44f8c18aeb1ff5194cea047f6c1fd1ef3d673af1270ae44d2bed';$observationSha='3bba434efc86f9443a1be7da688b5eb1fc6d40dd74a72fe872aa99acf035e2b4'
$inputNonce='fd2196083e5a4b0d92b1065f7a14957e';$attemptNonce='cb1e1dba92114f118298c87f21521146'

$cleanupCutoff=$null;$clock=$null
$held=New-Object Collections.Generic.List[object];$pin=$null;$proc=$null;$started=$false;$death=$false;$code=$null;$failure=$null;$result=$null
try{
 $data=@{}
 foreach($pair in @(@($controller,$controllerSha),@($entry,$entrySha),@($obs,$observationSha),@($manifest,$manifestSha))){
  SecureFileAcl $pair[0]
  $f=New-Object IO.FileStream($pair[0],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$held.Add($f)
  if($f.Length -lt 1 -or $f.Length -gt 262144){throw 'Input size bound'}
  $bytes=New-Object byte[] ([int]$f.Length);$offset=0
  while($offset -lt $bytes.Length){$n=$f.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'Short input'};$offset+=$n}
  $sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  if($hash -cne $pair[1]){throw 'Pinned input digest differs'};$data[$pair[0]]=$bytes
 }
 # Only validate the pinned assembly in this transport process; do not invoke its Main here.
 [void][Reflection.Assembly]::Load($data[$controller])
 $boot=[Enclave.OwnedRpc.ProtectedAttempt]::CurrentBoot();$origin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds();$deadline=$origin+30000
 $text="owned-rpc-inert-v1`n$inputNonce`n$boot`n$origin`n$deadline`n$controllerSha`ninert-v1`n"
 $bytes=[Text.Encoding]::UTF8.GetBytes($text);$contract=Join-Path $root 'contract.txt';WriteNew $contract $bytes
 $hash=[Enclave.OwnedRpc.ProtectedAttempt]::Hash($bytes)
 # Hold protected ancestors + exact controller image before CreateProcess.
 $pin=[Enclave.OwnedRpc.ProtectedAttempt]::PinController($contract,$hash)
 WriteNew (Join-Path $root 'execution.intent') ([Text.Encoding]::UTF8.GetBytes($attemptNonce))
 $out=Join-Path $root 'controller.out';$err=Join-Path $root 'controller.err'
 $launchOrigin=[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds()
 if($launchOrigin -lt 679927712 -or $launchOrigin -gt 680047712){throw 'Sealed transport launch window expired'}
 $launchDeadline=$launchOrigin+30000
 $arguments='--target "'+$entry+'" '+$entrySha+' '+$attemptNonce+' legacy-memory-inspect-v1 "'+$obs+'" '+$observationSha+' "'+$manifest+'" '+$manifestSha+' '+$launchOrigin+' '+$launchDeadline
 $clock=[Diagnostics.Stopwatch]::StartNew()
 $proc=Start-Process -FilePath $controller -ArgumentList $arguments -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
 $handle=$proc.Handle;$started=$true
 $identity=[pscustomobject]@{pid=$proc.Id;creationFileTime=$proc.StartTime.ToUniversalTime().ToFileTimeUtc();sha256=$controllerSha;attempt=$attemptNonce}
 WriteNew (Join-Path $root 'controller.identity.json') ([Text.Encoding]::UTF8.GetBytes(($identity|ConvertTo-Json -Compress)))
 while(-not $proc.WaitForExit(25)){
  $size=0L;foreach($path in @($out,$err)){if([IO.File]::Exists($path)){$size+=(Get-Item -LiteralPath $path).Length}}
  if($size -gt 65536 -or $clock.ElapsedMilliseconds -gt 35000){$failure='transport observer bound';break}
 }
 $cleanupCutoff=[Math]::Min(38000L,$clock.ElapsedMilliseconds+3000L)
 if(-not $proc.HasExited){$proc.Kill()}
 $death=$proc.WaitForExit([int][Math]::Max(0L,$cleanupCutoff-$clock.ElapsedMilliseconds))
 if(-not $death){throw 'Exact controller death unconfirmed'};$code=$proc.ExitCode
 $size=0L;foreach($path in @($out,$err)){$size+=(Get-Item -LiteralPath $path).Length}
 if($size -gt 65536){throw 'Final aggregate output bound'}
 if($clock.ElapsedMilliseconds -gt 35000){throw 'Final transport elapsed bound'}
 $stdout=[IO.File]::ReadAllText($out)
 try{$result=$stdout|ConvertFrom-Json}catch{$failure='invalid bounded controller output'}
 if($code -ne 0 -or -not $result.passed -or $result.operation -cne 'legacy-memory-inspect-v1' -or $result.providerFenced -or $result.reservationMayRelease -or $result.vmsChanged){$failure='target read-only handoff not passed'}
}catch{$failure=$_.Exception.GetType().Name+': '+$_.Exception.Message}
finally{
 if($proc -ne $null){
  try{
   if($cleanupCutoff -eq $null){$cleanupCutoff=[Math]::Min(38000L,$clock.ElapsedMilliseconds+3000L)}
   if(-not $proc.HasExited){$proc.Kill()}
   $death=$proc.WaitForExit([int][Math]::Max(0L,$cleanupCutoff-$clock.ElapsedMilliseconds))
   if(-not $death){$failure='exact controller cleanup unconfirmed'}
  }catch{$failure='exact controller cleanup unconfirmed'}
  try{$proc.Dispose()}catch{$failure='controller handle close failed'}
 }
 if($pin -ne $null){try{$pin.Dispose()}catch{$failure='namespace close failed'}}
 foreach($f in $held){try{$f.Dispose()}catch{$failure='input close failed'}}
}
[pscustomobject]@{started=$started;exactControllerDeath=$death;exitCode=$code;failure=$failure;result=$result;reservationMayRelease=$false;vmsChanged=$false}|ConvertTo-Json -Depth 8 -Compress
if($failure){exit 1}
