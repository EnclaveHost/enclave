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

"""Local backing-chain validation helpers; no actions at import/assembly."""
import os,stat,hashlib,fcntl,struct,time,json
from pathlib import Path

def backing_fields(st):
    return {key:getattr(st,attr) for key,attr in (
        ('device','st_dev'),('inode','st_ino'),('bytes','st_size'),('mtimeNs','st_mtime_ns'),
        ('ctimeNs','st_ctime_ns'),('mode','st_mode'),('uid','st_uid'),('gid','st_gid'),('links','st_nlink'))}

def validate_frozen_receipt(receipt,manifest):
    row=manifest['frozenBacking']
    assert row['path']==receipt['path']==manifest['recoveryBackingPath'],'backing-path-policy'
    mapping={'device':'st_dev','inode':'st_ino','bytes':'st_size','mtimeNs':'st_mtime_ns','ctimeNs':'st_ctime_ns','mode':'st_mode','uid':'st_uid','gid':'st_gid','links':'st_nlink'}
    for key,field in mapping.items():assert row[key]==receipt['identity'][field],'backing-receipt-identity'
    assert stat.S_ISREG(row['mode']) and not row['mode']&0o022 and row['links']==1 and row['uid'] in (0,os.geteuid()),'backing-file-policy'
    assert receipt['readOnly'] is True and receipt['qemuCompatibleLocksHeldDuringHash'] is True,'backing-evidence-policy'
    assert receipt['bytesHashed']==row['bytes']>0 and receipt['allocatedBytes']<=7<<30,'backing-evidence-size'
    for key in ('sha256','header104Sha256'):
        digest=row[key];assert digest==receipt[key] and len(digest)==64 and all(c in '0123456789abcdef' for c in digest),'backing-content-pin'
    assert row['parents']==receipt['parents'],'backing-parent-evidence'
    assert row['device']==manifest['parent']['device'],'backing-filesystem-policy'
    return row

def backing_identity(row,fd=None):
    path=Path(row['path'])
    assert path.is_absolute() and str(path)==str(path.resolve(strict=True)),'backing-canonical-path'
    for q in [path,*path.parents]:
        st=q.lstat();assert not stat.S_ISLNK(st.st_mode),'backing-symlink'
        if q!=path:assert stat.S_ISDIR(st.st_mode) and st.st_uid in (0,os.geteuid()) and not st.st_mode&0o022,'backing-directory-authority'
    st=path.lstat();actual=backing_fields(st)
    assert stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid in (0,os.geteuid()) and not st.st_mode&0o022,'backing-live-authority'
    assert all(actual[k]==row[k] for k in actual if k in row),'backing-identity-drift'
    for name,identity in row.get('parents',{}).items():
        v=Path(name).lstat();assert [v.st_dev,v.st_ino,v.st_uid,v.st_mode]==identity,'backing-parent-drift'
    if fd is not None:assert backing_fields(os.fstat(fd))==actual,'backing-fd-drift'
    return actual

def backing_header(row,fd):
    raw=os.pread(fd,104,0)
    assert len(raw)==104 and hashlib.sha256(raw).hexdigest()==row['header104Sha256'],'backing-header-drift'

