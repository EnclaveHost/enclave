$ErrorActionPreference='Stop'
$ps=@(Get-CimInstance Win32_Process -Filter "Name='shielded-bridge.exe'" -OperationTimeoutSec 15)
$tcp=@(Get-NetTCPConnection -ErrorAction SilentlyContinue)
$out=@();foreach($p in $ps){$c=@($tcp|Where-Object{$_.OwningProcess -eq $p.ProcessId});$out+=@{pid=$p.ProcessId;start=$p.CreationDate.ToUniversalTime().ToString('o');tcpCount=$c.Count;states=@($c|Group-Object State|ForEach-Object{@{state=[string]$_.Name;count=$_.Count}});remotePorts=@($c|Group-Object RemotePort|ForEach-Object{@{port=$_.Name;count=$_.Count}})}}
@{utc=(Get-Date).ToUniversalTime().ToString('o');bridges=$out}|ConvertTo-Json -Depth 6 -Compress
