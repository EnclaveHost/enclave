#!/usr/bin/env python3
"""Read-only G3 before/after checks; no keys or account contents read."""
import importlib.util,json,pathlib,sys,datetime
here=pathlib.Path(__file__).resolve().parent
sp=importlib.util.spec_from_file_location('driver',here/'root-hs2-g3.py');d=importlib.util.module_from_spec(sp);sp.loader.exec_module(d)
m,man=d.verify_local();before=sys.argv[1:]==['--before']
if sys.argv[1:] and not before:raise SystemExit('only --before is supported')
base=r"""$r='C:\ProgramData\Enclave\host-services\hs2';$p=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match 'agent\.mjs'}|ForEach-Object{[ordered]@{pid=$_.ProcessId;created=[string]$_.CreationDate}});$v=@(Get-VM|ForEach-Object{[ordered]@{name=$_.Name;id=[string]$_.Id;state=[string]$_.State}});$l=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{18280,18288,18289,18290 -contains $_.LocalPort}|ForEach-Object{[ordered]@{port=$_.LocalPort;address=$_.LocalAddress}});$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');config=FileSha "$r\config\host-services.json";protected=$p;vms=$v;listeners=$l;accountExists=(Test-Path "$r\state\service-tls\keys\account.json")};"""
checks=r"""function Probe($h,$u,$method){try{$a=Invoke-WebRequest -UseBasicParsing -DisableKeepAlive -Uri ('http://127.0.0.1:18280'+$u) -Method $method -Headers @{Host=$h} -MaximumRedirection 0 -TimeoutSec 8;[int]$a.StatusCode}catch{if($_.Exception.Response){[int]$_.Exception.Response.StatusCode}else{-1}}};$s='-f7hpjdlk22izuytea5czfmjykwlixh334uwemn3emcngrl2bir5a.app.enclave.host';$a=[ordered]@{};foreach($n in 'dir','boot','policy'){$a[($n+'Challenge')]=Probe ($n+$s) '/.well-known/acme-challenge/root-local-readiness-20261021' 'GET'};$a['directory']=Probe ('dir'+$s) '/health' 'GET';$a['policy']=Probe ('policy'+$s) '/health' 'GET';$a['bootstrap']=Probe ('boot'+$s) '/ipfs/bafybeifxqlmz2brzsy4dws7syvnzg2ekqgno2542kvesolddqk5cbhxavi' 'HEAD';$a['unknownHost']=Probe 'unknown.invalid' '/health' 'GET';$o['http']=$a;"""
# Exact known bootstrap object already verified through the existing replica; no wildcard or inferred CID.
result=m.ps(base+('' if before else checks)+"$o|ConvertTo-Json -Depth 5 -Compress",90)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
out=here/'root-g3'/('probe-'+('before-' if before else 'after-')+stamp+'.json');out.parent.mkdir(exist_ok=True);out.write_text(json.dumps(result,indent=2)+'\n')
fail=[]
if result.get('config')!=man['config']['old' if before else 'new']:fail.append('config mismatch')
if result.get('accountExists'):fail.append('unexpected ACME account')
if before and result.get('listeners'):fail.append('proposed ports occupied')
if len(result.get('protected',[]))<2 or not result.get('vms'):fail.append('protected processes or VMs not observed')
if not before:
 if result.get('listeners')!=[{'port':18280,'address':'127.0.0.1'}]:fail.append('unexpected listener set')
 expected={'dirChallenge':404,'bootChallenge':404,'policyChallenge':404,'directory':200,'policy':200,'bootstrap':200,'unknownHost':421}
 if result.get('http')!=expected:fail.append('HTTP readiness mismatch: '+str(result.get('http')))
 prior=sorted((here/'root-g3').glob('probe-before-*.json'))
 if not prior:fail.append('before evidence missing')
 else:
  old=json.loads(prior[-1].read_text())
  for k,key in [('protected','pid'),('vms','id')]:
   if sorted(result.get(k,[]),key=lambda x:x[key])!=sorted(old.get(k,[]),key=lambda x:x[key]):fail.append(k+' changed')
print(json.dumps({'receipt':str(out),'failures':fail,'config':result.get('config'),'listeners':result.get('listeners'),'http':result.get('http'),'protectedProcesses':len(result.get('protected',[])),'vmCount':len(result.get('vms',[]))},indent=2));sys.exit(bool(fail))