def lock_backing(row,held):
    backing_identity(row)
    fd=os.open(row['path'],os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    # Register immediately so partial lock acquisition is always unwound by caller.
    held.append((row,fd));backing_identity(row,fd)
    for byte in (201,202,203):
        fcntl.fcntl(fd,fcntl.F_OFD_SETLK,struct.pack('@hhqqi4x',fcntl.F_RDLCK,os.SEEK_SET,byte,1,0))
    occupied=fcntl.fcntl(fd,fcntl.F_OFD_GETLK,struct.pack('@hhqqi4x',fcntl.F_WRLCK,os.SEEK_SET,100,200,0))
    assert struct.unpack('@hhqqi4x',occupied)[0]==fcntl.F_UNLCK,'backing-writer-conflict'
    backing_identity(row,fd);backing_header(row,fd)
    return fd

def verify_frozen_hash(row,fd,tick,seconds=10):
    assert 'sha256' in row,'frozen-full-hash-required'
    until=time.monotonic()+seconds;digest=hashlib.sha256();offset=0
    while offset<row['bytes']:
        tick();assert time.monotonic()<until,'backing-hash-time-bound'
        raw=os.pread(fd,min(1<<20,row['bytes']-offset),offset);assert raw,'backing-hash-short-read'
        digest.update(raw);offset+=len(raw)
    assert digest.hexdigest()==row['sha256'],'backing-full-hash-drift'
    backing_identity(row,fd);return {'fullHashChecked':True,'bytes':offset,'sha256':digest.hexdigest()}

def validate_backing_chain(info,expected_paths,virtual_bytes):
    assert isinstance(info,list) and len(info)==len(expected_paths),'backing-chain-length'
    for i,(entry,path) in enumerate(zip(info,expected_paths)):
        assert entry['filename']==path and entry['format']=='qcow2' and entry['virtual-size']==virtual_bytes,'backing-chain-identity'
        assert not entry.get('encrypted',False),'encrypted-backing-unexpected'
        assert entry.get('dirty-flag') is False,'dirty-backing-unexpected'
        children=entry.get('children',[])
        assert len(children)==1 and children[0]['name']=='file','unexpected-backing-children'
        child=children[0]['info']
        assert child['filename']==path and child['format']=='file' and not child.get('children') and not child.get('backing-filename'),'external-backing-child'
        data=entry.get('format-specific',{}).get('data',{})
        assert data.get('corrupt') is False,'corrupt-backing-unexpected'
        assert not any(k in data for k in ('data-file','data-file-raw','encrypt')),'external-backing-data'
        assert not any(k in entry for k in ('data-file','data-file-raw')),'external-backing-data'
        if i+1<len(expected_paths):
            assert entry.get('backing-filename')==expected_paths[i+1],'backing-path-mismatch'
            assert entry.get('full-backing-filename',entry.get('backing-filename'))==expected_paths[i+1],'backing-resolved-path-mismatch'
            assert entry.get('backing-filename-format')=='qcow2','backing-format-mismatch'
        else:assert not entry.get('backing-filename') and not entry.get('full-backing-filename'),'unexpected-ancestor'
    return True

# PREPARED ONLY. Root admission required; actual parent read-only, private persistent COW.
from pathlib import Path
import hashlib,json,fcntl,struct,stat,sys,resource
P=Path(__file__).resolve().parent;M=json.loads((P/'MANIFEST.json').read_text())
art=P/'artifacts';sockdir=Path('/run/user/1000/rpc-l1-client-r8')
parent=Path(M['parent']['path']);overlay=Path(M['overlayPath'])
exporter=None;tunnel=None;lockfd=None;remote_attempted=False;cut=False;workflow=None;main_completed=False;overlay_identity=None;overlay_creating=False
results={};errors=[];owned=[];cleaning=False;remote_calls={};backing_locks=[];preparation_deadline=None;main_phase=False
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
    if preparation_deadline is not None and not main_phase:assert time.time()<=preparation_deadline,'preparation-time-budget'
    if backing_locks:parent_identity()
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
      '-oControlMaster=no','-oControlPath=none','-oServerAliveInterval=5','-oServerAliveCountMax=2',
      '-oIdentitiesOnly=yes','-i','/home/steven/.ssh/minipc','-oProxyJump=minipc',
      '-oHostKeyAlias=[127.0.0.1]:32423','-oUserKnownHostsFile='+M['knownHosts']]

def parent_identity():
    if backing_locks:
        for row,fd in backing_locks:backing_identity(row,fd)
    else:
        backing_identity(M['parent']);backing_identity(M['frozenBacking'])
def header_pin():
    for row,fd in backing_locks:backing_header(row,fd)
