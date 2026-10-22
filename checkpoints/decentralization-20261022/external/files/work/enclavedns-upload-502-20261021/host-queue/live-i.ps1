$ErrorActionPreference='Stop'
# READ-ONLY: from minipc's own stack (the path host egress uses), resolve via 1.1.1.1 and TCP-connect (no bytes sent,
# 6 s) to the 13 host:ports sia-diag could not reach at 18:41Z. Also the active IPv4 route interface for each IP.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$jobs=@()
foreach($x in @('hostd_1_2.sia.rm.ovd.quedicestioxd.com:9989','43.229.148.230:9984','sia.oelke.tec.br:9984','sia.foxnet.me:9984','sia.xiotic.net:9984','sialinux.6000011.xyz:9994','sia2.aspan.hosting:9984','sia1.siahost.ca:9984','184.58.150.3:9984','datasink.freemyip.com:9984','siayura2.ddns.net:9984','blurp.airdns.org:49590','196.216.137.249:9984')){ $h,$p=$x -split ':(?=\d+$)'; $ip=$h
  if(-not ($h -as [ipaddress])){ try{ $ip=@(Resolve-DnsName -Name $h -Type A -Server 1.1.1.1 -DnsOnly -QuickTimeout -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress }catch{ $ip=$null } }
  if(-not $ip){ "$x resolve=FAIL"; continue }
  $ifc=try{ (Find-NetRoute -RemoteIPAddress $ip -ErrorAction Stop | Where-Object { $_.InterfaceAlias } | Select-Object -First 1).InterfaceAlias }catch{ '?' }
  $c=New-Object Net.Sockets.TcpClient; $sw=[Diagnostics.Stopwatch]::StartNew(); $task=$c.ConnectAsync($ip,[int]$p)
  $ok=$task.Wait(6000) -and $c.Connected; $err=if($task.Exception){$task.Exception.InnerException.GetType().Name + ':' + $task.Exception.InnerException.SocketErrorCode}else{''}
  "$x ip=$ip if=$ifc connect=$(if($ok){'open'}elseif(-not $task.IsCompleted){'timeout'}else{'fail '+$err}) ms=$($sw.ElapsedMilliseconds)"; $c.Close() }
