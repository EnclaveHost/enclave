$ErrorActionPreference='Stop'
foreach($id in @('0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238','0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33')){
try{$r=Invoke-RestMethod "http://127.0.0.1:9600/v1/deployments/$id/logs";[pscustomobject]@{id=$id;lineCount=$r.lines.Count;egressRefused=@($r.lines|Where-Object{$_ -match 'egress CONNECT.*refused'}).Count;errorCount=@($r.lines|Where-Object{$_ -match 'error|failed|refused'}).Count}|ConvertTo-Json -Compress}catch{Write-Output 'logs unavailable'}
}
$v=Invoke-RestMethod http://127.0.0.1:8091/vms
$v.PSObject.Properties.Name
