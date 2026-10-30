$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
function HashPublic([string]$path){
 $i=Get-Item -LiteralPath $path -Force
 if($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $i.Length -gt 1048576){throw 'public source bound'}
 $h=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
 @{path=$path;bytes=$i.Length;sha256=$h}
}
try{
 $rows=@()
 foreach($spec in @(@{port=9600;pid=41272},@{port=8091;pid=38076},@{port=8095;pid=41308},@{port=8097;pid=40360})){
  $ls=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter ('LocalPort='+$spec.port+' AND State=2') -OperationTimeoutSec 3|Select-Object -ExpandProperty OwningProcess -Unique)
  if($ls.Count-ne 1 -or $ls[0]-ne $spec.pid){throw 'listener changed'}
  $pr=Get-CimInstance Win32_Process -Filter ('ProcessId='+$spec.pid) -OperationTimeoutSec 3
  $line=[string]$pr.CommandLine
  $release=[regex]::Match($line,'(?i)C:\ProgramData\Enclave\native-manager\releases\([a-f0-9]{64})\bootstrap\.mjs"?\s+(manager|router)\s+([a-f0-9]{64})')
  $entry=[regex]::Match($line,'(?i)C:\Program Files\Enclave\control\windows\(node\agent\.mjs|vbslike\manager\main\.mjs)')
  $files=@();$role=$null;$pin=$null
  if($release.Success){
   if($release.Groups[1].Value-cne $release.Groups[3].Value){throw 'release pin mismatch'}
   $pin=$release.Groups[1].Value;$role=$release.Groups[2].Value;$root='C:\ProgramData\Enclave\native-manager\releases\'+$pin
   $files+=HashPublic ($root+'\bootstrap.mjs');$manifest=HashPublic ($root+'\source-manifest.json');if($manifest.sha256-cne $pin){throw 'manifest mismatch'};$files+=$manifest
   foreach($rel in @('windows\vbslike\manager\main.mjs','windows\vbslike\manager\server.mjs','windows\vbslike\router\main.mjs','windows\vbslike\router\composite.mjs')){
    $fp=$root+'\control\'+$rel
    if(Test-Path -LiteralPath $fp){$files+=HashPublic $fp}
   }
  }elseif($entry.Success){
   $role=$entry.Groups[1].Value
   foreach($rel in $(if($spec.port-eq 9600){@('node\agent.mjs','node\host.mjs','node\isolation-client.mjs')}else{@('vbslike\manager\main.mjs','vbslike\manager\server.mjs','vbslike\manager\wmi-launcher.mjs')})){
    $fp='C:\Program Files\Enclave\control\windows\'+$rel
    if(Test-Path -LiteralPath $fp){$files+=HashPublic $fp}
   }
  }else{throw 'unrecognized source entry'}
  $pr2=Get-CimInstance Win32_Process -Filter ('ProcessId='+$spec.pid) -OperationTimeoutSec 3
  if($pr.CreationDate-ne $pr2.CreationDate -or $line-cne $pr2.CommandLine){throw 'incarnation changed'}
  $rows+=@{port=$spec.port;pid=$spec.pid;created=$pr.CreationDate.ToUniversalTime().ToString('o');role=$role;releasePin=$pin;files=$files}
 }
 @{readOnly=$true;atUtc=[DateTime]::UtcNow.ToString('o');rows=$rows;loadedModuleBytesProven=$false}|ConvertTo-Json -Depth 7 -Compress
}catch{@{readOnly=$true;errorType=$_.Exception.GetType().FullName;reason='public source binding refused';rows=$rows}|ConvertTo-Json -Depth 7 -Compress;exit 1}
