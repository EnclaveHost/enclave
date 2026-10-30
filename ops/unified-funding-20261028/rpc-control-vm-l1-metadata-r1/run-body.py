# PREPARED ONLY. Root admission required; actual parent read-only, private persistent COW.
from pathlib import Path
import hashlib,json,fcntl,struct,stat,sys,resource
P=Path(__file__).resolve().parent;M=json.loads((P/'MANIFEST.json').read_text())
art=Path(M['overlayDirectory']);sockdir=Path('/run/user/1000/rpc-l1-metadata-r1')
parent=Path(M['parent']['path']);overlay=art/'overlay.qcow2'
exporter=None;tunnel=None;lockfd=None;remote_attempted=False;cut=False
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
    fs=os.statvfs(art.parent);assert fs.f_bavail*fs.f_frsize>=300000000000,'nvme-disk-floor'
    if art.exists():
        used=sum(q.stat().st_blocks*512 for q in art.iterdir() if q.is_file())
        assert used<=128<<20,'metadata-overlay-disk-cap'
        for q in art.glob('*.log'):assert q.stat().st_size<=1<<20,'log-cap'
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
      '-oControlMaster=no','-oControlPath=none','-oServerAliveInterval=5','-oServerAliveCountMax=2',
      '-oIdentitiesOnly=yes','-i','/home/steven/.ssh/minipc','-oProxyJump=minipc',
      '-oHostKeyAlias=[127.0.0.1]:32423','-oUserKnownHostsFile='+M['knownHosts']]
def remote(action):
    remote_calls[action]=remote_calls.get(action,0)+1
    call_name=action+('-'+str(remote_calls[action]) if action=='socket-clear' else '')
    prefix=(P/'capture-remote.py').read_text()+'\nMANIFEST_JSON='+repr(json.dumps(M))+'\n'
    body=(P/'remote-body.py').read_text()
    script=prefix+'ACTION_VALUE='+repr(action)+'\n'
    if action=='bootstrap':script+='STOP_POST_SOURCE='+repr(prefix+"ACTION_VALUE='stop-post'\n"+body)+'\n'
    script+=body
    assert len(script.encode())<=131072
    unit='enclave-rpc-l1-metadata-'+call_name+'-r1'
    post=" '--property=ExecStopPost=/usr/bin/python3 -B /run/enclave-rpc-l1-metadata-r1/stop-post.py'" if action=='read' else ''
    cmd='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit='+unit+' --property=RuntimeMaxSec=55 --property=TimeoutStopSec=25 --property=MemoryMax=256M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=TasksMax=32 --property=KillMode=control-group --property=UMask=0077'+post+' /usr/bin/python3 -B -'
    r=capture([*sshargs(),M['target'],cmd],95,stdin=script.encode(),limit=1048576)
    results['remote:'+call_name]=r;record('REMOTE-'+call_name.upper()+'.json',r)
    assert r['rc']==0 and not r['reason'] and not r['truncated'],'remote:'+action
    lines=[l.removeprefix('RESULT_JSON=') for l in r['stdout'].splitlines() if l.startswith('RESULT_JSON=')]
    assert len(lines)==1;value=json.loads(lines[0]);assert value['ok'] and not value['errors'],'remote-result:'+action
    if action=='read':
        post=[json.loads(l.removeprefix('STOP_POST_JSON=')) for l in r['stdout'].splitlines() if l.startswith('STOP_POST_JSON=')]
        assert len(post)==1 and post[0]['ok'] and post[0].get('stopPostDetached') and not post[0]['errors'],'stop-post-not-proven'
    return value
def start_export(label):
    global exporter,tunnel
    socket=sockdir/'export.sock'
    # Remove only a closed socket from a previously owned exporter.
    if socket.exists():
        assert exporter and exporter['closed'] and stat.S_ISSOCK(socket.lstat().st_mode);socket.unlink()
    exporter=background('export-'+label,[M['qemuNbd'],'--read-only','--persistent','--shared=1','--socket',str(socket),
       '--export-name',M['exportName'],'--format=qcow2','--cache=none','--aio=threads',str(overlay)])
    until=time.monotonic()+5
    while not socket.exists() and time.monotonic()<until:guard();time.sleep(.1)
    assert stat.S_ISSOCK(socket.lstat().st_mode);socket.chmod(0o600)
    tunnel=background('tunnel-'+label,[*sshargs(),'-N','-oExitOnForwardFailure=yes','-oStreamLocalBindMask=0177',
       '-oStreamLocalBindUnlink=no','-R',M['remoteSocket']+':'+str(socket),M['target']])
    # Root remote action checks actual socket mode, export identity and size.
    time.sleep(1);guard()
def stop_export():
    stop(tunnel);stop(exporter)
def parent_identity():
    q=parent.lstat();row=M['parent']
    assert not parent.is_symlink() and [q.st_dev,q.st_ino,q.st_size,q.st_mtime_ns,q.st_ctime_ns,q.st_mode]==[row[k] for k in ('device','inode','bytes','mtimeNs','ctimeNs','mode')],'parent-identity-drift'
    if lockfd is not None:
        f=os.fstat(lockfd);assert (f.st_dev,f.st_ino)==(q.st_dev,q.st_ino),'held-parent-path-drift'
    return {'device':q.st_dev,'inode':q.st_ino,'bytes':q.st_size,'mtimeNs':q.st_mtime_ns,'ctimeNs':q.st_ctime_ns}
def header_pin():
    with parent.open('rb') as f:b=f.read(104)
    assert len(b)==104 and hashlib.sha256(b).hexdigest()==M['parent']['header104Sha256'],'parent-header-drift'
    magic,version,backing,backing_size,bits,nbytes=struct.unpack_from('>IIQIIQ',b)
    assert magic==0x514649fb and version==3 and backing==0 and backing_size==0 and nbytes==M['bytes'],'unexpected-parent-layout'
