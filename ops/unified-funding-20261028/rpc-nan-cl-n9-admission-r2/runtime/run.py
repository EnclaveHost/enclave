"""Bounded read-command capture; source only until root admission."""
import os, selectors, signal, subprocess, time

CAPTURE_GUARD=None
def capture(argv, seconds, stdin=None, limit=1048576, on_stdout=None):
    started = time.monotonic()
    deadline = started + seconds
    child = None; sel = None; rc = None; reason = None; sent = 0; deadline_exceeded = False
    cleanup_errors = []; group_signal = False; child_reaped = False
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    totals = {'stdout': 0, 'stderr': 0}
    payload = memoryview(stdin) if stdin is not None else None

    def retain(name, data):
        nonlocal reason
        if name == "stdout" and on_stdout is not None: on_stdout(data)
        totals[name] += len(data)
        buffers[name].extend(data[:max(0, limit - len(buffers[name]))])
        if totals[name] > limit: reason = reason or 'output-limit'

    def exited_unreaped():
        # WNOWAIT keeps the child PID reserved. No poll()/wait() precedes group cleanup.
        info = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        return info is not None and info.si_pid == child.pid

    def close_registered(stream):
        sel.unregister(stream)
        stream.close()  # unbuffered pipe: close cannot flush unsent stdin

    try:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, bufsize=0)
        sel = selectors.DefaultSelector()
        for name in buffers:
            stream = getattr(child, name)
            os.set_blocking(stream.fileno(), False)
            sel.register(stream, selectors.EVENT_READ, name)
        if payload is not None:
            os.set_blocking(child.stdin.fileno(), False)
            if len(payload): sel.register(child.stdin, selectors.EVENT_WRITE, 'stdin')
            else: child.stdin.close()
        while True:
            if CAPTURE_GUARD is not None: CAPTURE_GUARD()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                deadline_exceeded = True; reason = reason or 'timeout'; break
            if exited_unreaped() and not sel.get_map(): break
            for key, _ in sel.select(min(0.1, remaining)):
                if key.data == 'stdin':
                    try:
                        count = os.write(key.fileobj.fileno(), payload[sent:sent+65536])
                    except (BlockingIOError, InterruptedError):
                        continue
                    except BrokenPipeError:
                        # Remote/authentication rejection may close stdin first: still drain its diagnostics.
                        reason = reason or 'stdin-broken-pipe'
                        close_registered(key.fileobj)
                        continue
                    if count <= 0: raise OSError('stdin-write-made-no-progress')
                    sent += count
                    if sent == len(payload): close_registered(key.fileobj)
                else:
                    try: data = os.read(key.fileobj.fileno(), 65536)
                    except (BlockingIOError, InterruptedError): continue
                    if not data:
                        close_registered(key.fileobj); continue
                    retain(key.data, data)
                if any(totals[n] > limit for n in totals): break
            if any(totals[n] > limit for n in totals): break
    except Exception as e:
        reason = reason or ('capture-error:' + type(e).__name__)
    finally:
        if child is not None:
            # Includes stdin/setup/selector failures and normal exit with leftover pipe holders.
            # This routine is the sole reaper; WNOWAIT confirms child ownership before killpg.
            try:
                exited_unreaped()
                try:
                    os.killpg(child.pid, signal.SIGKILL); group_signal = True
                except ProcessLookupError:
                    pass
            except ChildProcessError:
                cleanup_errors.append('child-already-reaped-no-group-signal')
            except Exception as e:
                cleanup_errors.append('group-cleanup:' + type(e).__name__)
            # Drain available public diagnostics even if selector setup failed. Never wait here.
            for name in buffers:
                stream = getattr(child, name, None)
                if stream is None or stream.closed: continue
                try:
                    os.set_blocking(stream.fileno(), False)
                    while totals[name] <= limit:
                        try: data = os.read(stream.fileno(), min(65536, limit+1-totals[name]))
                        except (BlockingIOError, InterruptedError): break
                        if not data: break
                        retain(name, data)
                except Exception as e:
                    cleanup_errors.append('drain-' + name + ':' + type(e).__name__)
            if sel is not None:
                try: sel.close()
                except Exception as e: cleanup_errors.append('selector-close:' + type(e).__name__)
            for name in ('stdin', 'stdout', 'stderr'):
                stream = getattr(child, name, None)
                if stream is not None and not stream.closed:
                    try: stream.close()
                    except Exception as e: cleanup_errors.append('pipe-close:' + type(e).__name__)
            try:
                rc = child.wait(timeout=2); child_reaped = True
            except Exception as e:
                cleanup_errors.append('child-wait:' + type(e).__name__)
        elif sel is not None:
            try: sel.close()
            except Exception as e: cleanup_errors.append('selector-close:' + type(e).__name__)
    if cleanup_errors: reason = reason or 'local-cleanup-incomplete'
    return {'rc': rc, 'reason': reason, 'elapsedSeconds': time.monotonic() - started,
            'stdout': buffers['stdout'].decode('utf-8', 'replace'),
            'stderr': buffers['stderr'].decode('utf-8', 'replace'), 'bytesObserved': totals,
            'stdinBytesWritten': sent, 'stdinBytesRequested': len(payload) if payload is not None else 0,
            'truncated': any(totals[n] > limit for n in totals),
            'localChildReaped': child_reaped, 'ownedGroupKillAttempted': group_signal,
            'cleanupErrors': cleanup_errors, 'deadlineExceeded': deadline_exceeded,
            'localProcessGroupDeathProven': False,
            # Local SSH exit/kill never establishes the lifetime of a remote command.
            'remoteDeathProven': False}

