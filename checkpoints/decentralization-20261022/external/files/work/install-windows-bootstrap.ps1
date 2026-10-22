$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$stage='C:\ProgramData\Enclave\nan-retirement'
$agent='C:\Program Files\Enclave\control\windows\node\agent.mjs'
$fetch='C:\Program Files\Enclave\control\windows\node\ipfs_fetch.py'
$wrapper='C:\ProgramData\Enclave\run-node.cmd'
$old="gateway: process.env.IPFS_GATEWAY || 'https://ipfs.enclave.host',"
$new="gateway: process.env.IPFS_GATEWAYS || process.env.IPFS_GATEWAY || 'https://ipfs.enclave.host',"
$text=[IO.File]::ReadAllText($agent)
if (-not $text.Contains($old)) { throw 'Expected gateway configuration not found; refusing broad patch' }
foreach($pair in @(@($agent,'agent.before-bootstrap.mjs'),@($fetch,'ipfs_fetch.before-bootstrap.py'),@($wrapper,'run-node.before-bootstrap.cmd'))){
  $out=Join-Path $stage $pair[1]
  if(Test-Path $out){throw 'Bootstrap backup already exists'}
  Copy-Item $pair[0] $out
  Set-Acl -Path $out -AclObject (Get-Acl $pair[0])
}
$gateways='["http://134.199.235.187:8189","http://134.209.248.172:8189","http://165.245.191.129:8189","http://146.190.246.39:8189","https://7ae476a3.app.enclave.host"]'
$lines=[IO.File]::ReadAllLines($wrapper)
$out=@();$inserted=$false
foreach($line in $lines){
 if($line -match '^set "IPFS_GATEWAYS='){continue}
 if(-not $inserted -and $line -match 'node.exe.*agent.mjs'){$out+='set "IPFS_GATEWAYS='+$gateways+'"';$inserted=$true}
 $out+=$line
}
if(-not $inserted){throw 'Node launch line not found'}
Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -like '*\control\windows\node\agent.mjs*'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}
Copy-Item "$stage\ipfs_fetch.py" $fetch -Force
[IO.File]::WriteAllText($agent,$text.Replace($old,$new),(New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllLines($wrapper,$out,[Text.Encoding]::ASCII)
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
'Windows artifact gateways configured without nan fallback'
