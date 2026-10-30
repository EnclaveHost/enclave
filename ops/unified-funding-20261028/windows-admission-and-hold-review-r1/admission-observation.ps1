# PREPARED READ-ONLY OBSERVATION, NOT RUN. Output contains only bounded aggregate metrics.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
function Read-LocalJson([int]$port,[string]$route){
 $req=[Net.HttpWebRequest]::Create("http://127.0.0.1:${port}${route}");$req.Timeout=4000;$req.ReadWriteTimeout=4000;$req.AllowAutoRedirect=$false
 $res=$req.GetResponse();$stream=$res.GetResponseStream();$mem=New-Object IO.MemoryStream;$buf=New-Object byte[] 8192
 try{while(($n=$stream.Read($buf,0,$buf.Length)) -gt 0){if($mem.Length+$n -gt 2097152){throw 'bounded response exceeded'};$mem.Write($buf,0,$n)};return ([Text.Encoding]::UTF8.GetString($mem.ToArray())|ConvertFrom-Json)}finally{$stream.Dispose();$res.Dispose();$mem.Dispose()}
}
$rows=@();$unknown=@('future launches not yet in manager inventory','router pending launch not yet represented in backend inventory','non-Enclave host memory commitments','concurrent admissions after this observation')
foreach($port in @(8091,8095)){
 try{
  $a=Read-LocalJson $port '/health';$v=Read-LocalJson $port '/vms';$b=Read-LocalJson $port '/health'
  if($a.managerEpoch -ne $b.managerEpoch -or $a.managerEpoch -ne $v.managerEpoch -or $a.inventory.state -ne 'ready' -or $b.inventory.state -ne 'ready'){throw 'inventory/epoch unstable'}
  $starting=0;$reserved=[long]0;$unattributed=0
  foreach($r in @($v.vms)){
   if($r.recovered -or $r.unattributed){$unattributed++}
   if($r.status -eq 'starting'){
    $starting++;$n=0L
    if(-not [long]::TryParse([string]$r.physicalMemoryMiB,[ref]$n) -or $n -lt 0 -or $n -gt 1048576){throw 'unknown starting reservation'}
    $reserved+=$n
   }
  }
  $rows+=@{port=$port;epochStable=$true;startingCount=$starting;startingReservedMiB=$reserved;unattributedCount=$unattributed;physicalPoolMiB=$b.physicalMemory.poolMiB;allocatedMiB=$b.physicalMemory.allocatedMiB}
 }catch{$rows+=@{port=$port;unknown=$true};$unknown+=('manager '+$port+' observation failed')}
}
@{schema='enclave-exlock-admission-observation/1';checkedAt=[DateTime]::UtcNow.ToString('o');availableMiB=[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024);managers=$rows;unknownCommitments=$unknown;admissible=$false;note='Metrics only. Unknown commitments are not zero. Coordinator must supply bounded, justified commitments for every unknown category and prevent overlapping admission; otherwise do not run.'}|ConvertTo-Json -Depth 6 -Compress
