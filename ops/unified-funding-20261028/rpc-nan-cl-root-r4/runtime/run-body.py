# PREPARED ONLY. Root admission required; actual parent read-only, private persistent COW.
from pathlib import Path
import hashlib,json,fcntl,struct,stat,sys,resource
P=Path(__file__).resolve().parent;M=json.loads((P/'MANIFEST.json').read_text())
art=P/'artifacts';sockdir=Path('/run/user/1000/rpc-nan-client-n4')
parent=Path(M['parent']['path']);overlay=Path(M['overlayPath'])
exporter=None;tunnel=None;lockfd=None;remote_attempted=False;cut=False;workflow=None;main_completed=False;overlay_identity=None;overlay_creating=False
results={};errors=[];owned=[];cleaning=False;remote_calls={}
def sha(p):
    with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def record(n,v):
    with (P/n).open('x') as f:json.dump(v,f,indent=2);f.write('\n')
def verify():
    for n,h in json.loads((P/'PINS.json').read_text()).items():assert sha(P/n)==h,'input-drift:'+n
    for row in json.loads((P/'EXTERNAL-PINS.json').read_text()):
        q=Path(row['path']);assert str(q.resolve())==row['realpath'] and q.stat().st_size==row['bytes'] and sha(q)==row['sha256'],'external-drift'
