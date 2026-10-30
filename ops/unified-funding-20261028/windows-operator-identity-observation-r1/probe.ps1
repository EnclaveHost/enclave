# PREPARED ONLY. Read-only exact task/process/launcher identity; no state, service or task mutation.
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$result=[ordered]@{schema='enclave-operator-identity-observation/1';readOnly=$true;observedAt=[DateTime]::UtcNow.ToString('o');tasks=@();services=@();config=@();listener=$null;effectiveNodeDir='unknown';qualification=$false}
function SafePath([string]$x) {
 if ($x.Length -le 260 -and $x -match '^[A-Za-z]:\\[A-Za-z0-9 _().\\-]+$') {return $x}
 if ($x -match '^(cmd|node|powershell)\.exe$') {return $x}
 return '[unrecognized path withheld]'
}
function BoundedText([string]$file) {
 $item=Get-Item -LiteralPath $file -Force
 if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 65536) {throw 'file refused'}
 $f=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try {
  if ($f.Length -gt 65536) {throw 'size refused'}
  $b=New-Object byte[] 65537; $n=0
  while($n -lt $b.Length) {$r=$f.Read($b,$n,$b.Length-$n);if($r -eq 0){break};$n+=$r}
  if($n -gt 65536 -or $f.Length -ne $n){throw 'changed file refused'}
  $h=[Security.Cryptography.SHA256]::Create()
  try {$digest=([BitConverter]::ToString($h.ComputeHash($b,0,$n))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
  return @{text=[Text.Encoding]::UTF8.GetString($b,0,$n);bytes=$n;sha256=$digest}
 }finally{$f.Dispose()}
}
try {
 # Exact task names from both existing install paths. Embedded CIM actions are inspected but never invoked.
 foreach($spec in @(@{path='\Enclave\';name='Node'},@{path='\';name='EnclaveWindowsNode'})) {
  $filter="TaskPath='$($spec.path.Replace('\','\\'))' AND TaskName='$($spec.name)'"
  $tasks=@(Get-CimInstance -Namespace 'root/Microsoft/Windows/TaskScheduler' -ClassName MSFT_ScheduledTask -Filter $filter -OperationTimeoutSec 4)
  if($tasks.Count -gt 1){throw 'ambiguous task'}
  if($tasks.Count -eq 0){$result.tasks+=@{path=$spec.path;name=$spec.name;found=$false};continue}
  $t=$tasks[0];$actions=@()
  foreach($a in @($t.Actions)) {
   if($actions.Count -ge 4){throw 'action count refused'}
   $arg=[string]$a.Arguments
   # Never emit raw arguments: only identify the reviewed public launcher path and whether shape is exact.
   $known=$arg -match '(?i)^\s*/[ck]\s+"?"?C:\\ProgramData\\Enclave\\run-node\.cmd"?"?\s*$'
   $actions+=@{execute=(SafePath ([string]$a.Execute));workingDirectory=(SafePath ([string]$a.WorkingDirectory));knownRunNodeAction=$known;argumentsWithheld=$true}
  }
  $result.tasks+=@{path=$spec.path;name=$spec.name;found=$true;state=[string]$t.State;enabled=[bool]$t.Settings.Enabled;
    principal=@{userId=[string]$t.Principal.UserId;groupId=[string]$t.Principal.GroupId;logonType=[string]$t.Principal.LogonType;runLevel=[string]$t.Principal.RunLevel};actions=$actions}
 }
 foreach($file in @('C:\ProgramData\Enclave\run-node.cmd','C:\ProgramData\Enclave\node-config.cmd','C:\ProgramData\Enclave\node-config.local.cmd')) {
  try {
   $v=BoundedText $file;$values=@();$calls=@()
   foreach($line in $v.text.Split("`n")) {
    $m=[regex]::Match($line.Trim(),'(?i)^@?set\s+"?NODE_DIR=(?<v>[^"\r\n]+)"?\s*$')
    if($m.Success){$values+=@{literalPath=(SafePath $m.Groups['v'].Value);containsExpansion=($m.Groups['v'].Value -match '[%!\^]')}}
    if($line -match '(?i)\bcall\s+"?C:\\ProgramData\\Enclave\\node-config(?:\.local)?\.cmd"?\s*$'){$calls+=@{knownNodeConfigCall=$true;local=($line -match '(?i)node-config\.local\.cmd')}}
   }
   $result.config+=@{path=$file;bytes=$v.bytes;sha256=$v.sha256;nodeDirAssignments=$values;knownCalls=$calls;rawContentsWithheld=$true}
  }catch{$result.config+=@{path=$file;read='absent-or-refused';rawContentsWithheld=$true}}
 }
 # Port9600 was selected from the earlier exact sanitized host observation. No HTTP/app actions.
 $listeners=@(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter 'LocalPort=9600 AND State=2' -OperationTimeoutSec 4 | Select-Object -ExpandProperty OwningProcess -Unique)
 if($listeners.Count -ne 1){throw 'single agent listener not established'}
 $pidValue=[uint32]$listeners[0]
 $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue) -OperationTimeoutSec 4
 if(-not $proc){throw 'listener exited'}
 $owner=Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid -OperationTimeoutSec 4
 if($owner.ReturnValue -ne 0){throw 'owner not observed'}
 $knownAgent=([string]$proc.CommandLine -match '(?i)(?:^|\s|\")C:\\Program Files\\Enclave\\control\\windows\\node\\agent\.mjs(?:\"|\s|$)')
 $result.listener=@{port=9600;pid=$pidValue;created=$proc.CreationDate.ToUniversalTime().ToString('o');executable=(SafePath ([string]$proc.ExecutablePath));ownerSid=[string]$owner.Sid;knownAgentEntry=$knownAgent;commandLineWithheld=$true}
 # Only services actually owning that PID, plus the two exact plausible agent-service names. No all-service dump.
 $svcs=@(Get-CimInstance Win32_Service -Filter ('ProcessId='+$pidValue+" OR Name='EnclaveNode' OR Name='EnclaveWindowsNode'") -OperationTimeoutSec 4)
 if($svcs.Count -gt 4){throw 'service count refused'}
 foreach($s in $svcs){$result.services+=@{name=[string]$s.Name;startName=[string]$s.StartName;state=[string]$s.State;startMode=[string]$s.StartMode;pid=[uint32]$s.ProcessId;ownsListener=([uint32]$s.ProcessId -eq $pidValue);pathNameWithheld=$true}}
 $after=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue) -OperationTimeoutSec 4
 if(-not $after -or $after.CreationDate -ne $proc.CreationDate -or $after.ExecutablePath -cne $proc.ExecutablePath -or $after.CommandLine -cne $proc.CommandLine){throw 'listener identity changed'}
 $result.stableProcess=$true
 $result.limitations=@('Effective NODE_DIR remains unknown unless observed literal assignments and launcher ordering establish it; inherited environment is not dumped.','Task configuration and matching process owner do not alone prove task-to-process ancestry.','No exclusion, ACL, EXLOCK, process death, memory admission or Windows runtime qualification is established.')
 $out=$result|ConvertTo-Json -Depth 8 -Compress
 if([Text.Encoding]::UTF8.GetByteCount($out) -gt 24576){throw 'output bound'}
 [Console]::Out.WriteLine($out)
} catch {
 [Console]::Out.WriteLine('{"schema":"enclave-operator-identity-observation/1","readOnly":true,"known":false,"qualification":false,"reason":"bounded identity observation refused; raw output withheld"}')
 exit 1
}
