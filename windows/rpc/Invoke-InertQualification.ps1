# Explicit operator-only inert target qualification. No VM/provider/storage export.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$EntryPath,
 [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$EntrySha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{32}$')][string]$AttemptNonce,
 [string]$ObservationPath,
 [string]$ObservationSha256,
 [switch]$HostedCi
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
# Original clock begins before image verification/bootstrap. No reset on task launch.
$origin=[long][decimal]::Floor(([decimal][Diagnostics.Stopwatch]::GetTimestamp()*1000)/[Diagnostics.Stopwatch]::Frequency)
$deadline=$origin+30000
$held=New-Object Collections.Generic.List[object]
$tasks=New-Object Collections.Generic.List[string]
$taskBindings=@{}
$processes=New-Object Collections.Generic.List[object]
$failures=New-Object Collections.Generic.List[string]
$systemSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$adminSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$root=$null;$passed=$false;$guard=$null;$namespacePin=$null
function Hash([byte[]]$bytes){$sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function HoldBytes([string]$path,[int]$maximum){
 if(-not [IO.Path]::IsPathRooted($path) -or $path.StartsWith('\\') -or $path.IndexOfAny([char[]]'"') -ge 0){throw 'Local absolute path required'}
 $stream=New-Object IO.FileStream($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $held.Add($stream)
 if($stream.Length -lt 1 -or $stream.Length -gt $maximum){throw 'Input size refused'}
 $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
 while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'Short input'};$offset+=$n}
 return ,$bytes
}
function NewProtectedDirectory([string]$path){
 if([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)){throw 'Attempt path already consumed'}
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner($adminSid);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($systemSid,$adminSid)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 [void][IO.Directory]::CreateDirectory($path,$acl)
}
function Publish([string]$path,[byte[]]$bytes){
 $acl=New-Object Security.AccessControl.FileSecurity
 $acl.SetOwner($adminSid);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($systemSid,$adminSid)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))}
 $stream=New-Object IO.FileStream(($path+'.pending'),[IO.FileMode]::CreateNew,([Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::ReadPermissions),[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,$acl)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 [IO.File]::Move(($path+'.pending'),$path)
}
function AwaitIdentity([string]$path,[string]$role,[string]$token){
 while(-not [IO.File]::Exists($path)){if([Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds() -ge $deadline){throw 'Original deadline'};Start-Sleep -Milliseconds 5}
 $text=[Text.Encoding]::UTF8.GetString((HoldBytes $path 4096));$parts=$text.Split(',')
 if($parts.Length -ne 4 -or $parts[2] -cne $token -or $parts[3] -cne $role){throw 'Role binding differs'}
 $p=[Diagnostics.Process]::GetProcessById([int]$parts[0]);$processes.Add($p);$handle=$p.Handle
 if($p.HasExited -or $p.StartTime.ToUniversalTime().ToFileTimeUtc() -ne [long]$parts[1]){throw 'Exact process incarnation unavailable'}
 return $p
}
try{
 $entryBytes=HoldBytes $EntryPath 262144
 if((Hash $entryBytes) -cne $EntrySha256){throw 'Entry digest mismatch'}
 # Load only the exact reviewed hosted artifact, never compile on the target.
 [void][Reflection.Assembly]::Load($entryBytes)
 $receipt=[Enclave.OwnedRpc.BoundedWorker]::EnterSupervisorEnvelope(128MB)
 # This observer object is used solely as the controller's independent deadline.
 # It never receives an owner handle. Actual owner/observer are separate SYSTEM tasks.
 $guard=[Enclave.OwnedRpc.BoundedWorker]::ArmOwnerObserver($origin,$deadline,($AttemptNonce+$AttemptNonce+$AttemptNonce+$AttemptNonce))
 if(-not $receipt.MembershipVerified -or -not $receipt.LimitsVerified){throw 'Controller envelope not established'}
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 $principal=New-Object Security.Principal.WindowsPrincipal($identity)
 if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator controller required'}
 $os=Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory -OperationTimeoutSec 3
 $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property FreeSpace -OperationTimeoutSec 3
 $free=[long]$os.FreePhysicalMemory*1024
 # Actual target: retain 39388MiB possible app growth, 18GiB host floor, 1GiB
 # variation, 512MiB owner/observer/bootstrap, 192MiB controller/bootstrap,
 # and256MiB remote registration/transport allowance. Allowances are not caps.
 $required=[long](18GB+39388MB+1GB+512MB+192MB+256MB)
 if($HostedCi){
  if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'Hosted fixture mode requires disposable CI'}
  if($free -lt 3GB){throw 'CI headroom refused'}
 }else{
  if($ObservationSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'Reviewed observation digest required'}
  $raw=HoldBytes $ObservationPath 262144
  if((Hash $raw) -cne $ObservationSha256){throw 'Observation digest differs'}
  $obs=[Text.Encoding]::UTF8.GetString($raw)|ConvertFrom-Json
  if($obs.rc -ne 0 -or $obs.failure -ne $null -or -not $obs.readOnly -or $obs.observation.nodeExit -ne 0 -or -not $obs.observation.manager.completeTransport -or @($obs.observation.manager.errors).Count -ne 0){throw 'Incomplete resource observation'}
  $before=$obs.observation.physicalBefore;$after=$obs.observation.physicalAfter
  $age=([DateTime]::UtcNow-[DateTime]::Parse($before.atUtc).ToUniversalTime()).TotalSeconds
  if($age -lt 0 -or $age -gt 300 -or $before.boot -cne $after.boot -or $after.boot -cne $os.LastBootUpTime.ToUniversalTime().ToString('o')){throw 'Stale or different-boot observation'}
  if($before.physicalBytes -ne [long]$os.TotalVisibleMemorySize*1024 -or $after.physicalBytes -ne $before.physicalBytes){throw 'Physical host binding differs'}
  if(($obs.observation.before|ConvertTo-Json -Depth 10 -Compress) -cne ($obs.observation.after|ConvertTo-Json -Depth 10 -Compress)){throw 'Manager incarnation changed'}
  # Compare recorded listener identities with the current host, not only with
  # another row inside the old snapshot. No service command line/env is read.
  $recorded=@($obs.observation.after.value)
  if($recorded.Count -ne 4 -or @($recorded|Select-Object -ExpandProperty port -Unique).Count -ne 4){throw 'Exact four listener bindings required'}
  $liveListeners=@(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter '(LocalPort=8091 OR LocalPort=8095 OR LocalPort=8097 OR LocalPort=9600) AND State=2' -OperationTimeoutSec 3)
  if($liveListeners.Count -ne $recorded.Count){throw 'Current listener count differs'}
  $filter=(@($recorded|ForEach-Object{'ProcessId='+[uint32]$_.pid}) -join ' OR ')
  $liveProcesses=@(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,CreationDate,ExecutablePath -OperationTimeoutSec 3)
  foreach($r in $recorded){
   $ls=@($liveListeners|Where-Object{[int]$_.LocalPort -eq [int]$r.port -and [uint32]$_.OwningProcess -eq [uint32]$r.pid})
   $ps=@($liveProcesses|Where-Object{[uint32]$_.ProcessId -eq [uint32]$r.pid})
   if($ls.Count -ne 1 -or $ps.Count -ne 1 -or $ps[0].CreationDate.ToUniversalTime().ToString('o') -cne $r.created -or $ps[0].ExecutablePath -cne $r.exe){throw 'Current manager incarnation differs'}
  }

  if([Math]::Min([long]$before.freeBytes,[long]$after.freeBytes) -lt $required -or $free -lt $required -or [long]$disk.FreeSpace -lt (16GB+16MB)){throw 'Target qualification headroom refused'}
 }
 $boot=[Enclave.OwnedRpc.ProtectedAttempt]::CurrentBoot()
 $parent=[IO.Path]::Combine([IO.Path]::GetPathRoot($env:SystemRoot),('EnclaveRpcQualification-'+$AttemptNonce))
 NewProtectedDirectory $parent
 $root=[IO.Path]::Combine($parent,$AttemptNonce);NewProtectedDirectory $root
 Publish ([IO.Path]::Combine($root,'controller.consumed')) ([Text.Encoding]::UTF8.GetBytes($AttemptNonce))
 $entry=[IO.Path]::Combine($root,'entry.exe');Publish $entry $entryBytes
 $contract=[IO.Path]::Combine($root,'contract.txt')
 $content="owned-rpc-inert-v1`n$AttemptNonce`n$boot`n$origin`n$deadline`n$EntrySha256`ninert-v1`n"
 $bytes=[Text.Encoding]::UTF8.GetBytes($content);$hash=Hash $bytes;Publish $contract $bytes
 # Hold and validate all ancestors, contract and entry image BEFORE registering
 # any executable SYSTEM action. Later child validation is not the launch fence.
 $namespacePin=[Enclave.OwnedRpc.ProtectedAttempt]::PinController($contract,$hash)
 $token=$AttemptNonce+$boot+$hash
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
 foreach($role in @('owner','observer')){
  if([Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds() -ge [Math]::Min($deadline,$origin+5000)){throw 'Original bootstrap cutoff'}
  $name='EnclaveRpcQualification-'+$AttemptNonce+'-'+$role;$tasks.Add($name)
  $task=$scheduler.NewTask(0);$task.RegistrationInfo.Description='One-shot inert RPC process qualification; no VM/provider operations'
  $task.Principal.UserId='SYSTEM';$task.Principal.LogonType=5;$task.Principal.RunLevel=1
  $task.Settings.Enabled=$true;$task.Settings.AllowDemandStart=$true;$task.Settings.StartWhenAvailable=$false
  $task.Settings.ExecutionTimeLimit='PT30S';$task.Settings.MultipleInstances=2
  $task.Settings.DisallowStartIfOnBatteries=$false;$task.Settings.StopIfGoingOnBatteries=$false
  $action=$task.Actions.Create(0);$action.Path=$entry;$action.WorkingDirectory=$root
  $action.Arguments=$role+' "'+$contract+'" '+$hash+' '+$origin+' '+$deadline
  $taskBindings[$name]=$action.Arguments
  $registered=$folder.RegisterTaskDefinition($name,$task,2,'SYSTEM',$null,5,$null)
  [void]$registered.Run($null)
 }
 $owner=AwaitIdentity ([IO.Path]::Combine($root,'owner.consumed')) 'owner' $token
 $observer=AwaitIdentity ([IO.Path]::Combine($root,'observer.consumed')) 'observer' $token
 Publish ([IO.Path]::Combine($root,'admit')) ([Text.Encoding]::UTF8.GetBytes($token))
 foreach($p in @($owner,$observer)){
  $remaining=[Math]::Max(0,$deadline-[Enclave.OwnedRpc.BoundedWorker]::MonotonicMilliseconds())
  if(-not $p.WaitForExit([int]$remaining) -or $p.ExitCode -ne 0){throw 'Exact role completion failed'}
 }
 $o=[Text.Encoding]::UTF8.GetString((HoldBytes ([IO.Path]::Combine($root,'owner.result')) 4096))
 $g=[Text.Encoding]::UTF8.GetString((HoldBytes ([IO.Path]::Combine($root,'observer.result')) 4096))
 if($o -cne 'inert-complete;provider-fenced=false;reservation-release=false' -or $g -cne 'exact-owner-death;job-empty;provider-fenced=false;reservation-release=false'){throw 'Role receipts incomplete'}
 $passed=$true
}catch{$failures.Add($_.Exception.GetType().Name+': '+$_.Exception.Message)}
finally{
 foreach($name in $tasks){
  $associated=$false
  try{
   $t=$folder.GetTask($name);$definition=$t.Definition
   if($definition.Actions.Count -ne 1 -or $definition.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or $definition.Principal.LogonType -ne 5){throw 'Task owner/action count differs'}
   $a=$definition.Actions.Item(1)
   if($a.Path -cne $entry -or $a.WorkingDirectory -cne $root -or $a.Arguments -cne $taskBindings[$name]){throw 'Task operation association differs'}
   $associated=$true
  }catch{$failures.Add('Exact task association unconfirmed: '+$name)}
  if($associated){
   try{$t.Enabled=$false}catch{$failures.Add('Task disable unconfirmed: '+$name)}
   try{$t.Stop(0)}catch{$failures.Add('Task stop unconfirmed: '+$name)}
   try{$folder.DeleteTask($name,0)}catch{$failures.Add('Task removal unconfirmed: '+$name)}
  }
 }
 # Task operations are not death evidence. Only retained role process handles count.
 foreach($p in $processes){
  try{if(-not $p.HasExited){$passed=$false;$failures.Add('Exact role still alive')}}catch{$passed=$false;$failures.Add('Exact role death observation failed')}
  try{$p.Dispose()}catch{$failures.Add('Process handle close failed')}
 }
 if($namespacePin -ne $null){try{$namespacePin.Dispose()}catch{$failures.Add('Namespace handle close failed')}}
 foreach($f in $held){try{$f.Dispose()}catch{$failures.Add('Input handle close failed')}}
}
$result=[pscustomobject]@{schema='owned-rpc-target-inert/1';passed=($passed -and $failures.Count -eq 0);hostedCi=[bool]$HostedCi;attempt=$AttemptNonce;origin=$origin;deadline=$deadline;elapsedMs=([long][decimal]::Floor(([decimal][Diagnostics.Stopwatch]::GetTimestamp()*1000)/[Diagnostics.Stopwatch]::Frequency)-$origin);root=$root;freeBytes=$free;requiredFreeBytes=$required;failures=@($failures);providerFenced=$false;reservationMayRelease=$false;vmsChanged=$false}
$result|ConvertTo-Json -Depth 5 -Compress
if(-not $result.passed){exit 1}
