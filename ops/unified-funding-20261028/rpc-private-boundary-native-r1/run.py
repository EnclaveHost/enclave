"""New synthetic32MiB filesystem only; real writer/native workflow, explicit fixture-only VM check, actual global holder observations."""
from pathlib import Path
import os,sys,json,hashlib,subprocess,tempfile,shutil,fcntl,time,uuid,copy
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
pins=json.loads((p/'INPUT-PINS.json').read_text())
def sha(f):
 with open(f,'rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
def verify():
 for f,h in pins.items():assert sha(f)==h,f
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'scope':'synthetic-only native writer workflow; fixture-only VM check, real holder scan'},f)
source=p.parent/'rpc-private-boundary-root-repaired-r1/candidate'
sys.path.insert(0,str(source))
import offline_mask as om
import test_offline_mask as fixture
root=Path('/vm/enclave-volumes/rpc-production-maint')
assert root.is_dir() and not root.is_symlink() and root.stat().st_dev!=Path('/').stat().st_dev
assert os.statvfs(root).f_bavail*os.statvfs(root).f_frsize>301*(1<<30)
t=Path(tempfile.mkdtemp(prefix='synthetic-private-',dir=root));os.chmod(t,0o700)
(p/'TEMP.json').write_text(json.dumps({'path':str(t),'syntheticOnly':True}))
log=(p/'native-setup.jsonl').open('x')
def run(argv):
 r=subprocess.run(argv,stdin=subprocess.DEVNULL,capture_output=True,env={'PATH':'/usr/bin:/bin','LANG':'C'},timeout=30)
 assert len(r.stdout)+len(r.stderr)<1<<20
 log.write(json.dumps({'argv':list(map(str,argv)),'rc':r.returncode,'stdout':r.stdout.decode(errors='replace'),'stderr':r.stderr.decode(errors='replace')})+'\n');log.flush()
 assert r.returncode==0,(argv[0],r.returncode)
 return r
part=t/'root.ext4'
with part.open('xb') as f:f.truncate(32<<20)
run(['/usr/bin/mke2fs','-q','-F','-t','ext4','-L','cloudimg-rootfs',str(part)])
def dbg(req):
 r=run(['/usr/bin/debugfs','-w','-R',req,str(part)])
 assert not om.stderr_noise(r.stderr)
 return r.stdout
for x in ['/etc','/etc/systemd','/etc/systemd/system','/etc/systemd/system/multi-user.target.wants','/var','/var/lib','/usr','/usr/lib','/usr/lib/systemd','/usr/lib/systemd/system']:dbg('mkdir '+x)
dbg('symlink /lib usr/lib')
unitpaths=json.loads((p/'UNIT-SOURCES.json').read_text())
for name,path in unitpaths.items():
 assert sha(path)==om.UNITS[name]
 dbg(f'write {path} /etc/systemd/system/{name}')
 dbg(f'sif /etc/systemd/system/{name} mode 0100644')
 dbg(f'symlink /etc/systemd/system/multi-user.target.wants/{name} ../{name}')
run(['/usr/bin/e2fsck','-fn',str(part)])
# Keep GPT table construction independent of the product parser using the frozen test generator.
start=2048;end=start+(32<<20)//512-1;disk=fixture.build_disk(parts=((fixture.LINUX,fixture.ROOT_GUID,start,end),),nsec=end+2049)
with part.open('rb') as f:disk[start*512:(end+1)*512]=f.read()
raw=t/'disk.raw';raw.write_bytes(disk);del disk
origin=t/'source.qcow2';backup=t/'backup.qcow2'
run(['/usr/bin/qemu-img','convert','-f','raw','-O','qcow2',str(raw),str(origin)])
shutil.copyfile(origin,backup);os.chmod(origin,0o400);os.chmod(backup,0o400)
origin_hash,backup_hash=sha(origin),sha(backup);assert origin_hash==backup_hash
receipt=t/'backup-receipt.json';receipt.write_text(json.dumps({'sha256':backup_hash,'syntheticOnly':True}))
fx=om.OsEffects();p0=fixture.plan()
def identity(f):
 s=f.stat();return {'path':str(f),'sha256':sha(f),'device':s.st_dev,'inode':s.st_ino,'size':s.st_size,'mtimeNs':s.st_mtime_ns}
p0['writerSource']={'path':str(source/'offline_mask.py'),'sha256':sha(source/'offline_mask.py')}
p0['unitPins']={'path':str(source/'UNIT-PINS.json'),'sha256':sha(source/'UNIT-PINS.json')}
p0['tools']['systemctl']['sha256']=sha('/usr/bin/systemctl')
p0['source']=identity(origin);p0['backup']=dict(identity(backup),receiptPath=str(receipt),receiptSha256=sha(receipt))
p0['destination'].update(parentDir=str(t),workDirName='result',device=t.stat().st_dev,forbiddenDevices=[Path('/').stat().st_dev,Path('/tmp').stat().st_dev],floorBytes=300*(1<<30))
p0['image'].update(virtualSize=raw.stat().st_size,rootFirstLba=start,rootLastLba=end)
with part.open('rb') as f:f.seek(1024);sb=om.parse_ext4_sb(f.read(1024))
p0['filesystem']={k:sb[k] for k in ['uuid','label','blockSize','blocksCount','inodesCount','featureCompat','featureIncompat','featureRoCompat']}
p0['resourceEnvelope']=fx.resource_scope();p0['bounds'].update(totalSeconds=180,commandSeconds=15,fsckSeconds=30)
lock=t/'workflow.lock';fd=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_EXCL,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);ls=lock.stat()
p0['workflowLocks']=[{'path':str(lock),'device':ls.st_dev,'inode':ls.st_ino}]