def run():
    global lockfd,remote_attempted
    os.umask(0o077);verify()
    a=json.loads((P/'ROOT-ADMISSION.json').read_text())
    assert a['authorized'] is True and a['scope']=='actual-l1-cow-metadata-r1' and a['pinsSha256']==sha(P/'PINS.json') and 0<=time.time()-a['at']<=300
    assert os.sched_getaffinity(0)=={1} and os.uname().machine=='x86_64'
    cg=Path('/proc/self/cgroup').read_text().strip();assert cg.startswith('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-') and cg.endswith('.scope')
    c=Path('/sys/fs/cgroup'+cg[3:]);assert (c/'memory.max').read_text().strip()==str(512<<20) and (c/'memory.swap.max').read_text().strip()=='0'
    guard();parent_identity();header_pin()
    record('ATTEMPT.json',{'at':time.time(),'scope':cg,'pinsSha256':sha(P/'PINS.json'),'originalReadOnly':True,'clientStart':False,'noRetry':True})
    art.mkdir(mode=0o700);sockdir.mkdir(mode=0o700)
    assert art.stat().st_dev==M['parent']['device'],'overlay-not-on-parent-filesystem'
    resource.setrlimit(resource.RLIMIT_FSIZE,(96<<20,96<<20))
    lockfd=os.open(parent,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    for byte in (201,202,203):fcntl.fcntl(lockfd,fcntl.F_OFD_SETLK,struct.pack('@hhqqi4x',fcntl.F_RDLCK,os.SEEK_SET,byte,1,0))
    occupied=fcntl.fcntl(lockfd,fcntl.F_OFD_GETLK,struct.pack('@hhqqi4x',fcntl.F_WRLCK,os.SEEK_SET,100,200,0))
    assert struct.unpack('@hhqqi4x',occupied)[0]==fcntl.F_UNLCK,'competing-qemu-holder'
    parent_identity();header_pin()
    r=command('parentInfo',[M['qemuImg'],'info','--output=json','--backing-chain',str(parent)],10)
    chain=json.loads(r['stdout']);assert isinstance(chain,list) and len(chain)==1
    info=chain[0];assert info['format']=='qcow2' and info['virtual-size']==M['bytes'] and not info.get('backing-filename') and not info.get('encrypted')
    assert not (info.get('format-specific',{}).get('data',{}).get('data-file')),'external-data-file-not-admitted'
    command('createPrivateOverlay',[M['qemuImg'],'create','-f','qcow2','-F','qcow2','-b',str(parent),str(overlay)],10)
    r=command('overlayInfo',[M['qemuImg'],'info','--output=json','--backing-chain',str(overlay)],10)
    chain=json.loads(r['stdout']);assert len(chain)==2 and chain[0]['format']=='qcow2' and chain[0]['virtual-size']==M['bytes']
    assert chain[0].get('full-backing-filename',chain[0].get('backing-filename'))==str(parent) and chain[1]['filename']==str(parent) and chain[1]['format']=='qcow2'
    remote('policy')
    setup="import pathlib,os,json;os.umask(0o077);p=pathlib.Path("+repr(str(Path(M['remoteSocket']).parent))+");p.mkdir(mode=0o700);print(json.dumps({'path':str(p),'uid':p.stat().st_uid,'mode':oct(p.stat().st_mode&511)}))"
    r=capture([*sshargs(),M['target'],'/usr/bin/python3 -B -'],8,stdin=setup.encode(),limit=4096)
    results['remoteSocketDirectory']=r;assert r['rc']==0 and not r['reason']
    remote_attempted=True;remote('bootstrap');start_export('metadata')
    value=remote('read')
    record('MOUNTED-METADATA.json',value)
    raw=value['effectiveRethToml']['text'].encode()
    assert hashlib.sha256(raw).hexdigest()==value['effectiveRethToml']['sha256']
    with (P/'actual-reth.toml').open('xb') as f:f.write(raw)
    parent_identity();header_pin()
    results['parentIdentityAfterRead']=parent_identity()
try:
    run()
except Exception as e:errors.append(type(e).__name__+':'+str(e)[:220])
finally:
    cleaning=True;cleaned=False
    if remote_attempted:
        try:remote('cleanup');stop(tunnel);remote('verify');cleaned=True
        except Exception as e:errors.append('independent-cleanup:'+type(e).__name__+':'+str(e)[:180])
    for row in reversed(owned):
        try:stop(row)
        except Exception as e:errors.append('local-cleanup:'+type(e).__name__)
    if lockfd is not None:
        try:parent_identity();header_pin()
        except Exception as e:errors.append('parent-final:'+type(e).__name__)
        if remote_attempted and not cleaned:errors.append('REMOTE_CLEANUP_UNPROVEN_NO_CLIENT_ADMISSION')
        os.close(lockfd)
    if (P/'ATTEMPT.json').exists():
        try:verify()
        except Exception as e:errors.append('input-drift:'+type(e).__name__)
        status='ACTUAL_L1_METADATA_READ_NO_CLIENT_ADMISSION' if not errors and cleaned else 'METADATA_FAILED_NO_RETRY'
        record('RESULT.json',{'status':status,'errors':errors,'results':results,'remoteCleanupVerified':cleaned,'originalWritten':False,'chainClientsStarted':False,'overlayRetained':str(overlay),'productionChanged':False})
        print(json.dumps({'status':status,'errors':errors,'remoteCleanupVerified':cleaned}))
    else:print(json.dumps({'status':'REFUSED_BEFORE_METADATA','errors':errors}))
sys.exit(0 if not errors and cleaned else 2)