# PREPARED ONLY. Root admission required; actual parent read-only, private persistent COW.
from pathlib import Path
import hashlib,json,fcntl,struct,stat,sys,resource
P=Path(__file__).resolve().parent;M=json.loads((P/'MANIFEST.json').read_text())
art=P/'artifacts';sockdir=Path('/run/user/1000/rpc-nan-client-n9')
parent=Path(M['parent']['path']);overlay=Path(M['overlayPath'])
exporter=None;tunnel=None;lockfd=None;remote_attempted=False;cut=False;workflow=None;main_completed=False;overlay_identity=None;overlay_creating=False
results={};errors=[];owned=[];cleaning=False;remote_calls={};preparation_deadline=None;main_phase=False;admission_metadata_hashes={}
def sha(p):
    with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def record(n,v):
    with (P/n).open('x') as f:json.dump(v,f,indent=2);f.write('\n')
def verify():
    for n,h in json.loads((P/'PINS.json').read_text()).items():assert sha(P/n)==h,'input-drift:'+n
    for row in json.loads((P/'EXTERNAL-PINS.json').read_text()):
        q=Path(row['path']);assert str(q.resolve())==row['realpath'] and q.stat().st_size==row['bytes'] and sha(q)==row['sha256'],'external-drift'
def validate_admission_metadata(admit, observation, observation_sha, now, manifest, pins_sha):
    # Root supplies only fresh metadata after source/runtime preparation and commit.
    # This is local reviewed admission, not a cryptographic remote authorization claim.
    a=admit['admission'];template=manifest['admission']
    assert template['authorized'] is False,'committed-manifest-must-be-unadmitted'
    assert admit['authorized'] is True and admit['scope']=='actual-nan-cl-bounded-client-n9','root-admission-scope'
    assert admit['nonce']==manifest['nonce'] and admit['bootId']==manifest['bootId'],'root-admission-identity'
    assert admit['pinsSha256']==pins_sha,'root-admission-pins'
    assert admit['observationSha256']==observation_sha,'root-observation-pin'
    assert admit['admissionSha256']==hashlib.sha256(json.dumps(a,sort_keys=True).encode()).hexdigest(),'root-admission-hash'
    for key in ('scope','nonce','osReserveMiB','creatorClassification'):
        assert a[key]==template[key],'admission-fixed-policy:'+key
    assert a['authorized'] is True and a['observedPendingMiB']>=0,'admission-policy'
    assert observation['readOnly'] is True and not observation['errors'] and observation['boot']==manifest['bootId'],'observation-identity'
    assert a['at']==observation['at']<=admit['at']<=now and now-admit['at']<=300,'admission-observation-order'
    assert a['at']<=now<a['expiresAt'] and 0<a['expiresAt']-a['at']<=2100,'stale-Nan-admission'
    assert a['expiresAt']-now>=2010,'fresh-admission-headroom-at-load'
    for key in ('scheduleFiles','scheduleDirectories','timerConfigFiles','timerUnitPaths','creatorClassification'):
        assert a[key]==observation[key],'admission-observation-mismatch:'+key
    timer_rows=sorted([line.split()[-2:],line.split()[:4] if line.split()[0]!='-' else ['-']] for line in observation['timers']['stdout'].splitlines() if line.strip())
    assert a['timerRows']==timer_rows,'admission-timer-rows'
    return a