def guard():
    if cleaning:return
    if lockfd is not None:parent_identity()
    available=next(int(l.split()[1]) for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
    assert available>=27648*1024,'host-memory-floor'
    fs=os.statvfs(overlay.parent.parent);assert fs.f_bavail*fs.f_frsize>=300000000000,'nvme-disk-floor'
    if art.exists():
        used=sum(q.stat().st_blocks*512 for q in art.iterdir() if q.is_file())
        assert used<=8<<20,'evidence-disk-cap'
        for q in art.glob('*.log'):assert q.stat().st_size<=1<<20,'log-cap'
    if overlay.exists():
        st=overlay.stat();assert overlay_creating or (overlay_identity is not None and (st.st_dev,st.st_ino)==overlay_identity),'overlay-path-drift'
        assert st.st_blocks*512<=7<<30,'overlay-growth-stop-threshold'
    for row in owned:
        if not row['closed']:
            # Keep PID unreaped until owned group termination.
            info=os.waitid(os.P_PID,row['process'].pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
            if info and row['required']:raise RuntimeError('background-exited:'+row['name'])
CAPTURE_GUARD=guard
def command(n,args,seconds=8,allowed=(0,)):
    guard();r=capture(args,seconds,limit=131072);results[n]=r
    assert r['rc'] in allowed and not r['reason'] and not r['truncated'],n
    guard();return r
def background(name,args):
    log=(art/(name+'.log')).open('xb')
    proc=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,
                          env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
    row={'name':name,'process':proc,'log':log,'closed':False,'required':True};owned.append(row);return row
def stop(row):
    if row is None or row['closed']:return
    proc=row['process'];row['required']=False
    # No reaping/poll before killpg; child PID is reserved until wait below.
    os.waitid(os.P_PID,proc.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
    try:os.killpg(proc.pid,signal.SIGTERM)
    except ProcessLookupError:pass
    until=time.monotonic()+3
    while time.monotonic()<until:
        if os.waitid(os.P_PID,proc.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT):break
        time.sleep(.1)
    try:os.killpg(proc.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    rc=proc.wait(timeout=3);row['closed']=True;row['log'].close()
    results['stop:'+row['name']]={'pid':proc.pid,'rc':rc,'reaped':True}
def sshargs():
    return ['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5',
      '-oControlMaster=no','-oControlPath=none','-oServerAliveInterval=5','-oServerAliveCountMax=2']

def parent_identity():
    q=parent.lstat();row=M['parent']
    assert not parent.is_symlink() and [q.st_dev,q.st_ino,q.st_size,q.st_mtime_ns,q.st_ctime_ns,q.st_mode]==[row[k] for k in ('device','inode','bytes','mtimeNs','ctimeNs','mode')],'parent-identity-drift'
    if lockfd is not None:
        f=os.fstat(lockfd);assert (f.st_dev,f.st_ino)==(q.st_dev,q.st_ino)
    return {'device':q.st_dev,'inode':q.st_ino,'bytes':q.st_size,'mtimeNs':q.st_mtime_ns,'ctimeNs':q.st_ctime_ns}
def header_pin():
    with parent.open('rb') as f:b=f.read(104)
    assert hashlib.sha256(b).hexdigest()==M['parent']['header104Sha256']
def bootstrap():
    common=(P/'capture-remote.py').read_text()
    body=r"""
import pathlib,json,hashlib,stat,sys
P=pathlib.Path;root=P('/run/enclave-rpc-nan-client-n4');os.umask(0o077)
assert os.geteuid()==0
assert P('/proc/sys/kernel/random/boot_id').read_text().strip()==M['bootId']
assert os.statvfs('/var/lib').f_bavail*os.statvfs('/var/lib').f_frsize>=8<<30
assert not root.exists()
available=next(int(l.split()[1])*1024 for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
assert available-((4352+M['admission']['observedPendingMiB'])<<20)>=(2048<<20),'pre-bootstrap-headroom'
assert M['admission']['authorized'] and M['admission']['at']<=time.time()<=M['admission']['expiresAt'],'stale-admission'
program=P(M['uploadDirectory'])/'program.py';st=program.lstat()
assert stat.S_ISREG(st.st_mode) and st.st_size<=131072
raw=program.read_bytes();assert hashlib.sha256(raw).hexdigest()==M['programSha256']
unit=P('/run/systemd/system/enclavenanattachn4.slice');assert not unit.exists()
for name in ('enclavenanattachn4.slice','enclavenantrialn4.slice','enclavenanguardn4.slice','enclave-rpc-nan-helper-n4.service','enclave-rpc-nan-watch-n4.service','enclave-rpc-nan-nbd-n4.service','enclave-rpc-nan-cl-trial-n4.service'):
 r=capture(['/usr/bin/systemctl','show',name,'--property=LoadState,ActiveState,FragmentPath,DropInPaths,ControlGroup,InvocationID,Transient'],3,limit=4096);assert not r['reason'] and not r['truncated'],'unit-observation-failed'
 info=dict(line.split('=',1) for line in r['stdout'].splitlines() if '=' in line)
 if name.endswith('.slice'):
  assert info.get('LoadState') in ('loaded','not-found') and info.get('ActiveState')=='inactive' and info.get('Transient')=='no' and not any(info.get(k) for k in ('FragmentPath','DropInPaths','ControlGroup','InvocationID')),'preexisting-trial-slice'
 else:assert info.get('LoadState')=='not-found','preexisting-trial-service'
root.mkdir(mode=0o700)
with (root/'manifest.json').open('x') as f:json.dump(M,f);f.flush();os.fsync(f.fileno())
with (root/'program.py').open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
(root/'program.py').chmod(0o700)
for name,mib in zip(M['ownedSlices'],(4096,128,128)):
 path=P('/run/systemd/system')/name
 with path.open('x') as f:f.write('[Unit]\nDescription=Nan CL '+M['nonce']+' '+name+'\n[Slice]\nMemoryMax='+str(mib)+'M\nMemorySwapMax=0\nCPUQuota=100%\nAllowedCPUs=1\nTasksMax=1024\n')
for argv in (['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start',*M['ownedSlices']]):
 r=capture(argv,5,limit=16384);assert r['rc']==0 and not r['reason']
for name,mib in zip(M['ownedSlices'],(4096,128,128)):
 assert (P('/sys/fs/cgroup')/name/'memory.max').read_text().strip()==str(mib<<20)
 assert (P('/sys/fs/cgroup')/name/'memory.swap.max').read_text().strip()=='0'
print(json.dumps({'root':str(root),'programSha256':M['programSha256'],'sliceMaximum':128<<20,'clientStarted':False}))
"""
    policy=(P/'nan-admission.py').read_text()
    definitions="from pathlib import Path as P\nimport hashlib\ncleaning=False\nACTION='bootstrap'\nlast_guard=0\nout={}\ndef read(p):return P(p).read_text().strip()\ndef sha(p):\n with P(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()\n"
    script=common+'\nM='+repr(M)+'\n'+definitions+policy+'\nfresh_nan_policy()\n'+body
    command='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit=enclave-rpc-nan-bootstrap-n4 --property=User=root --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=AllowedCPUs=1 --property=RuntimeMaxSec=40 --property=TimeoutStopSec=10 --property=UMask=0077 /usr/bin/python3 -B -'
    r=capture([*sshargs(),M['target'],command],55,stdin=script.encode(),limit=65536);results['bootstrap']=r
    record('BOOTSTRAP.json',r);assert r['rc']==0 and not r['reason'] and not r['truncated'],'bootstrap'
def remote(action):
    if action=='main':
        unit='enclave-rpc-nan-helper-n4';slice_name='enclavenanattachn4.slice';runtime=330;stop_seconds=95;seconds=445
        post=" '--property=ExecStopPost=/usr/bin/python3 -B /run/enclave-rpc-nan-client-n4/program.py wait-cleanup'"
    elif action=='verify':
        unit='enclave-rpc-nan-verify-n4';slice_name='enclavenanguardn4.slice';runtime=130;stop_seconds=10;seconds=145;post=''
    else:
        unit='enclave-rpc-nan-'+action+'-n4';slice_name='enclavenanguardn4.slice';runtime=20;stop_seconds=5;seconds=30;post=''
    command='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit='+unit+' --slice='+slice_name+' --property=User=root --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=TasksMax=64 --property=RuntimeMaxSec='+str(runtime)+' --property=TimeoutStopSec='+str(stop_seconds)+' --property=KillMode=control-group --property=UMask=0077'+post+' /usr/bin/python3 -B /run/enclave-rpc-nan-client-n4/program.py '+action
    r=capture([*sshargs(),M['target'],command],seconds,limit=2097152);results['remote:'+action]=r;record('REMOTE-'+action.upper()+'.json',r)
    assert r['rc']==0 and not r['reason'] and not r['truncated'],'remote:'+action
    lines=[json.loads(l[len('RESULT_JSON='):]) for l in r['stdout'].splitlines() if l.startswith('RESULT_JSON=')]
    assert len(lines)==1 and lines[0]['ok'] and not lines[0]['errors'],'remote-result:'+action
    if action=='main':
        post=[json.loads(l[len('STOP_POST_JSON='):]) for l in r['stdout'].splitlines() if l.startswith('STOP_POST_JSON=')]
        assert len(post)==1 and post[0]['ok'] and not post[0]['errors'],'helper-stop-post'
    return lines[0]
def request_stop():
    try:remote('request-stop')
    except Exception as e:results['requestStopFailure']=type(e).__name__
def start_export():
    global exporter,tunnel
    socket=sockdir/'export.sock';assert not socket.exists()
    exporter=background('export-trial',[M['qemuNbd'],'--persistent','--shared=1','--socket',str(socket),'--export-name',M['exportName'],'--format=qcow2','--cache=none','--aio=threads',str(overlay)])
    until=time.monotonic()+5
    while not socket.exists() and time.monotonic()<until:guard();time.sleep(.1)
    assert stat.S_ISSOCK(socket.lstat().st_mode);socket.chmod(0o600)
    tunnel=background('tunnel-trial',[*sshargs(),'-N','-oExitOnForwardFailure=yes','-oStreamLocalBindMask=0177','-oStreamLocalBindUnlink=no','-R',M['remoteSocket']+':'+str(socket),M['target']])
    time.sleep(1);guard()
def run():
    global lockfd,workflow,remote_attempted,main_completed,overlay_identity,overlay_creating
    os.umask(0o077);verify()
    admit=json.loads((P/'ROOT-ADMISSION.json').read_text())
    assert admit['admissionSha256']==hashlib.sha256(json.dumps(M['admission'],sort_keys=True).encode()).hexdigest()
    assert admit['authorized'] is True and admit['scope']=='actual-nan-cl-bounded-client-n4' and admit['pinsSha256']==sha(P/'PINS.json') and 0<=time.time()-admit['at']<=300
    assert os.sched_getaffinity(0)=={1}
    cg=Path('/proc/self/cgroup').read_text().strip();assert cg.startswith('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-') and cg.endswith('.scope')
    c=Path('/sys/fs/cgroup'+cg[3:]);assert (c/'memory.max').read_text().strip()==str(512<<20) and (c/'memory.swap.max').read_text().strip()=='0'
    guard();parent_identity();header_pin()
    assert not overlay.parent.exists(),'client-COW-directory-preexists'
    record('ATTEMPT.json',{'at':time.time(),'scope':cg,'pinsSha256':sha(P/'PINS.json'),'privateCowOnly':True,'noRetry':True})
    art.mkdir(mode=0o700);sockdir.mkdir(mode=0o700);overlay.parent.mkdir(mode=0o700)
    assert overlay.parent.stat().st_dev==M['parent']['device']
    resource.setrlimit(resource.RLIMIT_FSIZE,(8<<30,8<<30))
    workflow=os.open(overlay.parent/'client-trial-n4.lock',os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_CLOEXEC,0o600);fcntl.flock(workflow,fcntl.LOCK_EX|fcntl.LOCK_NB)
    lockfd=os.open(parent,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    for byte in (201,202,203):fcntl.fcntl(lockfd,fcntl.F_OFD_SETLK,struct.pack('@hhqqi4x',fcntl.F_RDLCK,os.SEEK_SET,byte,1,0))
    occupied=fcntl.fcntl(lockfd,fcntl.F_OFD_GETLK,struct.pack('@hhqqi4x',fcntl.F_WRLCK,os.SEEK_SET,100,200,0));assert struct.unpack('@hhqqi4x',occupied)[0]==fcntl.F_UNLCK
    initial=json.loads(command('originalBackingChain',[M['qemuImg'],'info','--output=json','--backing-chain',str(parent)],10)['stdout'])
    assert len(initial)==1 and initial[0]['format']=='qcow2' and initial[0]['virtual-size']==M['bytes'] and not initial[0].get('backing-filename')
    overlay_creating=True
    command('createPrivateClientCow',[M['qemuImg'],'create','-f','qcow2','-F','qcow2','-b',str(parent),str(overlay)],10)
    st=overlay.stat();overlay_identity=(st.st_dev,st.st_ino);overlay_creating=False
    record('CREATED-COW.json',{'path':str(overlay),'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size,'initialSha256':sha(overlay)})
    info=json.loads(command('backingChain',[M['qemuImg'],'info','--output=json','--backing-chain',str(overlay)],10)['stdout'])
    assert len(info)==2 and all(x['format']=='qcow2' and x['virtual-size']==M['bytes'] for x in info)
    assert info[0].get('full-backing-filename',info[0].get('backing-filename'))==str(parent) and info[1]['filename']==str(parent) and not info[1].get('backing-filename')
    setup="import pathlib,os;os.umask(0o077);pathlib.Path("+repr(M['uploadDirectory'])+").mkdir(mode=0o700);pathlib.Path("+repr(str(Path(M['remoteSocket']).parent))+").mkdir(mode=0o700)"
    r=capture([*sshargs(),M['target'],'/usr/bin/python3 -B -'],8,stdin=setup.encode(),limit=4096);results['uploadDirectory']=r;assert r['rc']==0 and not r['reason']
    sources={name:row['localSource'] for name,row in M['payloadFiles'].items()};sources['program.py']=str(P/'remote-program.py');sources['nbd-client']=M['localNbdClient']
    for name,source in sources.items():
        command('upload:'+name,['/usr/bin/scp','-q',*sshargs()[1:],source,M['target']+':'+M['uploadDirectory']+'/'+name],60)
    bootstrap();start_export();remote_attempted=True
    value=remote('main');record('TRIAL-OBSERVATION.json',value);main_completed=True
try:
    run()
except Exception as e:errors.append(type(e).__name__+':'+str(e)[:200])
finally:
    cleaning=True;cleaned=False
    if remote_attempted:
        try:
            if not main_completed:request_stop()
            # Verification shares the independent guardian128MiB budget, never adds a fourth budget.
            value=remote('verify');assert value.get('remoteCleanupVerified') is True
            stop(tunnel)
            value=remote('socket-clear');cleaned=value.get('socketClosedVerified') is True
        except Exception as e:errors.append('independent-cleanup:'+type(e).__name__+':'+str(e)[:180])
    for row in reversed(owned):
        try:stop(row)
        except Exception as e:errors.append('local-cleanup:'+type(e).__name__)
    if lockfd is not None:
        try:parent_identity();header_pin()
        except Exception as e:errors.append('parent-final:'+type(e).__name__)
        if remote_attempted and not cleaned:errors.append('PRIVATE_COW_CLEANUP_UNPROVEN_NO_PRODUCTION_ADMISSION')
        os.close(lockfd)
    if workflow is not None:os.close(workflow)
    if (P/'ATTEMPT.json').exists():
        try:verify()
        except Exception as e:errors.append('input-drift:'+type(e).__name__)
        status='BOUNDED_L1_START_STOP_OBSERVED_NOT_PRODUCTION_READY' if not errors and cleaned and main_completed else 'CLIENT_TRIAL_FAILED_NO_RETRY'
        record('RESULT.json',{'status':status,'errors':errors,'results':results,'remoteCleanupVerified':cleaned,'parentUnchanged':not any(x.startswith('parent-final:') for x in errors),'privateCowRetained':str(overlay),'productionReady':False,'consumerChanged':False,'baseStarted':False})
        print(json.dumps({'status':status,'errors':errors,'remoteCleanupVerified':cleaned}))
    else:print(json.dumps({'status':'REFUSED_BEFORE_TRIAL','errors':errors}))
sys.exit(0 if not errors and cleaned and main_completed else 2)
