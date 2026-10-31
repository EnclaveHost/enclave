# PREPARED ONLY. Read-only queries. Never dot-source configs or read environment/commands.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
function Bindings {
 $ls=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter '(LocalPort=8091 OR LocalPort=8095 OR LocalPort=8097 OR LocalPort=9600) AND State=2' -OperationTimeoutSec 3)
 if($ls.Count-gt 16){throw 'listener bound'}
 $rows=@(foreach($l in $ls){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[uint32]$l.OwningProcess) -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath -OperationTimeoutSec 3
  if(!$p){throw 'listener disappeared'};@{port=[int]$l.LocalPort;pid=[uint32]$p.ProcessId;parent=[uint32]$p.ParentProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');exe=$p.ExecutablePath}})
 ConvertTo-Json -InputObject @($rows|Sort-Object port,pid) -Depth 4 -Compress
}
function Physical {
 $os=Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory -OperationTimeoutSec 3
 $d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property FreeSpace,FileSystem -OperationTimeoutSec 3
 @{atUtc=[DateTime]::UtcNow.ToString('o');bootUtc=$os.LastBootUpTime.ToUniversalTime().ToString('o');physicalBytes=[int64]$os.TotalVisibleMemorySize*1024;freeBytes=[int64]$os.FreePhysicalMemory*1024;diskFreeBytes=[int64]$d.FreeSpace;filesystem=$d.FileSystem}
}
function NamespaceFact([string]$path){
 $i=Get-Item -LiteralPath $path -Force;$a=Get-Acl -LiteralPath $path
 $row=@{path=$path;directory=[bool]$i.PSIsContainer;attributes=[int]$i.Attributes;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;accessProtected=[bool]$a.AreAccessRulesProtected;sddl=$a.Sddl}
 $j=Get-Item -LiteralPath $path -Force
 if($i.LastWriteTimeUtc-ne $j.LastWriteTimeUtc -or $i.Attributes-ne $j.Attributes){throw 'namespace changed'}
 return $row
}
$before=Bindings;$physicalBefore=Physical
# Root must match these known retained incarnations before accepting template configuration observations.
$expected=@(@{port=8091;pid=38076;created='2026-10-26T17:17:18.5617520Z'},@{port=8095;pid=41308;created='2026-10-27T08:02:19.4407050Z'},@{port=8097;pid=40360;created='2026-10-27T08:24:42.8500370Z'})
foreach($e in $expected){$got=@(($before|ConvertFrom-Json)|Where-Object{$_.port-eq $e.port});if($got.Count-ne 1 -or $got[0].pid-ne $e.pid -or $got[0].created-cne $e.created){throw 'retained incarnation changed'}}
$js=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PUBLIC_READER_BASE64__'))
$output=($js|& 'C:\Program Files\Enclave\runtime\node\node.exe' --input-type=module -)
if($LASTEXITCODE-ne 0){throw 'public diagnostic failed'}
$public=$output|ConvertFrom-Json
$paths=New-Object 'System.Collections.Generic.HashSet[string]'
foreach($row in @($public.config)+@($public.master)){if($null-eq $row){continue};$cursor=$row.path;while($cursor){$null=$paths.Add($cursor);$parent=Split-Path $cursor -Parent;if($parent-eq $cursor){break};$cursor=$parent}}
if($paths.Count-gt 32){throw 'namespace bound'}
$namespace=@(foreach($p in ($paths|Sort-Object)){NamespaceFact $p})
$after=Bindings;if($before-cne $after){throw 'listener incarnation changed'}
$result=@{schema='template-config-diagnostic/1';readOnly=$true;physicalBefore=$physicalBefore;physicalAfter=(Physical);listeners=($before|ConvertFrom-Json);public=$public;namespace=$namespace;heldNamespaceProof=$false;priorOperationsSettled=$false;allOldIssuerInputsProven=$false;capacityAdmitted=$false}
$json=$result|ConvertTo-Json -Depth 12 -Compress
if([Text.Encoding]::UTF8.GetByteCount($json)-gt 65536){throw 'output bound'}
$json
