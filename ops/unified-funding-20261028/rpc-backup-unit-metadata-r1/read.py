"""Bounded read-only metadata of eight pinned units in the verified OS backup."""
from pathlib import Path
import os,sys,json,hashlib,subprocess,tempfile,time,signal
P=Path(__file__).resolve().parent
def sha(p):
    with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
pins=json.loads((P/'INPUT-PINS.json').read_text())
def verify():
    for x in pins:assert sha(x['path'])==x['sha256'],x['path']
verify()
sys.path.insert(0,str(P.parent/'rpc-offline-native-locks-r2/candidate'))
import offline_mask as om
assert os.sched_getaffinity(0)=={1}
B=Path('/vm/enclave-volumes/rpc-production-maint/os-backup-20261030T061922Z-1a31c4/os.qcow2')
def ident():
    s=B.lstat();return [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns]
before=ident()
assert before==json.loads((P.parent/'rpc-backup-readonly-fsck-r1/ATTEMPT.json').read_text())['backupStat']
assert not B.is_symlink() and B.stat().st_mode&0o777==0o400
with (P/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'backupStat':before,'scope':'read-only unit metadata and content hashes only'},f)
fx=om.OsEffects();fd=fx.hold_qemu_locks(str(B),{'device':before[0],'inode':before[1]})
t=Path(tempfile.mkdtemp(prefix='rpc-unit-metadata-'));mnt=t/'mnt';mnt.mkdir();raw=mnt/'root'
layout=json.loads((P.parent/'rpc-backup-readonly-layout-r1/RESULT.json').read_text())['root']
offset=layout['firstLba']*512;length=(layout['lastLba']-layout['firstLba']+1)*512
opts=f'driver=raw,offset={offset},size={length},file.driver=qcow2,file.file.driver=file,file.file.filename={B}'
env={'PATH':'/usr/bin:/bin','LANG':'C'}
err=(P/'export.stderr').open('xb')
proc=subprocess.Popen(['/usr/bin/nbdfuse','-r',str(raw),'[','/usr/bin/qemu-nbd','-r','--image-opts',opts,']'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=err,env=env,start_new_session=True)
start=Path(f'/proc/{proc.pid}/stat').read_text().rsplit(')',1)[1].split()[19]
(P/'PROCESS.json').write_text(json.dumps({'pid':proc.pid,'starttime':start,'temp':str(t)}))
evidence={'readOnly':True,'units':{},'ancestors':{},'links':{},'productionQualified':False}
def call(command):
    assert command.split()[0] in ('stat','ls','cat','ea_list') and '\n' not in command
    r=subprocess.run(['/usr/bin/debugfs','-R',command,str(raw)],stdin=subprocess.DEVNULL,capture_output=True,env=env,timeout=5)
    assert len(r.stdout)+len(r.stderr)<1<<20
    assert r.returncode==0 and not om.stderr_noise(r.stderr),(command,r.returncode)
    return r.stdout
def metadata(path):
    # Capture timestamps and names, never attribute values or unit contents.
    result=om.parse_stat(call('stat '+path).decode())
    attrs=call('ea_list '+path).decode()
    result['eaListEmpty']=not attrs.strip()
    result['eaListSha256']=hashlib.sha256(attrs.encode()).hexdigest()
    return result
try:
    end=time.monotonic()+10
    while not raw.exists():
        assert proc.poll() is None and time.monotonic()<end
        time.sleep(.1)
    assert raw.stat().st_size==length
    for path in ('/etc','/etc/systemd','/etc/systemd/system','/var','/var/lib','/lib','/usr/lib/systemd/system'):
        evidence['ancestors'][path]=metadata(path)
    for name,expected in om.UNITS.items():
        path='/etc/systemd/system/'+name
        m=metadata(path);m['sha256']=hashlib.sha256(call('cat '+path)).hexdigest();m['expectedHashMatches']=m['sha256']==expected
        evidence['units'][name]=m
    # Inspect link entries only in bounded systemd trees, without exposing unit contents.
    for base in ('/etc/systemd/system','/usr/lib/systemd/system'):
        entries=om.parse_ls_p(call('ls -p '+base).decode());assert len(entries)<3000
        paths=[(base+'/'+x['name'],x) for x in entries]
        for x in entries:
            if x['mode']&0o170000==0o040000:
                children=om.parse_ls_p(call('ls -p '+base+'/'+x['name']).decode());assert len(children)<3000
                paths.extend((base+'/'+x['name']+'/'+c['name'],c) for c in children)
        assert len(paths)<5000
        for path,m in paths:
            if m['mode']&0o170000==0o120000:
                st=metadata(path)
                if Path(path).name in om.UNITS or (st['target'] and Path(st['target']).name in om.UNITS):evidence['links'][path]=st
finally:
    # This observer owns this exact foreground exporter and mount only.
    un=subprocess.run(['/usr/bin/fusermount3','-u',str(mnt)],capture_output=True,timeout=8)
    try:proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid,signal.SIGTERM)
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
    err.close();fx.release(fd)
    evidence.update(backupStatUnchanged=ident()==before,unmountExit=un.returncode,mountGone=not os.path.ismount(mnt),exportExit=proc.returncode,exporterGone=not Path(f'/proc/{proc.pid}').exists())
    verify()
    (P/'RESULT.json').write_text(json.dumps(evidence,indent=2)+'\n')
assert evidence['backupStatUnchanged'] and evidence['mountGone'] and evidence['exporterGone'] and evidence['exportExit']==0 and evidence['unmountExit']==0
assert len(evidence['units'])==8 and all(x['expectedHashMatches'] for x in evidence['units'].values())
print(json.dumps({'units':len(evidence['units']),'modes':{k:oct(v['perm']) for k,v in evidence['units'].items()},'links':len(evidence['links']),'readOnly':True}))
