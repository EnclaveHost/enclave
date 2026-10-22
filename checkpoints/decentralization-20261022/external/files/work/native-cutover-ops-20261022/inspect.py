from pathlib import Path
import hashlib,importlib.util,json,datetime
r=Path(__file__).resolve().parent; src=r.parent/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(src.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
spec=importlib.util.spec_from_file_location('transport',src);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
script=r'''$o=[ordered]@{};$ns='root/Microsoft/Windows/TaskScheduler';
foreach($n in 'MSFT_ScheduledTask','MSFT_TaskService') {try{$c=Get-CimClass -Namespace $ns -ClassName $n -OperationTimeoutSec 5;$o[$n]=@($c.CimClassMethods|ForEach-Object{[ordered]@{name=$_.Name;parameters=@($_.Parameters|ForEach-Object{[ordered]@{name=$_.Name;type=[string]$_.CimType;qualifiers=@($_.Qualifiers|ForEach-Object{$_.Name+'='+[string]$_.Value})}})}})}catch{$o[$n]=[string]$_.Exception.Message}};
$sw=[Diagnostics.Stopwatch]::StartNew();$t=@(Get-CimInstance -Namespace $ns -ClassName MSFT_ScheduledTask -Filter "TaskName='Node'" -OperationTimeoutSec 5|Where-Object{$_.TaskPath -eq '\Enclave\'});$o.node=[ordered]@{count=$t.Count;state=@($t|ForEach-Object{[string]$_.State});ms=$sw.ElapsedMilliseconds};
$sw.Restart();$c=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'LocalPort=9600 AND State=2' -OperationTimeoutSec 5);$o.listener=[ordered]@{count=$c.Count;owners=@($c|ForEach-Object{[int]$_.OwningProcess});ms=$sw.ElapsedMilliseconds};
$o|ConvertTo-Json -Depth 8 -Compress'''
out=m.ps(script,secs=45);(r/'inspect.json').write_text(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':out},indent=2)+'\n');print(json.dumps(out))
if 'error' in out:raise SystemExit(1)
