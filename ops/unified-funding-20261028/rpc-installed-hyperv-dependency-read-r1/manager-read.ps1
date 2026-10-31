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
$js=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('aW1wb3J0IGZzIGZyb20gJ25vZGU6ZnMnOwppbXBvcnQge2NyZWF0ZUhhc2h9IGZyb20gJ25vZGU6Y3J5cHRvJzsKY29uc3Qgc2hhPWI9PmNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShiKS5kaWdlc3QoJ2hleCcpOwpjb25zdCBpbnB1dHM9W1snaHlwZXJ2LnBzbTEnLCcxN2NhNDM1MmM1MDBkMzQ5OGY3MWJlNDIwZGRmYTQxOGM3ZWQxZDFiNWY0NTU4NTZjMjRlNjMzYTQ2MzVlNDljJ10sWyd1dGlsaXRpZXMucHNtMScsJzUxNzc2NmU5OTZkZGIwMjE1OTRjMGFlMmM3YTYwNjg4ZDQyOTNlMmVlOTQ1OWY1NThmMmE0MzZlNmRhMzA3MzEnXV07CmNvbnN0IG91dD17c2NoZW1hOidpbnN0YWxsZWQtaHlwZXJ2LWRlcGVuZGVuY2llcy8xJyxyZWFkT25seTp0cnVlLGltcG9ydHNQZXJmb3JtZWQ6ZmFsc2UsZmlsZXM6W119Owpjb25zdCBpZD1zPT5bcy5kZXYscy5pbm8scy5zaXplLHMubmxpbmsscy5tdGltZU5zLHMuY3RpbWVOc10ubWFwKFN0cmluZykuam9pbignOicpOwpmb3IoY29uc3QgW25hbWUscGluXSBvZiBpbnB1dHMpewogY29uc3QgcGF0aD1TdHJpbmcucmF3YEM6XFByb2dyYW0gRmlsZXNcRW5jbGF2ZVxndWVzdGArJ1xcJytuYW1lOwogY29uc3QgbmFtZWQ9ZnMubHN0YXRTeW5jKHBhdGgse2JpZ2ludDp0cnVlfSk7aWYoIW5hbWVkLmlzRmlsZSgpfHxuYW1lZC5pc1N5bWJvbGljTGluaygpfHxuYW1lZC5zaXplPDFufHxuYW1lZC5zaXplPjY1NTM2bnx8bmFtZWQubmxpbmshPT0xbil0aHJvdyBFcnJvcignZmlsZS1ib3VuZCcpOwogY29uc3QgZmQ9ZnMub3BlblN5bmMocGF0aCwncicpO3RyeXsKICBjb25zdCBmaXJzdD1mcy5mc3RhdFN5bmMoZmQse2JpZ2ludDp0cnVlfSk7aWYoaWQoZmlyc3QpIT09aWQobmFtZWQpKXRocm93IEVycm9yKCdpZGVudGl0eScpOwogIGNvbnN0IGI9QnVmZmVyLmFsbG9jKE51bWJlcihmaXJzdC5zaXplKSsxKTtsZXQgbj0wO3doaWxlKG48Yi5sZW5ndGgpe2NvbnN0IGdvdD1mcy5yZWFkU3luYyhmZCxiLG4sYi5sZW5ndGgtbixuKTtpZighZ290KWJyZWFrO24rPWdvdDt9CiAgY29uc3QgZW5kPWZzLmZzdGF0U3luYyhmZCx7YmlnaW50OnRydWV9KTtpZihuIT09TnVtYmVyKGZpcnN0LnNpemUpfHxpZChmaXJzdCkhPT1pZChlbmQpfHxpZChlbmQpIT09aWQoZnMuc3RhdFN5bmMocGF0aCx7YmlnaW50OnRydWV9KSkpdGhyb3cgRXJyb3IoJ2NoYW5nZWQnKTsKICBjb25zdCBieXRlcz1iLnN1YmFycmF5KDAsbiksb2JzZXJ2ZWQ9c2hhKGJ5dGVzKTtpZihvYnNlcnZlZCE9PXBpbil0aHJvdyBFcnJvcignaW5zdGFsbGVkLXBpbi1taXNtYXRjaCcpOwogIG91dC5maWxlcy5wdXNoKHtuYW1lLHBhdGgsc2hhMjU2Om9ic2VydmVkLGJ5dGVzOm4saWRlbnRpdHk6aWQoZW5kKSxiYXNlNjQ6Ynl0ZXMudG9TdHJpbmcoJ2Jhc2U2NCcpfSk7CiB9ZmluYWxseXtmcy5jbG9zZVN5bmMoZmQpO30KfQpjb25zdCB0ZXh0PUpTT04uc3RyaW5naWZ5KG91dCk7aWYoQnVmZmVyLmJ5dGVMZW5ndGgodGV4dCk+MjAwMDAwKXRocm93IEVycm9yKCdvdXRwdXQtYm91bmQnKTtwcm9jZXNzLnN0ZG91dC53cml0ZSh0ZXh0KydcbicpOwo='))
$output=($js|& 'C:\Program Files\Enclave\runtime\node\node.exe' --input-type=module -)
if($LASTEXITCODE-ne 0){throw 'public diagnostic failed'}
$public=$output|ConvertFrom-Json
$after=Bindings;if($before-cne $after){throw 'listener incarnation changed'}
@{schema='installed-hyperv-dependencies-read/1';readOnly=$true;listeners=($before|ConvertFrom-Json);physical=$physicalBefore;public=$public;capacityAdmitted=$false;priorOperationsSettled=$false}|ConvertTo-Json -Depth 8 -Compress
