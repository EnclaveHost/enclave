$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
 [Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity=[IntPtr]2
 $source='C:\ProgramData\Enclave\shield\type1.vmgs';$root='C:\EnclaveRpcMaster-ea4f1ce8a12f4a86b034ccc4ccd9e920';$target=$root+'\type1.vmgs'
 $expected='e93237a717a7e0e9fa201db2b331d2ed480274bfa47145854ea3ba85852abb96'
 $os=Get-CimInstance Win32_OperatingSystem;$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
 $free=[int64]$os.FreePhysicalMemory*1024
 if($free -lt 62709039104 -or [int64]$disk.FreeSpace -lt (16GB+256MB+4194816)){throw 'Preparation headroom refused'}
 $f=Get-Item -LiteralPath $source
 if($f.Length -ne 4194816 -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Exact original master differs'}
 if(Test-Path -LiteralPath $root){throw 'Consumed preparation namespace'}
 $admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($admin);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 [IO.Directory]::CreateDirectory($root,$acl)|Out-Null
 $inputFile=New-Object IO.FileStream($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try {
  if($inputFile.Length -ne 4194816){throw 'Held source size differs'}
  $sha=[Security.Cryptography.SHA256]::Create();$digest=([BitConverter]::ToString($sha.ComputeHash($inputFile))).Replace('-','').ToLowerInvariant()
  if($digest -ne $expected){throw 'Original source hash differs'}
  $inputFile.Position=0
  $outputFile=New-Object IO.FileStream($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None,65536,[IO.FileOptions]::WriteThrough)
  try {$inputFile.CopyTo($outputFile,65536);$outputFile.Flush($true);$outputFile.Position=0;$actual=([BitConverter]::ToString($sha.ComputeHash($outputFile))).Replace('-','').ToLowerInvariant();if($actual -ne $expected -or $outputFile.Length -ne 4194816){throw 'New master verification failed'}}finally{$outputFile.Dispose()}
  $inputFile.Position=0;$after=([BitConverter]::ToString($sha.ComputeHash($inputFile))).Replace('-','').ToLowerInvariant();if($after -ne $expected){throw 'Source changed'};$sha.Dispose()
 }finally{$inputFile.Dispose()}
 $result=[ordered]@{success=$true;preparedAt=[DateTime]::UtcNow.ToString('o');boot=$os.LastBootUpTime.ToUniversalTime().ToString('o');source=$source;target=$target;bytes=4194816;sha256=$actual;sourceUnchanged=$true;sourceAclChanged=$false;oldMasterBarrierActivated=$false;newCreatorActivated=$false;poolSeeded=$false;nativeVmAttempted=$false;freeMemoryBytes=$free;diskFreeBytes=[int64]$disk.FreeSpace}
 $json=$result|ConvertTo-Json -Compress;[IO.File]::WriteAllText(($root+'\preparation.json'),$json);$json
}catch{[ordered]@{success=$false;error=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber;oldMasterBarrierActivated=$false;nativeVmAttempted=$false}|ConvertTo-Json -Compress}