def bootstrap():
    common=(P/'capture-remote.py').read_text()
    body=r"""
import pathlib,json,hashlib,stat,sys
P=pathlib.Path;root=P('/run/enclave-rpc-l1-client-r8');os.umask(0o077)
assert os.geteuid()==0
assert P('/proc/sys/kernel/random/boot_id').read_text().strip()==M['bootId']
assert os.statvfs('/var/lib').f_bavail*os.statvfs('/var/lib').f_frsize>=8<<30
assert not root.exists()
available=next(int(l.split()[1])*1024 for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
growth=0
for name,mib in M['serviceCapsMiB'].items():
 c=P('/sys/fs/cgroup/system.slice')/name;maximum=int((c/'memory.max').read_text());current=int((c/'memory.current').read_text())
 assert maximum==mib*(1<<20),'existing-service-cap-changed'
 growth+=max(0,maximum-current)
assert available-growth-(2560<<20)>=(1536<<20),'pre-bootstrap-headroom'
program=P(M['uploadDirectory'])/'program.py';st=program.lstat()
assert stat.S_ISREG(st.st_mode) and st.st_size<=131072
raw=program.read_bytes();assert hashlib.sha256(raw).hexdigest()==M['programSha256']
unit=P('/run/systemd/system/enclavel1attachr8.slice');assert not unit.exists()
for name in ('enclavel1attachr8.slice','enclavel1trialr8.slice','enclavel1guardianr8.slice','enclave-rpc-l1-helper-r8.service','enclave-rpc-l1-watch-r8.service','enclave-rpc-l1-nbd-r8.service','enclave-rpc-l1-el-trial-r8.service','enclave-rpc-l1-cl-trial-r8.service'):
 r=capture(['/usr/bin/systemctl','show',name,'--property=LoadState,ActiveState,FragmentPath,DropInPaths,ControlGroup,InvocationID,Transient'],3,limit=4096);assert not r['reason'] and not r['truncated'],'unit-observation-failed'
 info=dict(line.split('=',1) for line in r['stdout'].splitlines() if '=' in line)
 if name.endswith('.slice'):
  assert info.get('LoadState') in ('loaded','not-found') and info.get('ActiveState')=='inactive' and info.get('Transient')=='no' and not any(info.get(k) for k in ('FragmentPath','DropInPaths','ControlGroup','InvocationID')),'preexisting-trial-slice'
 else:assert info.get('LoadState')=='not-found','preexisting-trial-service'
root.mkdir(mode=0o700)
with (root/'manifest.json').open('x') as f:json.dump(M,f);f.flush();os.fsync(f.fileno())
with (root/'program.py').open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
(root/'program.py').chmod(0o700)
with unit.open('x') as f:f.write('[Unit]\nDescription=Private L1 attachment budget\n[Slice]\nMemoryMax=128M\nMemorySwapMax=0\nCPUQuota=100%\nAllowedCPUs=1\nTasksMax=128\n')
for argv in (['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start','enclavel1attachr8.slice']):
 r=capture(argv,5,limit=16384);assert r['rc']==0 and not r['reason']
assert (P('/sys/fs/cgroup/enclavel1attachr8.slice/memory.max').read_text().strip())==str(128<<20)
print(json.dumps({'root':str(root),'programSha256':M['programSha256'],'sliceMaximum':128<<20,'clientStarted':False}))
"""
    script=common+'\nM='+repr(M)+'\n'+body
    command='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit=enclave-rpc-l1-bootstrap-r8 --property=User=root --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=AllowedCPUs=1 --property=RuntimeMaxSec=40 --property=TimeoutStopSec=10 --property=UMask=0077 /usr/bin/python3 -B -'
    r=capture([*sshargs(),M['target'],command],55,stdin=script.encode(),limit=65536);results['bootstrap']=r
    record('BOOTSTRAP.json',r);assert r['rc']==0 and not r['reason'] and not r['truncated'],'bootstrap'