def load_fresh_admission():
    global admission_metadata_hashes
    values={}
    for name in ('ROOT-ADMISSION.json','FRESH-OBSERVATION.json'):
        q=P/name;fd=os.open(q,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        with os.fdopen(fd,'rb') as f:
            st=os.fstat(f.fileno())
            assert stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and not st.st_mode&0o022 and st.st_nlink==1 and st.st_size<=1048576,'admission-metadata-authority'
            raw=f.read(1048577);assert len(raw)==st.st_size,'admission-metadata-size'
            end=os.fstat(f.fileno());pathst=q.lstat()
            for attr in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode','st_uid','st_nlink'):
                assert getattr(st,attr)==getattr(end,attr)==getattr(pathst,attr),'admission-metadata-drift'
        admission_metadata_hashes[name]=hashlib.sha256(raw).hexdigest();values[name]=json.loads(raw)
    admit=values['ROOT-ADMISSION.json']
    M['admission']=validate_admission_metadata(admit,values['FRESH-OBSERVATION.json'],admission_metadata_hashes['FRESH-OBSERVATION.json'],time.time(),M,sha(P/'PINS.json'))
    return admit

def guard():
    if cleaning:return
    for name,h in admission_metadata_hashes.items():assert sha(P/name)==h,'fresh-metadata-drift'
    if preparation_deadline is not None and not main_phase:
        assert time.time()<=preparation_deadline,'preparation-time-budget'
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
P=pathlib.Path;root=P('/run/enclave-rpc-nan-client-n9');os.umask(0o077)
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
unit=P('/run/systemd/system/enclavenanattachn9.slice');assert not unit.exists()
for name in ('enclavenanattachn9.slice','enclavenantrialn9.slice','enclavenanguardn9.slice','enclave-rpc-nan-helper-n9.service','enclave-rpc-nan-watch-n9.service','enclave-rpc-nan-nbd-n9.service','enclave-rpc-nan-cl-trial-n9.service'):
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
    command='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit=enclave-rpc-nan-bootstrap-n9 --property=User=root --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=AllowedCPUs=1 --property=RuntimeMaxSec=40 --property=TimeoutStopSec=10 --property=UMask=0077 /usr/bin/python3 -B -'
    r=capture([*sshargs(),M['target'],command],55,stdin=script.encode(),limit=65536);results['bootstrap']=r
    record('BOOTSTRAP.json',r);assert r['rc']==0 and not r['reason'] and not r['truncated'],'bootstrap'
def remote(action):
    if action=='main':
        unit='enclave-rpc-nan-helper-n9';slice_name='enclavenanattachn9.slice';runtime=2100;stop_seconds=145;seconds=2255
        post=" '--property=ExecStopPost=/usr/bin/python3 -B /run/enclave-rpc-nan-client-n9/program.py wait-cleanup'"
    elif action=='verify':
        unit='enclave-rpc-nan-verify-n9';slice_name='enclavenanguardn9.slice';runtime=45;stop_seconds=10;seconds=60;post=''
    else:
        unit='enclave-rpc-nan-'+action+'-n9';slice_name='enclavenanguardn9.slice';runtime=10;stop_seconds=5;seconds=20;post=''
    command='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit='+unit+' --slice='+slice_name+' --property=User=root --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=TasksMax=64 --property=RuntimeMaxSec='+str(runtime)+' --property=TimeoutStopSec='+str(stop_seconds)+' --property=KillMode=control-group --property=UMask=0077'+post+' /usr/bin/python3 -B /run/enclave-rpc-nan-client-n9/program.py '+action
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
    global lockfd,workflow,remote_attempted,main_completed,overlay_identity,overlay_creating,preparation_deadline,main_phase
    os.umask(0o077);verify()
    admit=load_fresh_admission()
    preparation_deadline=admit['at']+90
    assert os.sched_getaffinity(0)=={1}
    cg=Path('/proc/self/cgroup').read_text().strip();assert cg.startswith('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-') and cg.endswith('.scope')
    c=Path('/sys/fs/cgroup'+cg[3:]);assert (c/'memory.max').read_text().strip()==str(512<<20) and (c/'memory.swap.max').read_text().strip()=='0'
    guard();parent_identity();header_pin()
    assert not overlay.parent.exists(),'client-COW-directory-preexists'
    record('ATTEMPT.json',{'at':time.time(),'scope':cg,'pinsSha256':sha(P/'PINS.json'),'privateCowOnly':True,'noRetry':True,'admissionMetadataSha256':dict(admission_metadata_hashes)})
    art.mkdir(mode=0o700);sockdir.mkdir(mode=0o700);overlay.parent.mkdir(mode=0o700)
    assert overlay.parent.stat().st_dev==M['parent']['device']
    resource.setrlimit(resource.RLIMIT_FSIZE,(8<<30,8<<30))
    workflow=os.open(overlay.parent/'client-trial-n9.lock',os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_CLOEXEC,0o600);fcntl.flock(workflow,fcntl.LOCK_EX|fcntl.LOCK_NB)
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
    reuse={'name': 'lighthouse', 'source': '/var/lib/enclave-rpc-nan-client-n5/payload/bin/lighthouse', 'bytes': 105018160, 'sha256': '11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96'}
    assert M.get('remoteBinaryReuse')==reuse,'retained-binary-policy'
    row=M['payloadFiles']['lighthouse']
    assert row['destination']=='bin/lighthouse' and row['bytes']==reuse['bytes'] and row['sha256']==reuse['sha256'],'retained-binary-payload-binding'
    sources={name:row['localSource'] for name,row in M['payloadFiles'].items() if name!='lighthouse'}
    sources['program.py']=str(P/'remote-program.py');sources['nbd-client']=M['localNbdClient']
    for name,source in sources.items():
        command('upload:'+name,['/usr/bin/scp','-q',*sshargs()[1:],source,M['target']+':'+M['uploadDirectory']+'/'+name],60)
    bootstrap();start_export();guard()
    assert M['admission']['expiresAt']-time.time()>=2010,'fresh-admission-headroom-before-main'
    remote_attempted=True;main_phase=True
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
        try:
            verify()
            for name,h in admission_metadata_hashes.items():assert sha(P/name)==h,'fresh-metadata-drift'
        except Exception as e:errors.append('input-drift:'+type(e).__name__)
        status='BOUNDED_L1_START_STOP_OBSERVED_NOT_PRODUCTION_READY' if not errors and cleaned and main_completed else 'CLIENT_TRIAL_FAILED_NO_RETRY'
        record('RESULT.json',{'status':status,'errors':errors,'results':results,'remoteCleanupVerified':cleaned,'parentUnchanged':not any(x.startswith('parent-final:') for x in errors),'privateCowRetained':str(overlay),'productionReady':False,'consumerChanged':False,'baseStarted':False})
        print(json.dumps({'status':status,'errors':errors,'remoteCleanupVerified':cleaned}))
    else:print(json.dumps({'status':'REFUSED_BEFORE_TRIAL','errors':errors}))
sys.exit(0 if not errors and cleaned and main_completed else 2)
