from pathlib import Path
import json,subprocess,hashlib,time,os,sys,base64,gzip
p=Path(__file__).resolve().parent;u=p.parent;s=u.parent/'source'
for n,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
sys.path.insert(0,str(s/'rpc'));import deliver_activation as transport
assert hashlib.sha256((s/'rpc/deliver_activation.py').read_bytes()).hexdigest()==json.loads((p/'SOURCE.json').read_text())['transport']
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(u/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3));assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'BEFORE-ADMISSION.json').write_text(json.dumps(a)+'\n')
subprocess.run(['/usr/bin/python3','-B',str(p/'read.py'),'storage'],timeout=50,check=True)
ad=json.loads((p/'storage-RESULT.json').read_text());assert ad['rc']==0 and ad['failure'] is None and time.time()-ad['at']<20
o=ad['observation'];assert o['before']==o['after'] and o['nodeExit']==0 and o['manager']['completeTransport'] and not o['manager']['errors']
assert o['physicalAfter']['freeBytes']>=84385202176 and len(o['physicalAfter']['vms'])==4
expected={41272:'134375630850989593',40360:'134375630828500376',41308:'134375617394407059',38076:'134375086385617521'}
assert {r['pid']:r['creationFileTime'] for r in o['nativeManagers']}==expected and all(r['alive'] for r in o['nativeManagers'])
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(u/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3));assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'LOCAL-ADMISSION.json').write_text(json.dumps(a)+'\n');v=json.loads((p/'SPEC.json').read_text());assert o['bootNative']==v['boot']
argv=['/usr/bin/ssh','-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=3','-oControlMaster=no','-oControlPath=none','minipc']
def once(name,command,seconds):
 with (p/'private'/(name+'.intent')).open('x') as f:json.dump({'at':time.time(),'command':command,'noRetry':True,'readOnlyDiagnostic':True},f);f.flush();os.fsync(f.fileno())
 try:raw=transport.exchange(argv+[command],b'',seconds)
 except transport.ExchangeFailure as e:
  (p/'private'/(name+'.stdout')).write_bytes(e.stdout);(p/'private'/(name+'.stderr')).write_bytes(e.stderr)
  (p/'RESULT.json').write_text(json.dumps({'returned':False,'exitCode':e.returncode,'reason':e.reason,'readOnlyDiagnostic':True,'remoteDeathProven':False,'reservationMayRelease':False})+'\n');raise
 (p/'private'/(name+'.stdout')).write_bytes(raw);return json.loads(raw.decode('utf-8-sig'))
node=[x['data'] for x in o['manager']['observations'] if x['label']=='node-after'];assert len(node)==1
rows=[x for x in node[0]['deployments'] if x['id']=='0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b'];assert len(rows)==1
k=rows[0];(p/'KVM-REVIEW.json').write_text(json.dumps({n:k.get(n) for n in ['id','status','memMb','hasIsolation','isolationHeld','isolationRetireFailed']})+'\n')
assert k['status'] in ('failed','claiming','stopped') and k['memMb']==8192 and not k['hasIsolation'] and not k['isolationHeld'] and not k['isolationRetireFailed'],'Changed KVM commitment needs review; no native attempt'
lineage=json.loads((u/'rpc-preparation-diagnostic-target-stage-r1/bundle/observation.json').read_text())
for key in ('legacyCutSeed','sharedPhysicalPool'):ad[key]=lineage[key]
payload=json.dumps(ad,separators=(',',':')).encode();assert len(payload)<262144
(p/'private/observation.json').write_bytes(payload)
body=(p/'publish.ps1').read_text().replace('__PAYLOAD__',base64.b64encode(payload).decode())
compressed=base64.b64encode(gzip.compress(body.encode(),mtime=0)).decode()
wrapper="$b=[Convert]::FromBase64String('"+compressed+"');$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GZipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);$s=$r.ReadToEnd();$r.Dispose();if($s.Length-gt 60000){throw 'source bound'};&([scriptblock]::Create($s))"
command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(wrapper.encode('utf-16le')).decode();assert len(command)<30000
published=once('publish',command,8)
assert published['root']==v['inputRoot'] and published['sha256']==hashlib.sha256(payload).hexdigest() and published['bytes']==len(payload) and published['executed'] is False
(p/'PUBLISHED.json').write_text(json.dumps(published)+'\n')
assert time.time()-ad['at']<12,'Observation must be staged within twelve seconds; no retry'
start=time.monotonic();sample=once('sample',v['samplerPath']+' '+v['nonce']+' 7a8586db00c64f6f8ab024ae134fe641 '+v['samplerHash'],3)
assert sample['windowsBoot']==v['boot'] and sample['attempt']==v['nonce'] and sample['vmAttempt']=='7a8586db00c64f6f8ab024ae134fe641'
origin=sample['monotonicMilliseconds'];deadline=origin+30000
assert time.monotonic()-start<3
root=v['root'];files=v['artifacts']
command=' '.join([root+'\\definition-controller.exe','--target',root+'\\definition-entry.exe',files['definition-entry.exe']['sha256'],v['nonce'],'preparation-check',v['inputRoot']+'\\observation.json',published['sha256'],v['planPath'],v['planHash'],str(origin),str(deadline)])
row=once('inspect',command,33)
assert row['operation']=='preparation-check' and row['plan']==v['planHash'] and row['origin']==origin and row['deadline']==deadline
(p/'RESULT.json').write_text(json.dumps({'returned':True,'native':row,'readOnlyDiagnostic':True,'remoteDeathProven':False,'reservationMayRelease':False},indent=2)+'\n')
