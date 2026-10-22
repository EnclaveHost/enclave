#!/usr/bin/env python3
"""Root-reviewed disposable Windows writer proof. No production edits or restarts."""
import pathlib,json,hashlib,importlib.util,uuid,subprocess,sys
P=pathlib.Path(__file__).resolve().parent
W=P.parents[1]
pins=json.loads((P/'pins.json').read_text())
for f,h in pins.items(): assert hashlib.sha256((P/f).read_bytes()).hexdigest()==h,f
assert not (P/'stage.json').exists(),'prior attempt exists; inspect, do not retry'
t=W/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
spec=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def save(name,obj):
    with (P/name).open('x') as f: json.dump(obj,f,indent=2)
def identity():
    r=m.ps("$p=@(Get-CimInstance Win32_Process -OperationTimeoutSec 30|Where-Object{$_.CommandLine -match 'agent\\.mjs'}|ForEach-Object{[ordered]@{pid=$_.ProcessId;created=[string]$_.CreationDate}});$v=@(Get-VM|ForEach-Object{[ordered]@{name=$_.Name;id=[string]$_.Id;state=[string]$_.State}});@{protected=$p;vms=$v}|ConvertTo-Json -Compress -Depth 4",secs=90)
    assert 'error' not in r and len(r.get('protected',[]))>=2 and r.get('vms'),r
    return {'protected':sorted(r['protected'],key=lambda x:x['pid']),'vms':sorted(r['vms'],key=lambda x:x['id'])}
before=identity();save('identity-before.json',before)
stage=r'C:\ProgramData\Enclave\staging\writer-proof-'+uuid.uuid4().hex[:12]
save('stage.json',{'stage':stage,'pins':pins})
r=m.ps("$d='"+stage+"';if(Test-Path -LiteralPath $d){throw 'already exists'};New-Item -ItemType Directory -Path $d|Out-Null;@{created=$d}|ConvertTo-Json -Compress",secs=30)
assert r.get('created')==stage,r
for f in pins:
    p=subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=15',str(P/f),'minipc:/'+stage.replace('\\','/')+'/'+f],capture_output=True,text=True,timeout=60)
    assert p.returncode==0,p.stderr
checks=';'.join("if((FileSha (Join-Path $d '"+f+"')) -ne '"+h+"'){throw 'pin mismatch'}" for f,h in pins.items())
r=m.ps("$d='"+stage+"';"+checks+";& (Join-Path $d 'run-canary.ps1') -NodeExe 'C:\Program Files\nodejs\node.exe' -NodeSha256 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3'",secs=240)
save('execution.json',r)
after=identity();save('identity-after.json',after)
checks_seen=r.get('result',{}).get('checks',{})
ok=(r.get('result',{}).get('pass') is True and len(checks_seen)==9 and all(v.get('pass') is True for v in checks_seen.values()) and r.get('cleanup',{}).get('scratchRemoved') is True and before==after)
print(json.dumps({'pass':ok,'execution':r,'identitiesUnchanged':before==after},indent=2),flush=True)
save('root-verdict.json',{'pass':ok,'identitiesUnchanged':before==after,'expectedChecks':9,'observedChecks':len(checks_seen)})
# Collect before removing our staged scripts; refuse unknown contents or remaining processes.
c=m.ps("$d='"+stage+"';$ps=@(Get-CimInstance Win32_Process|Where-Object{([string]$_.CommandLine).Contains($d)}|ForEach-Object{$_.ProcessId});$items=@(Get-ChildItem -LiteralPath $d -Force|ForEach-Object{@{name=$_.Name;directory=$_.PSIsContainer;sha=FileSha $_.FullName}});@{processes=$ps;items=$items}|ConvertTo-Json -Compress -Depth 4",secs=60)
save('collection.json',c)
assert not c.get('processes') and isinstance(c.get('items'),list),c
cleanup=[]
for item in c['items']:
    f=item['name'];assert not item['directory'],item
    if f in pins: assert item['sha']==pins[f],item
    else:
        import re
        assert re.fullmatch(r'result-\d{8}T\d{6}Z\.json',f),item
    cleanup.append("$p=Join-Path $d '"+f+"';if((FileSha $p) -ne '"+item['sha']+"'){throw 'cleanup pin'};Remove-Item -LiteralPath $p -Force")
r=m.ps("$d='"+stage+"';"+';'.join(cleanup)+";if(@(Get-ChildItem -LiteralPath $d -Force).Count){throw 'not empty'};Remove-Item -LiteralPath $d;@{removed=(-not(Test-Path -LiteralPath $d))}|ConvertTo-Json -Compress",secs=45)
save('cleanup.json',r)
assert r.get('removed') is True,r
sys.exit(0 if ok else 1)
