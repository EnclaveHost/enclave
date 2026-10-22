$ErrorActionPreference='Stop'
# READ-ONLY: hs2 config/receipt sha256, task state, and TCP/UDP listeners on the proposed G3 loopback ports. No content read.
$r='C:\ProgramData\Enclave\host-services\hs2'
function FileSha($f){if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'}}
$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2' -ErrorAction SilentlyContinue
$ports=18280,18288,18289,18290
$tcp=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid $($_.OwningProcess)" })
$udp=@(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" })
$hs=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { 18150..18199 -contains $_.LocalPort -or 18270..18299 -contains $_.LocalPort } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" } | Sort-Object -Unique)
[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');config=FileSha "$r\config\host-services.json";receipt=FileSha "$r\config\install-receipt.txt";
  serviceTlsPkg=FileSha 'C:\Program Files\Enclave\host-services\hs2\packages\service-tls.package.json';
  taskState=$(if($t){[string]$t.State}else{'absent'});g3PortListenersTcp=$tcp;g3PortListenersUdp=$udp;listening18150to18199and18270to18299=$hs} | ConvertTo-Json -Depth 3