def remote(action):
    if action=='main':
        unit='enclave-rpc-l1-helper-r8';slice_name='enclavel1attachr8.slice';runtime=1200;stop_seconds=145;seconds=1365
        post=" '--property=ExecStopPost=/usr/bin/python3 -B /run/enclave-rpc-l1-client-r8/program.py wait-cleanup'"
    elif action=='verify':
        unit='enclave-rpc-l1-verify-r8';slice_name='enclavel1guardianr8.slice';runtime=130;stop_seconds=10;seconds=145;post=''
    else:
        unit='enclave-rpc-l1-'+action+'-r8';slice_name='enclavel1guardianr8.slice';runtime=20;stop_seconds=5;seconds=30;post=''
    command='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit='+unit+' --slice='+slice_name+' --property=User=root --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=TasksMax=64 --property=RuntimeMaxSec='+str(runtime)+' --property=TimeoutStopSec='+str(stop_seconds)+' --property=KillMode=control-group --property=UMask=0077'+post+' /usr/bin/python3 -B /run/enclave-rpc-l1-client-r8/program.py '+action
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
    prior=M['previousTrial'];prior_dir=Path(prior['directory'])
    for name,key in (('PINS.json','pinsSha256'),('RESULT.json','resultSha256'),('ROOT-TERMINAL.json','terminalSha256')):
        assert sha(prior_dir/name)==prior[key],'previous-trial-evidence-drift'
    prior_result=json.loads((prior_dir/'RESULT.json').read_text());prior_terminal=json.loads((prior_dir/'ROOT-TERMINAL.json').read_text())
    assert prior_result['parentUnchanged'] is True and prior_result['remoteCleanupVerified'] is True,'previous-trial-cleanup-unproven'
    assert not prior_terminal['knownAlive'] and not prior_terminal['contentDrift'] and prior_terminal['remoteCleanupVerified'] is True,'previous-trial-not-terminal'
    provenance=M['retainedAccountProvenance'];previous=Path(provenance['sourceDirectory'])
    for name,key in (('PARSED-MAIN.json','parsedMainSha256'),('RESULT.json','resultSha256'),('ROOT-TERMINAL.json','terminalSha256')):
        assert sha(previous/name)==provenance[key],'prior-account-provenance-drift'
    previous_main=json.loads((previous/'PARSED-MAIN.json').read_text())
    previous_result=json.loads((previous/'RESULT.json').read_text())
    previous_terminal=json.loads((previous/'ROOT-TERMINAL.json').read_text())
    assert previous_main['cleanup']['ok'] is True and previous_main['cleanup']['retainedAccounts']==provenance['retainedAccounts'],'prior-account-creation-unproven'
    assert previous_result['parentUnchanged'] is True and previous_result['remoteCleanupVerified'] is True,'prior-client-cleanup-unproven'
    assert not previous_terminal['knownAlive'] and not previous_terminal['contentDrift'] and previous_terminal['remoteCleanupVerified'] is True,'prior-terminal-unproven'
    admit=json.loads((P/'ROOT-ADMISSION.json').read_text())
    assert admit['authorized'] is True and admit['scope']=='actual-l1-el-only-bounded-client-r8' and admit['pinsSha256']==sha(P/'PINS.json') and 0<=time.time()-admit['at']<=300
    assert admit['reviewedHorizonSeconds']==1800,'unreviewed-recovery-horizon'
    fresh=P/'ROOT-FRESH-OBSERVATION.json';assert sha(fresh)==admit['freshObservationSha256'],'fresh-observation-pin'
    observed=json.loads(fresh.read_text())
    assert observed['boot']==M['bootId'] and observed['at']<=admit['at'] and 0<=time.time()-observed['at']<=90,'stale-fresh-observation'
    preparation_deadline=admit['at']+90
    evidence=json.loads(Path(M['frozenBackingEvidence']['path']).read_text())
    validate_frozen_receipt(evidence,M)
    validate_backing_chain(json.loads(Path(M['frozenChainEvidence']['path']).read_text()),[M['recoveryBackingPath'],str(parent)],M['bytes'])
    assert os.sched_getaffinity(0)=={1}
    cg=Path('/proc/self/cgroup').read_text().strip();assert cg.startswith('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-') and cg.endswith('.scope')
    c=Path('/sys/fs/cgroup'+cg[3:]);assert (c/'memory.max').read_text().strip()==str(512<<20) and (c/'memory.swap.max').read_text().strip()=='0'
    guard();parent_identity();header_pin()
    assert not overlay.parent.exists(),'client-COW-directory-preexists'
    record('ATTEMPT.json',{'at':time.time(),'scope':cg,'pinsSha256':sha(P/'PINS.json'),'privateCowOnly':True,'noRetry':True})
    art.mkdir(mode=0o700);sockdir.mkdir(mode=0o700);overlay.parent.mkdir(mode=0o700)
    assert overlay.parent.stat().st_dev==M['parent']['device']
    resource.setrlimit(resource.RLIMIT_FSIZE,(8<<30,8<<30))
    workflow=os.open(overlay.parent/'client-trial-r8.lock',os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_CLOEXEC,0o600);fcntl.flock(workflow,fcntl.LOCK_EX|fcntl.LOCK_NB)
    lockfd=lock_backing(M['parent'],backing_locks)
    frozenfd=lock_backing(M['frozenBacking'],backing_locks)
    results['frozenBackingHashBefore']=verify_frozen_hash(M['frozenBacking'],frozenfd,guard)
    initial=json.loads(command('frozenBackingChain',[M['qemuImg'],'info','--output=json','--backing-chain',M['recoveryBackingPath']],10)['stdout'])
    validate_backing_chain(initial,[M['recoveryBackingPath'],str(parent)],M['bytes'])
    overlay_creating=True
    command('createPrivateClientCow',[M['qemuImg'],'create','-f','qcow2','-F','qcow2','-b',M['recoveryBackingPath'],str(overlay)],10)
    st=overlay.stat();overlay_identity=(st.st_dev,st.st_ino);overlay_creating=False
    record('CREATED-COW.json',{'path':str(overlay),'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size,'initialSha256':sha(overlay)})
    info=json.loads(command('backingChain',[M['qemuImg'],'info','--output=json','--backing-chain',str(overlay)],10)['stdout'])
    validate_backing_chain(info,[str(overlay),M['recoveryBackingPath'],str(parent)],M['bytes'])
    setup="import pathlib,os;os.umask(0o077);pathlib.Path("+repr(M['uploadDirectory'])+").mkdir(mode=0o700);pathlib.Path("+repr(str(Path(M['remoteSocket']).parent))+").mkdir(mode=0o700)"
    r=capture([*sshargs(),M['target'],'/usr/bin/python3 -B -'],8,stdin=setup.encode(),limit=4096);results['uploadDirectory']=r;assert r['rc']==0 and not r['reason']
    sources={name:row['localSource'] for name,row in M['payloadFiles'].items()};sources['program.py']=str(P/'remote-program.py')
    for name,source in sources.items():
        command('upload:'+name,['/usr/bin/scp','-q',*sshargs()[1:],source,M['target']+':'+M['uploadDirectory']+'/'+name],60)
    bootstrap();start_export();guard();remote_attempted=True;main_phase=True
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
    if backing_locks:
        try:
            parent_identity();header_pin()
            if overlay_identity is not None:
                final_chain=json.loads(command('finalBackingChain',[M['qemuImg'],'info','--output=json','--backing-chain',str(overlay)],5)['stdout'])
                validate_backing_chain(final_chain,[str(overlay),M['recoveryBackingPath'],str(parent)],M['bytes'])
            for row,fd in backing_locks:
                if row['path']==M['recoveryBackingPath']:
                    results['frozenBackingHashAfter']=verify_frozen_hash(row,fd,lambda:None)
        except Exception as e:errors.append('parent-final:'+type(e).__name__)
        if remote_attempted and not cleaned:errors.append('PRIVATE_COW_CLEANUP_UNPROVEN_NO_PRODUCTION_ADMISSION')
        for row,fd in reversed(backing_locks):os.close(fd)
    if workflow is not None:os.close(workflow)
    if (P/'ATTEMPT.json').exists():
        try:verify()
        except Exception as e:errors.append('input-drift:'+type(e).__name__)
        status='BOUNDED_EL_RPC_START_STOP_OBSERVED_NOT_PRODUCTION_READY' if not errors and cleaned and main_completed else 'CLIENT_TRIAL_FAILED_NO_RETRY'
        record('RESULT.json',{'status':status,'errors':errors,'results':results,'remoteCleanupVerified':cleaned,'parentUnchanged':not any(x.startswith('parent-final:') for x in errors),'frozenBackingUnchanged':not any(x.startswith('parent-final:') for x in errors),'frozenBackingPath':M['recoveryBackingPath'],'privateCowRetained':str(overlay),'productionReady':False,'consumerChanged':False,'baseStarted':False,'clStarted':False,'paired':False,'syncVerified':False})
        print(json.dumps({'status':status,'errors':errors,'remoteCleanupVerified':cleaned}))
    else:print(json.dumps({'status':'REFUSED_BEFORE_TRIAL','errors':errors}))
sys.exit(0 if not errors and cleaned and main_completed else 2)
