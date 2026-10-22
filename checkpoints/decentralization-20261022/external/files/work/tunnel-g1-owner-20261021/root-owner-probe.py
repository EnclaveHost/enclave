import pathlib,hashlib,importlib.util,json
w=pathlib.Path(__file__).resolve().parent.parent;p=w/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(p.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
script=r'''$o=@();$sched=[int](Get-CimInstance Win32_Service -Filter "Name='Schedule'" -OperationTimeoutSec 10).ProcessId;foreach($procId in @($PID,$sched)){$c=Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -OperationTimeoutSec 5;$r=[ordered]@{pid=$procId;name=$c.Name};try{$v=Invoke-CimMethod -InputObject $c -MethodName GetOwner -OperationTimeoutSec 5;$r.rc=$v.ReturnValue;$r.user=$v.User;$r.domain=$v.Domain;$r.type=$v.GetType().Name}catch{$r.error=$_.FullyQualifiedErrorId;$r.kind=$_.Exception.GetType().Name};$o+=$r};$o|ConvertTo-Json -Depth 4 -Compress'''
r=m.ps(script,60);out=pathlib.Path(__file__).with_name('root-owner-probe.json');out.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
