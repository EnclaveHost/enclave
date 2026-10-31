from pathlib import Path
import json,hashlib,subprocess,os,time,sys,base64,traceback
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';private=p/'private'
try:
 assert os.sched_getaffinity(0)=={1}
 for n,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
 sys.path.insert(0,str(p/'frozen/rpc'))
 import windows_files as files
 import sample_windows_clock as sampler
 c=files.c;d=files.w.delivery
 spec=json.loads((p/'SPEC.json').read_text())
 ad=json.loads((p.parent/'rpc-files-collect-copy-admission-r1/storage-RESULT.json').read_text());assert ad['rc']==0 and ad['failure'] is None and time.time()-ad['at']<300
 o=ad['observation'];assert o['before']==o['after'] and o['nodeExit']==0 and o['manager']['completeTransport'] and not o['manager']['errors'] and o['bootNative']==spec['boot']
 assert o['physicalAfter']['freeBytes']>=62709039104 and len(o['physicalAfter']['vms'])==4
 expected={41272:'134375630850989593',40360:'134375630828500376',41308:'134375617394407059',38076:'134375086385617521'}
 assert {r['pid']:r['creationFileTime']for r in o['nativeManagers']}==expected
 r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
 a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
 (p/'LOCAL-ADMISSION.json').write_text(json.dumps(a)+'\n')
 known=c.write_new(private/'known-host',(p/'KNOWN-HOST.txt').read_bytes())
 t={'target':{'host':'192.168.8.238','port':22,'user':'claude','identityFile':'/home/steven/.ssh/minipc'},'knownHosts':known,'hostAlias':'192.168.8.148','sshSha256':hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest(),'samplerPath':spec['samplerPath'],'samplerSha256':spec['samplerSha256']}
 shellroot=private/'shell';shellroot.mkdir(mode=0o700);argv,key=files.w.transport(t,shellroot);c.write_new(shellroot/'known-hosts',key)
 def shell(label,body):
  assert len(body)<20000
  command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(body.encode('utf-16le')).decode();assert len(command)<30000
  c.write_new(shellroot/(label+'.ps1'),body.encode());c.write_new(shellroot/(label+'.intent'),c.encode({'oneCall':True,'sourceSha256':hashlib.sha256(body.encode()).hexdigest()}))
  raw=d.exchange(argv+[command],b'',min(32,c.remaining(clock)))
  c.write_new(shellroot/(label+'.json'),raw);return json.loads(raw.decode('utf-8-sig'))
 def exit_read(label,identities,vmroot=None):
  encoded=base64.b64encode(json.dumps(identities).encode()).decode()
  body="$ErrorActionPreference='Stop';$expected=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'))|ConvertFrom-Json)\n"+r'''
$rows=@(foreach($row in $expected){$process=$null;try{$process=[Diagnostics.Process]::GetProcessById([int]$row.pid)}catch [ArgumentException]{}
 if($null -eq $process){@{pid=$row.pid;creation=$row.creation;exactAbsent=$true};continue}
 try{$held=$process.Handle;$creation=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();@{pid=$row.pid;creation=$row.creation;exactAbsent=($creation -cne [string]$row.creation -or $process.HasExited)}}finally{$process.Dispose()}})
$managers=@(foreach($pidValue in @(41272,40360,41308,38076)){$process=[Diagnostics.Process]::GetProcessById($pidValue);try{$held=$process.Handle;@{pid=$pidValue;creation=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();alive=(-not $process.HasExited)}}finally{$process.Dispose()}})
$vms=@(Get-VM|Select-Object Id,State,MemoryAssigned)
$files=@()
'''
  if vmroot:
   assert vmroot=='C:\\EnclaveRpcVm-'+spec['vmAttempt']+'\\'+spec['vmAttempt']
   body+="$root='"+vmroot+"'\n"+r'''
$files=@(foreach($name in @('boot.vhdx','seed.iso')){$path=Join-Path $root $name;$item=Get-Item -LiteralPath $path;if($item.Length -gt 65536 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Dummy file readback bound'};@{name=$name;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}})
'''
  body+="[pscustomobject]@{processes=$rows;managers=$managers;vms=$vms;files=$files;success=$true;readOnly=$true}|ConvertTo-Json -Depth 6 -Compress\n"
  result=shell(label,body);assert result['success'] and all(row['exactAbsent']for row in result['processes'])
  assert {row['pid']:row['creation']for row in result['managers']if row['alive']}==expected
  before=sorted([{k:row[k]for k in ('Id','State','MemoryAssigned')}for row in o['physicalAfter']['vms']],key=lambda r:r['Id'])
  assert sorted(result['vms'],key=lambda r:r['Id'])==before
  return result
 c.write_new(p/'INTENT.json',c.encode({'fixtureOnly':True,'noProductionClock':True,'specSha256':hashlib.sha256((p/'SPEC.json').read_bytes()).hexdigest()}))
 began=time.monotonic();begin=c.begin(private,spec['attempt'],'rpc-owned-'+spec['attempt'],spec['vmAttempt']);clock=sampler.sample(dict(begin=begin,windowsBoot=spec['boot'],**t));original=c.validate(clock)
 body=(p/'prepare-template.ps1').read_text()
 replacements={'BOOT':spec['boot'],'TOKEN':spec['attempt']*4,'VM':spec['vmAttempt'],'HANDOFF':spec['handoff'],'MEDIA':spec['media'],'ORIGIN':str(original['windowsOriginMilliseconds']),'DEADLINE':str(original['windowsDeadlineMilliseconds']),'CUTDEADLINE':str(original['windowsOriginMilliseconds']+20000)}
 for k,v in replacements.items():body=body.replace('@'+k+'@',v)
 prepared=shell('prepare',body);assert prepared['success'] and prepared['fixtureOnly'] and not prepared['vmChanged']
 (p/'PREPARE-RESULT.json').write_text(json.dumps(prepared,indent=2)+'\n')
 exit_read('prepare-exit',[{'pid':prepared['pid'],'creation':prepared['creation']}])
 results={};identities=[]
 for op,key,nonce in [('collect-cut','collect',spec['collectNonce']),('copy-media','copy',spec['copyNonce'])]:
  config=dict(clock=clock,transport=t,helper=spec['helper'],nonce=nonce)
  root,result,response=files.call(config,original,op,op,prepared[key]);native=json.loads(c.read_pinned(response));results[op]=native;identities.append({'pid':native['pid'],'creation':str(native['creation'])})
  if op=='collect-cut':
   rows={v['name']:base64.b64decode(v['base64'],validate=True)for v in result['files']};assert set(rows)=={'contract.txt','pool.activation','pool.complete'}
   assert hashlib.sha256(rows['contract.txt']).hexdigest()==prepared['collect']['contractHash'] and json.loads(rows['pool.activation'])==prepared['collect']['activation'] and rows['pool.complete']==hashlib.sha256(rows['pool.activation']).hexdigest().encode()
  else:
   assert not result['currentVmOffObserved'] and not result['mediaAttached'] and not result['privateContentsPrinted'] and result['definitionJournalBound']
   assert sorted(result['files'],key=lambda r:r['name'])==sorted(prepared['dummyFiles'],key=lambda r:r['name'])
  (p/(op+'-RESULT.json')).write_text(json.dumps(native,indent=2)+'\n')
 final=exit_read('workers-exit',identities,prepared['vmRoot'])
 assert sorted(final['files'],key=lambda r:r['name'])==sorted(prepared['dummyFiles'],key=lambda r:r['name'])
 (p/'EXIT-RESULT.json').write_text(json.dumps(final,indent=2)+'\n')
 (p/'RESULT.json').write_text(json.dumps({'passed':True,'seconds':time.monotonic()-began,'fixtureOnly':True,'actualProductionHelper':True,'collectCopyQualifiedWithDummyFiles':True,'dummyBytes':sum(v['bytes']for v in prepared['dummyFiles']),'exactProcessesAbsent':identities,'originalManagersAndVmsUnchanged':True,'fullSizeCopyProven':False,'nativeVmDefinitionProven':False,'productionClockAssigned':False,'rpcReady':False,'reservationMayRelease':False},indent=2)+'\n')
 print('Dummy collect/copy and exact exit PASS')
except Exception:
 (p/'failure.txt').write_text(traceback.format_exc());raise
