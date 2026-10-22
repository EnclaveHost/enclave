$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'shield-egress.exe' -and $_.CommandLine -match '0xef514ed3'}
$listen=Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen|Where-Object LocalAddress -eq '127.0.0.1'|Select-Object -First 1
foreach($target in @('sia.enclave.host')){
$c=New-Object Net.Sockets.TcpClient
$c.Connect('127.0.0.1',$listen.LocalPort)
$s=$c.GetStream();$s.ReadTimeout=20000;$b=[Text.Encoding]::ASCII.GetBytes("egress-web-v1 $target 443`n");$s.Write($b,0,$b.Length)
try{$r=New-Object IO.StreamReader($s);$t=[DateTime]::UtcNow;$answer=$r.ReadLine();[pscustomobject]@{target=$target;reply=$answer;ms=([DateTime]::UtcNow-$t).TotalMilliseconds}|ConvertTo-Json -Compress}catch{Write-Output 'request timed out'}finally{$c.Close()}
}