# Only disposable fixture service identities; no production service is queried or changed.
p0['vmUnits']=['rpc-private-fixture-vm.service','rpc-private-fixture-guard.service']
def private_policy(plan, name):
    uid=os.geteuid();assert uid>0
    chains={}
    for key,path in [('source',plan['source']['path']),('backup',plan['backup']['path']),('destinationParent',plan['destination']['parentDir'])]:
        rows=[]
        for item in om.path_chain(path):
            o=fx.access_meta(item)
            assert o['stable'] and om.acl_state(o)=='none',item
            rows.append({'path':item,'device':o['dev'],'inode':o['ino'],'type':o['type'],'uid':o['uid'],'gid':o['gid'],'mode':o['perm'],'acl':'none'})
        chains[key]=rows
    access={'format':om.FORMAT_PATH_ACCESS,'operationId':plan['operationId'],'maintenanceUid':uid,'capturedBy':'root-reviewed-synthetic-fixture','chains':chains}
    trust={k:True for k in om.POLICY_TRUST}
    coord={'format':om.FORMAT_COORDINATION,'operationId':plan['operationId'],'stamp':plan['stamp'],'vmUnits':plan['vmUnits'],'workflowLocks':plan['workflowLocks'],
       'lifecycleProducers':[{'name':v,'coordination':'plan-vm-unit-stopped','ref':v} for v in plan['vmUnits']]+[{'name':'synthetic-workflow','coordination':'plan-workflow-lock','ref':str(lock)}],
       'operatorAssertions':trust,'sameUidActorDiscovery':'not-performed-operator-assertion-only','operator':'root-reviewed-synthetic-fixture'}
    refs={}
    for key,doc in [('pathAccess',access),('coordination',coord)]:
        f=t/(name+'-'+key+'.json')
        with f.open('x') as out:json.dump(doc,out,sort_keys=True)
        refs[key]={'path':str(f),'sha256':sha(f)}
        shutil.copyfile(f,p/f.name)
    plan['holderPolicy']={'kind':om.POLICY_KIND,'intent':'private-preparation-only','maintenanceUid':uid,'trust':trust,'authority':{k:False for k in om.POLICY_AUTHORITY},
        'hostHolderVisibility':'incomplete-not-asserted','unreadableProcesses':'retain-as-incomplete-visibility','inputModes':{'source':0o400,'backup':0o400},'evidence':refs}
    om.validate_plan(plan)
    return json.dumps(plan,sort_keys=True).encode()
encoded=private_policy(p0,'positive');(p/'PLAN.json').write_bytes(encoded)
original_writer=om.Writer
class FixtureWriter(original_writer):
    def vm_stopped(self):
        assert self.p['vmUnits']==['rpc-private-fixture-vm.service','rpc-private-fixture-guard.service']
        assert self.p['source']['path']==str(origin) and self.p['backup']['path']==str(backup)
        return {'syntheticFixture':True,'newFixtureNeverBooted':True,'productionVmQueryMocked':True}
om.Writer=FixtureWriter
try:
    rc,out=om.operate(p0,hashlib.sha256(encoded).hexdigest(),[fd],om.OsEffects(),str(source/'offline_mask.py'))
    assert rc==0,out
    receipt_path=Path(out['receipt']);receipt_doc=json.loads(receipt_path.read_text())
    assert receipt_doc['status']=='PRIVATE-PREPARED' and receipt_doc['publishable'] is False
    assert receipt_doc['completeHostHolderVisibility'] is False
    assert receipt_doc['holderObservations']['before']['unreadable'], 'fixture requires actual incomplete global visibility; no fabricated unknowns'
    for exp in receipt_doc['evidence'].get('exporters',[]):
        assert exp.get('survivors',[])==[],exp
    assert not any(om._mounted(str(x)) for x in (t/'result').glob('mnt-*'))
    shutil.copytree(t/'result',p/'workflow-evidence',ignore=shutil.ignore_patterns('derivative.qcow2','mnt-*'))
    # Independent negative admission: change ONLY this fresh fixture parent mode after pinning.
    neg=copy.deepcopy(p0);neg['operationId']='private-negative-0001';neg['destination']['workDirName']='negative-result'
    encoded_neg=private_policy(neg,'negative');(p/'NEGATIVE-PLAN.json').write_bytes(encoded_neg)
    os.chmod(t,0o750)
    try:nrc,nout=om.operate(neg,hashlib.sha256(encoded_neg).hexdigest(),[fd],om.OsEffects(),str(source/'offline_mask.py'))
    finally:os.chmod(t,0o700)
    assert nrc==2 and nout['refused']['phase']=='access',nout
    assert not (t/'negative-result').exists() and not (t/'negative-result.operation').exists()
    assert sha(origin)==origin_hash and sha(backup)==backup_hash
    verify()
    result={'exit':rc,'writerResult':out,'syntheticOnly':True,'mocks':['vm_stopped only for exact fresh never-booted fixture'],
      'actualGlobalHolderScan':True,'unreadableBeforeCount':len(receipt_doc['holderObservations']['before']['unreadable']),
      'unreadableAfterCount':len(receipt_doc['holderObservations']['after']['unreadable']),
      'privateReceipt':{'status':receipt_doc['status'],'publishable':receipt_doc['publishable']},
      'negative':{'exit':nrc,'refusal':nout,'noWorkCreated':True},'sourceBackupUnchanged':True,'fixture':str(t),'productionQualified':False}
    (p/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
    os.close(fd);om.Writer=original_writer
