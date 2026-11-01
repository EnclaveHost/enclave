from pathlib import Path
import json,subprocess,hashlib,time,os,sys
p=Path(__file__).resolve().parent;u=p.parent;s=u.parent/'source'
for n,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
sys.path.insert(0,str(s/'rpc'));import deliver_activation as transport
assert hashlib.sha256((s/'rpc/deliver_activation.py').read_bytes()).hexdigest()==json.loads((p/'SOURCE.json').read_text())['transport']
stage=u/'rpc-preparation-diagnostic-target-stage-r1';assert json.loads((stage/'verify-RESULT.json').read_text())['success']
ad=json.loads((u/'rpc-preparation-diagnostic-target-admission-r1/storage-RESULT.json').read_text());assert ad['rc']==0 and ad['failure'] is None and time.time()-ad['at']<240
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
start=time.monotonic();sample=once('sample',v['samplerPath']+' '+v['nonce']+' 7a8586db00c64f6f8ab024ae134fe641 '+v['samplerHash'],3)
assert sample['windowsBoot']==v['boot'] and sample['attempt']==v['nonce'] and sample['vmAttempt']=='7a8586db00c64f6f8ab024ae134fe641'
origin=sample['monotonicMilliseconds'];deadline=origin+30000
assert time.monotonic()-start<3
root=v['root'];files=v['artifacts']
command=' '.join([root+'\\definition-controller.exe','--target',root+'\\definition-entry.exe',files['definition-entry.exe']['sha256'],v['nonce'],'preparation-check',root+'\\observation.json',files['observation.json']['sha256'],v['planPath'],v['planHash'],str(origin),str(deadline)])
row=once('inspect',command,33)
assert row['operation']=='preparation-check' and row['plan']==v['planHash'] and row['origin']==origin and row['deadline']==deadline
(p/'RESULT.json').write_text(json.dumps({'returned':True,'native':row,'readOnlyDiagnostic':True,'remoteDeathProven':False,'reservationMayRelease':False},indent=2)+'\n')
