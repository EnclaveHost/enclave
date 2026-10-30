"""Bounded read-command capture; source only until root admission."""
import os, selectors, signal, subprocess, time

CAPTURE_GUARD=None
def capture(argv, seconds, stdin=None, limit=1048576):
    started = time.monotonic()
    deadline = started + seconds
    child = None; sel = None; rc = None; reason = None; sent = 0; deadline_exceeded = False
    cleanup_errors = []; group_signal = False; child_reaped = False
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    totals = {'stdout': 0, 'stderr': 0}
    payload = memoryview(stdin) if stdin is not None else None

    def retain(name, data):
        nonlocal reason
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
                                 start_new_session=True, bufsize=0, env={"PATH":"/usr/sbin:/usr/bin:/sbin:/bin","LANG":"C","LC_ALL":"C"})
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

# PREPARED ONLY. Invoked by root in a dedicated bounded systemd unit.
import pathlib, json, hashlib, stat, socket, struct, errno, mmap, fcntl, sys, resource, tomllib
P=pathlib.Path
ROOT=P('/run/enclave-rpc-l1-client-r8');M=json.loads((ROOT/'manifest.json').read_text());ACTION=sys.argv[1];STATE=ROOT/'state.json'
EXEC=P('/var/lib/enclave-rpc-l1-client-r8')
DEV=P('/dev/nbd7');SYS=P('/sys/block/nbd7');MOUNT=P('/srv/enclave-l1-pair-r8')
out={'action':ACTION,'ok':False,'errors':[]};client=None;mounted=False;cleaning=False
def sha(p):
    with P(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(p):return P(p).read_text().strip()
def cmd(name,args,seconds=8,allowed=(0,)):
    r=capture(args,seconds,limit=65536);out[name]=r
    assert r['rc'] in allowed and not r['reason'] and not r['truncated'],name
    return r['stdout']
def save(s):
    t=ROOT/'state.next'
    with t.open('x') as f:json.dump(s,f);f.flush();os.fsync(f.fileno())
    os.replace(t,STATE)
def pin(row):
    p=P(row['path']);assert p.stat().st_size==row['bytes'] and sha(p)==row['sha256'],'remote-pin-drift'
def pidof():
    v=read(SYS/'pid') if (SYS/'pid').exists() else ''
    return v if v not in ('0','') else ''
def size():return int(read(SYS/'size'))*512 if SYS.exists() else 0
def idle():return not pidof() and size()==0 and not list((SYS/'holders').iterdir())
def mounts():
    lines=[]
    for l in P('/proc/self/mountinfo').read_text().splitlines():
        cols=l.split()
        if cols[4]==str(MOUNT):lines.append(cols)
    return lines
def unitof(pid):return read('/proc/'+str(pid)+'/cgroup')
def headroom():
    global last_guard
    if cleaning or ACTION in ('verify','wait-cleanup','emergency-cleanup','request-stop','socket-clear'):return
    now=time.monotonic()
    if now-last_guard<.5:return
    last_guard=now
    available=next(int(l.split()[1])*1024 for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
    growth=0
    for unit,mib in M['serviceCapsMiB'].items():
        q=P('/sys/fs/cgroup/system.slice')/unit;maximum=int(read(q/'memory.max'));current=int(read(q/'memory.current'))
        assert maximum==mib*(1<<20),'existing-service-cap-changed'
        growth+=max(0,maximum-current)
    pending=0;actual=0;budget=[]
    for path,mib in (('/enclavel1trialr8.slice',2304),('/enclavel1attachr8.slice',128),('/enclavel1guardianr8.slice',128)):
        q=P('/sys/fs/cgroup'+path)
        current=int(read(q/'memory.current')) if q.exists() else 0
        if q.exists():assert read(q/'memory.max')==str(mib<<20),'trial-budget-drift'
        pending+=max(0,(mib<<20)-current);actual+=current;budget.append({'path':path,'maximum':mib<<20,'current':current})
    residual=available-growth-pending
    assert residual>=1536*(1<<20),'reserved-service-growth-floor'
    out['lastHeadroom']={'available':available,'existingRemainingCapGrowth':growth,'trialPending':pending,'trialCurrent':actual,'trialMaximum':2560<<20,'residual':residual,'floor':1536<<20,'groups':budget}
last_guard=0
CAPTURE_GUARD=headroom
def mount_policy(path):
    resolved=P(path).resolve();entries=[]
    for line in P('/proc/self/mountinfo').read_text().splitlines():
        cols=line.split();sep=cols.index('-');target=cols[4]
        if str(resolved)==target or str(resolved).startswith(target.rstrip('/')+'/'):
            entries.append({'target':target,'source':cols[sep+2],'fstype':cols[sep+1],'device':cols[2],'options':sorted(set(cols[5].split(',')+cols[sep+3].split(',')))})
    assert entries,'mount-policy-missing'
    return max(entries,key=lambda x:len(x['target']))
def executable_policy():
    assert EXEC.parent.resolve()==EXEC.parent
    for parent in (P('/'),P('/var'),EXEC.parent):
        st=parent.stat();assert st.st_uid==0 and not(st.st_mode&0o022),'exec-parent-permission'
    policy=mount_policy(EXEC.parent)
    assert all(policy[k]==v for k,v in M['execMount'].items()),'unadmitted-executable-mount'
    assert 'noexec' not in policy['options'] and 'ro' not in policy['options'] and not(os.statvfs(EXEC.parent).f_flag & os.ST_NOEXEC),'execution-disabled'
    return policy
def state():
    s=json.loads(STATE.read_text())
    assert s.get('nonce')==M['nonce'] and s.get('unitPrefix')==M['unitPrefix'],'foreign-attempt-state'
    st=ROOT.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o700
    assert s['rootIdentity']==[st.st_dev,st.st_ino],'root-identity-drift'
    st=EXEC.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o755
    assert s['execIdentity']==[st.st_dev,st.st_ino],'exec-identity-drift'
    return s
def device_mounts(number):
    seen=set();found=[];until=time.monotonic()+5;count=0
    for proc in P('/proc').iterdir():
        if not proc.name.isdigit():continue
        count+=1;assert count<=512 and time.monotonic()<until,'mount-census-bound'
        try:
            ns=(proc/'ns/mnt').stat().st_ino
            if ns in seen:continue
            with (proc/'mountinfo').open() as f:data=f.read((1<<20)+1)
            assert len(data)<=1<<20,'mountinfo-size'
            seen.add(ns)
        except FileNotFoundError:continue
        for line in data.splitlines():
            cols=line.split()
            if cols[2]==number:found.append({'namespace':ns,'mountpoint':cols[4]})
    return found
def clear_socket(s):
    q=P(M['remoteSocket'])
    if q.exists():
        st=q.lstat();assert stat.S_ISSOCK(st.st_mode) and [st.st_dev,st.st_ino]==s.get('socketIdentity'),'socket-identity'
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(1)
            try:sock.connect(str(q))
            except OSError as e:assert e.errno==errno.ECONNREFUSED
            else:raise RuntimeError('forward-still-live')
        q.unlink()
def detach(s):
    global cleaning
    cleaning=True
    rows=mounts()
    if rows:
        assert len(rows)==1 and rows[0][2]==s['deviceNumber'],'foreign-mount'
        cmd('unmount',['/usr/bin/umount',str(MOUNT)],10)
    assert not device_mounts(s['deviceNumber']),'device-mounted-in-other-namespace'
    if not idle():
        assert s.get('claimed') and not list((SYS/'holders').iterdir()),'device-not-owned'
        current=pidof()
        if current:
            assert unitof(current)==s.get('attachCgroup') and (not s.get('nbdPid') or current==s['nbdPid']),'foreign-nbd-pid'
        assert size() in (0,M['bytes']),'device-size-drift'
        cmd('detach',['/var/lib/enclave-rpc-l1-client-r8/nbd-client','-d',str(DEV)],8)
    until=time.monotonic()+5
    while not idle() and time.monotonic()<until:time.sleep(.1)
    assert idle() and not mounts(),'device-cleanup-incomplete'
    s['claimed']=False;save(s)
def recv(sock,n):
    b=b''
    while len(b)<n:
        d=sock.recv(n-len(b));assert d,'short-nbd-handshake';b+=d
    return b
def probe(name,unknown=False):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(3);sock.connect(M['remoteSocket'])
        magic,opts,flags=struct.unpack('>QQH',recv(sock,18))
        assert magic==0x4e42444d41474943 and opts==0x49484156454f5054 and flags&1
        sock.sendall(struct.pack('>I',3 if flags&2 else 1))
        n=name.encode();payload=struct.pack('>I',len(n))+n+struct.pack('>HH',1,0)
        sock.sendall(struct.pack('>QII',opts,6,len(payload))+payload)
        info=None
        for _ in range(8):
            rmagic,opt,typ,length=struct.unpack('>QIII',recv(sock,20));assert rmagic==0x3e889045565a9 and opt==6 and length<=4096
            data=recv(sock,length)
            if unknown:
                assert typ==0x80000006,'wrong-export-not-rejected';return {'unknownRejected':True}
            assert not typ&0x80000000,'NBD-option-error'
            if typ==3 and len(data)>=12 and struct.unpack_from('>H',data)[0]==0:
                _,nbytes,transmission=struct.unpack_from('>HQH',data);info={'bytes':nbytes,'flags':transmission}
            if typ==1:
                assert info and info['bytes']==M['bytes'] and info['flags']&1 and not info['flags']&2 and info['flags']&4 and info['flags']&8,'export-size-writable-flush-fua'
                sock.sendall(struct.pack('>QII',opts,2,0));return info
        raise RuntimeError('NBD-reply-limit')

# PREPARED ONLY. Appended to the qualified transport/ownership helpers.
import pwd,grp,secrets,shutil,urllib.request,urllib.error,contextlib
PAYLOAD=EXEC/'payload';SLICE='enclavel1trialr8.slice';GUARD_SLICE='enclavel1guardianr8.slice';ATTACH_SLICE='enclavel1attachr8.slice';NBD_UNIT='enclave-rpc-l1-nbd-r8.service'
UNITS={'el':'enclave-rpc-l1-el-trial-r8.service','cl':'enclave-rpc-l1-cl-trial-r8.service'}
HELPER='enclave-rpc-l1-helper-r8.service';WATCH='enclave-rpc-l1-watch-r8.service'
STOP=ROOT/'STOP';DONE=ROOT/'CLEANUP.json';LOCK=ROOT/'operation.lock'
def atomic_json(path,value):
    tmp=path.with_suffix('.next')
    with tmp.open('x') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)
def unit_info(unit):
    text=cmd('unit:'+unit,['/usr/bin/systemctl','show',unit,'--property=LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,Result,ExecMainCode,ExecMainStatus,User,Group,Transient,Description,ExecStart,FragmentPath,DropInPaths'],3,allowed=(0,1,4))
    return dict(l.split('=',1) for l in text.splitlines() if '=' in l)
def dead(unit):
    info=unit_info(unit)
    if info.get('LoadState')=='not-found':return info
    assert info.get('MainPID')=='0' and info.get('ActiveState') in ('inactive','failed'),'unit-still-live:'+unit
    if info.get('ControlGroup'):
        q=P('/sys/fs/cgroup'+info['ControlGroup'])
        assert not q.exists() or all(not x.read_text().strip() for x in q.rglob('cgroup.procs')),'unit-descendants-live'
    return info
@contextlib.contextmanager
def mutation():
    with LOCK.open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        assert not STOP.exists(),'trial-stop-latched'
        headroom()
        yield
def stop_request(reason):
    try:
        with STOP.open('x') as f:f.write(reason+'\n');f.flush();os.fsync(f.fileno())
    except FileExistsError:pass
def retained_identities():
    # r2 created these accounts. Reuse only exact, idle mappings; never create/repair them here.
    expected={'el':('enclavel1el',997,987),'cl':('enclavel1cl',995,986)}
    assert set(M['identities'])==set(expected),'unexpected-client-identities'
    assert M['jwtGroup']=={'name':'enclavel1jwt','gid':50002},'unexpected-JWT-identity'
    provenance=M['retainedAccountProvenance']
    assert provenance['rootInvocation']=='0481622ff7ed4bdc9284906867ba75d2','wrong-account-provenance'
    assert provenance['retainedAccounts']=={'users':[{'name':'enclavel1el','uid':997,'gid':987},{'name':'enclavel1cl','uid':995,'gid':986}],'groups':[{'name':'enclavel1el','gid':987},{'name':'enclavel1cl','gid':986},{'name':'enclavel1jwt','gid':50002}]},'wrong-retained-accounts'
    users=pwd.getpwall();groups=grp.getgrall()
    result={'users':[],'groups':[]}
    for side,(name,uid,gid) in expected.items():
        identity=M['identities'][side]
        assert (identity['name'],identity['uid'],identity['gid'])==(name,uid,gid),'identity-manifest-drift'
        matching=[x for x in users if x.pw_name==name or x.pw_uid==uid]
        assert len(matching)==1,'client-account-missing-or-alias'
        account=matching[0]
        assert (account.pw_name,account.pw_uid,account.pw_gid,account.pw_dir,account.pw_shell)==(name,uid,gid,'/nonexistent','/usr/sbin/nologin'),'retained-account-drift'
        matching=[x for x in groups if x.gr_name==name or x.gr_gid==gid]
        assert len(matching)==1 and (matching[0].gr_name,matching[0].gr_gid,matching[0].gr_mem)==(name,gid,[]),'retained-group-drift'
        assert [x.pw_name for x in users if x.pw_gid==gid]==[name],'unexpected-primary-group-user'
        assert not any(name in x.gr_mem for x in groups),'unexpected-supplementary-group'
        result['users'].append({'name':name,'uid':uid,'gid':gid})
        result['groups'].append({'name':name,'gid':gid})
    matching=[x for x in groups if x.gr_name=='enclavel1jwt' or x.gr_gid==50002]
    assert len(matching)==1 and (matching[0].gr_name,matching[0].gr_gid,matching[0].gr_mem)==('enclavel1jwt',50002,[]),'retained-JWT-group-drift'
    assert not any(x.pw_gid==50002 for x in users),'unexpected-JWT-primary-user'
    result['groups'].append({'name':'enclavel1jwt','gid':50002})
    count=0;uids={997,995};gids={987,986,50002}
    for q in P('/proc').iterdir():
        if not q.name.isdigit():continue
        count+=1;assert count<=512,'process-census-limit'
        try:lines=(q/'status').read_text().splitlines()
        except FileNotFoundError:continue
        fields={line.split(':',1)[0]:line.split(':',1)[1].split() for line in lines if ':' in line}
        assert 'Uid' in fields and 'Gid' in fields and 'Groups' in fields,'incomplete-process-identity'
        assert not(uids & {int(x) for x in fields['Uid']}),'process-occupies-client-UID'
        assert not(gids & {int(x) for x in fields['Gid']+fields['Groups']}),'process-occupies-client-GID'
    return result

def check_owners():
    retained_identities()
    records={}
    for side,identity in M['identities'].items():
        for rel in identity['paths']:
            q=MOUNT/rel;st=q.lstat()
            assert not stat.S_ISLNK(st.st_mode) and st.st_uid==identity['uid'] and st.st_gid==identity['gid'],'unexpected-datadir-owner:'+rel
            records[rel]={'uid':st.st_uid,'gid':st.st_gid,'mode':st.st_mode,'inode':st.st_ino}
    return records

def create_identities():
    # Retain call-site compatibility; this revision performs verification only.
    identities=retained_identities()
    s=state();s['reusedUsers']=identities['users'];s['reusedGroups']=identities['groups'];save(s)

def create_slice():
    for unit,mib,cpu in ((SLICE,2304,100),(GUARD_SLICE,128,50)):
        path=P('/run/systemd/system')/unit
        info=unit_info(unit)
        assert info.get('LoadState') in ('loaded','not-found') and info.get('ActiveState')=='inactive' and not any(info.get(k) for k in ('FragmentPath','DropInPaths','ControlGroup','InvocationID')) and info.get('Transient')=='no','slice-preexists'
        text='[Unit]\nDescription=Bounded private L1 trial\n[Slice]\nMemoryMax='+str(mib)+'M\nMemorySwapMax=0\nCPUQuota='+str(cpu)+'%\nTasksMax=1024\nAllowedCPUs=1\n'
        with path.open('x') as f:f.write(text)
    cmd('daemonReload',['/usr/bin/systemctl','daemon-reload'],5)
    cmd('startSlices',['/usr/bin/systemctl','start',SLICE,GUARD_SLICE],5)
    for unit,mib in ((SLICE,2304),(GUARD_SLICE,128)):
        assert read(P('/sys/fs/cgroup')/unit/'memory.max')==str(mib<<20)
def description(role):return 'Enclave L1 '+M['nonce']+' '+role
def owned_info(unit,role,user,executable,expected=None):
    info=unit_info(unit)
    if info.get('LoadState')=='not-found':return info
    assert info.get('Transient')=='yes' and info.get('Description')==description(role),'foreign-unit-description'
    assert info.get('User') in (user, '0' if user=='root' else user),'foreign-unit-user'
    assert executable in info.get('ExecStart',''),'foreign-unit-command'
    if expected:assert info.get('InvocationID')==expected,'unit-invocation-drift'
    return info
class DiagnosticFieldTruncated(ValueError):pass

def diagnostic_read(directory_fd,name,limit):
    fd=os.open(name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=directory_fd)
    try:raw=os.read(fd,limit+1)
    finally:os.close(fd)
    if len(raw)>limit:raise DiagnosticFieldTruncated()
    return raw.decode('ascii')

def diagnostic_stat(directory_fd):
    raw=diagnostic_read(directory_fd,'stat',4096)
    # Field2 comm may contain spaces and parentheses; never emit it.
    pid=int(raw.split(' ',1)[0]);tail=raw.rsplit(')',1)[1].split()
    if len(tail)<40:raise ValueError('short-proc-stat')
    return {'pid':pid,'state':tail[0],'startTicks':int(tail[19]),
            'minorFaults':int(tail[7]),'majorFaults':int(tail[9]),
            'userTicks':int(tail[11]),'systemTicks':int(tail[12]),
            'threads':int(tail[17]),'vsizeBytes':int(tail[20]),'rssPages':int(tail[21]),
            'processor':int(tail[36]),'blockIoDelayTicks':int(tail[39])}

def diagnostic_wait(directory_fd):
    value=diagnostic_read(directory_fd,'wchan',128).strip()
    if not value or len(value)>96 or not all(c.isalnum() or c in '._' for c in value):
        raise ValueError('invalid-wchan')
    return value

def bind_client_diagnostic(info):
    record={'bound':False}
    try:
        pid=int(info['MainPID']);assert pid>0
        fd=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)
        try:
            before=diagnostic_stat(fd)
            assert before['pid']==pid
            assert diagnostic_read(fd,'cgroup',4096).strip()=='0::'+info['ControlGroup']
            after=diagnostic_stat(fd);assert before['startTicks']==after['startTicks']
            st=os.fstat(fd);record={'bound':True,'pid':pid,'startTicks':before['startTicks'],
                'procIdentity':[st.st_dev,st.st_ino],'invocationID':info['InvocationID'],
                'controlGroup':info['ControlGroup']}
        finally:os.close(fd)
    except Exception as e:record={'bound':False,'unavailable':type(e).__name__}
    info['diagnosticIdentity']=record

def sample_client_diagnostics(clients):
    values={}
    for side,info in clients.items():
        identity=info.get('diagnosticIdentity',{});result={'atMonotonic':time.monotonic(),'identity':identity}
        values[side]=result
        if identity.get('bound') is not True:
            result['unavailable']='initial-incarnation-unbound';continue
        fd=None;taskfd=None;started=time.monotonic();thread_rows=[]
        try:
            current=owned_info(UNITS[side],side,M['identities'][side]['name'],str(PAYLOAD/'chain_service.py'),identity['invocationID'])
            assert int(current['MainPID'])==identity['pid'],'client-main-pid-changed'
            pid=identity['pid'];fd=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)
            procst=os.fstat(fd);assert [procst.st_dev,procst.st_ino]==identity['procIdentity']
            before=diagnostic_stat(fd);assert before['pid']==pid and before['startTicks']==identity['startTicks']
            assert diagnostic_read(fd,'cgroup',4096).strip()=='0::'+identity['controlGroup']
            cg=P('/sys/fs/cgroup'+identity['controlGroup']);cgs=cg.stat()
            assert [cgs.st_dev,cgs.st_ino]==info['cgroupIdentity']
            # exe metadata only; do not open/read executable bytes or disclose arbitrary paths.
            ex=os.stat('exe',dir_fd=fd);lh=(PAYLOAD/'bin/reth').stat();py=P('/usr/bin/python3').stat()
            executable='reth' if (ex.st_dev,ex.st_ino)==(lh.st_dev,lh.st_ino) else 'python-wrapper' if (ex.st_dev,ex.st_ino)==(py.st_dev,py.st_ino) else None
            assert executable is not None,'unexpected-client-executable'
            io={}
            for line in diagnostic_read(fd,'io',4096).splitlines():
                key,value=line.split(':',1)
                if key in ('rchar','wchar','syscr','syscw','read_bytes','write_bytes','cancelled_write_bytes'):
                    io[key]=int(value.strip())
            assert set(io)=={'rchar','wchar','syscr','syscw','read_bytes','write_bytes','cancelled_write_bytes'}
            wait=diagnostic_wait(fd)
            taskfd=os.open('task',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=fd)
            truncated=False;truncation_reason=None;observed=0
            with os.scandir(taskfd) as entries:
                for entry in entries:
                    if not entry.name.isdigit():continue
                    observed+=1
                    if len(thread_rows)>=64 or time.monotonic()-started>=0.25:
                        truncated=True;truncation_reason='thread-limit' if len(thread_rows)>=64 else 'sample-time-budget';break
                    tid=int(entry.name);tfd=None
                    try:
                        tfd=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=taskfd)
                        a=diagnostic_stat(tfd);w=diagnostic_wait(tfd);b=diagnostic_stat(tfd)
                        assert a['pid']==b['pid']==tid and a['startTicks']==b['startTicks']
                        thread_rows.append({'tid':tid,'startTicks':a['startTicks'],'state':a['state'],'wait':w,
                            'userTicks':a['userTicks'],'systemTicks':a['systemTicks'],'blockIoDelayTicks':a['blockIoDelayTicks']})
                    except Exception as e:thread_rows.append({'tid':tid,'unavailable':type(e).__name__,'fieldTruncated':isinstance(e,DiagnosticFieldTruncated)})
                    finally:
                        if tfd is not None:os.close(tfd)
            after=diagnostic_stat(fd);assert after['pid']==pid and after['startTicks']==identity['startTicks']
            assert diagnostic_read(fd,'cgroup',4096).strip()=='0::'+identity['controlGroup']
            cgs=cg.stat();assert [cgs.st_dev,cgs.st_ino]==info['cgroupIdentity']
            result.update({'sameIncarnation':True,'executable':executable,'stat':before,'io':io,'wait':wait,
                'threads':thread_rows,'threadsTruncated':truncated,'threadTruncationReason':truncation_reason,
                'threadEntriesObserved':observed,'threadLimit':64,'elapsedSeconds':time.monotonic()-started,
                'clockTicksPerSecond':os.sysconf('SC_CLK_TCK'),'pageBytes':os.sysconf('SC_PAGE_SIZE')})
        except Exception as e:
            # Discard observations if the final incarnation binding is lost.
            result.update({'sameIncarnation':False,'unavailable':type(e).__name__,'observationsDiscarded':True,'fieldTruncated':isinstance(e,DiagnosticFieldTruncated)})
        finally:
            if taskfd is not None:os.close(taskfd)
            if fd is not None:os.close(fd)
    return values


def start_client(side):
    assert side=='el','EL-only-trial'
    identity=M['identities'][side];data=str(MOUNT/('data' if side=='el' else 'cl'));tmp=str(MOUNT/('tmp' if side=='el' else 'tmp-cl'))
    argv=['/usr/bin/systemd-run','--quiet','--unit='+UNITS[side],'--slice='+SLICE,'--description='+description(side),'--property=Type=exec',
          '--property=User='+identity['name'],'--property=Group='+identity['name'],
          '--property=SupplementaryGroups='+M['jwtGroup']['name'],
          '--property=NoNewPrivileges=yes','--property=ProtectSystem=strict','--property=ProtectHome=yes',
          '--property=PrivateTmp=yes','--property=ReadWritePaths='+data+' '+tmp,
          '--property=UMask=0027','--property=MemorySwapMax=0','--property=TasksMax=512',
          '--property=LimitNOFILE=65536','--property=OOMScoreAdjust=100',
          '--property=KillMode=control-group','--property=KillSignal=SIGINT','--property=TimeoutStopSec=45',
          '--property=Restart=no','--property=BindsTo='+WATCH,
          '/usr/bin/python3','-I','-B',str(PAYLOAD/'chain_service.py'),side]
    s=state();s.setdefault('clientLaunchIntents',{})[side]={'description':description(side),'unit':UNITS[side],'executable':str(PAYLOAD/'chain_service.py'),'user':identity['name']};save(s)
    cmd('start:'+side,argv,8)
    info=unit_info(UNITS[side]);assert info.get('User')==identity['name'] and info.get('Group')==identity['name']
    cg=info.get('ControlGroup')
    assert cg=='/'+SLICE+'/'+UNITS[side],'unexpected-client-cgroup'
    st=(P('/sys/fs/cgroup'+cg)).stat()
    info['cgroupIdentity']=[st.st_dev,st.st_ino]
    bind_client_diagnostic(info)
    return info

def sample_client_memory(clients):
    values={}
    for side,info in clients.items():
        record={'unit':UNITS[side],'invocationID':info.get('InvocationID'),'controlGroup':info.get('ControlGroup')}
        values[side]=record
        try:
            cg=info.get('ControlGroup')
            assert cg=='/'+SLICE+'/'+UNITS[side],'unexpected-client-cgroup'
            q=P('/sys/fs/cgroup'+cg);st=q.stat()
            assert [st.st_dev,st.st_ino]==info['cgroupIdentity'],'client-cgroup-replaced'
            for name in ('memory.current','memory.peak','memory.events','memory.stat'):
                with (q/name).open() as f:value=f.read(32769)
                assert len(value)<=32768,'memory-field-limit'
                record[name]=value.strip()
            st=q.stat();assert [st.st_dev,st.st_ino]==info['cgroupIdentity'],'client-cgroup-replaced'
        except FileNotFoundError:record['unavailable']='owned-cgroup-removed'
        except Exception as e:record['unavailable']=type(e).__name__
    return values

def sample_rpc():
    # Startup response only. This does not prove synchronization or paired consensus.
    try:
        request={'jsonrpc':'2.0','id':1,'method':'eth_blockNumber','params':[]}
        req=urllib.request.Request('http://127.0.0.1:18645',json.dumps(request).encode(),{'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=1) as response:raw=response.read(65537)
        assert len(raw)<=65536,'EL-RPC-response-limit'
        value=json.loads(raw)
        assert isinstance(value,dict) and value.get('jsonrpc')=='2.0' and type(value.get('id')) is int and value['id']==1 and 'error' not in value,'EL-RPC-envelope'
        block=value.get('result')
        assert isinstance(block,str) and block.startswith('0x') and len(block)>2 and all(c in '0123456789abcdef' for c in block[2:]),'EL-RPC-block-number'
        assert block=='0x0' or block[2]!='0','EL-RPC-block-number-canonical'
        return {'el':{'response':value,'validBlockNumber':True}}
    except Exception as e:return {'el':{'unavailable':type(e).__name__}}
def clean_trial(reason):
    global cleaning
    cleaning=True;stop_request(reason)
    receipt={'reason':reason,'ok':False,'errors':[],'clients':{}}
    try:
        with LOCK.open('a') as lock:
            until=time.monotonic()+15
            while True:
                try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
                except BlockingIOError:
                    assert time.monotonic()<until,'mutation-lock-timeout';time.sleep(.1)
            s=state();receipt['retainedAccounts']={'users':s.get('createdUsers',[])+s.get('reusedUsers',[]),'groups':s.get('createdGroups',[])+s.get('reusedGroups',[])}
            for side,unit in UNITS.items():
                expected=s.get('clients',{}).get(side,{}).get('InvocationID')
                info=owned_info(unit,side,M['identities'][side]['name'],str(PAYLOAD/'chain_service.py'),expected)
                if info.get('LoadState')=='not-found':continue
                assert side in s.get('clientLaunchIntents',{}),'no-owned-launch-intent'
                receipt.setdefault('ownedInvocations',{})[side]=info.get('InvocationID')
            # systemd stops both in parallel with their configured SIGINT and grace.
            cmd('stopClients',['/usr/bin/systemctl','stop',*UNITS.values()],55,allowed=(0,5))
            for side,unit in UNITS.items():receipt['clients'][side]=dead(unit)
            if s.get('claimed'):
                assert s.get('nbdLaunchIntent')==description('nbd'),'missing-NBD-intent'
                owned_info(NBD_UNIT,'nbd','root',str(EXEC/'nbd-client'),s.get('nbdInvocation'))
            if s.get('deviceNumber'):detach(s)
            elif s.get('moduleLoadedByFixture') and SYS.exists():assert idle(),'partial-bootstrap-active-device'
            cmd('stopNBDUnit',['/usr/bin/systemctl','stop',NBD_UNIT],12,allowed=(0,5))
            receipt['nbdUnit']=dead(NBD_UNIT)
            if s.get('moduleLoadedByFixture') and P('/sys/module/nbd').exists():
                for q in P('/sys/block').glob('nbd*'):
                    assert int(read(q/'size'))==0 and (not(q/'pid').exists() or read(q/'pid') in ('','0')) and not list((q/'holders').iterdir()),'other-NBD-user'
                cmd('unloadNBD',['/usr/sbin/modprobe','-r','nbd'],8)
            if P('/sys/fs/cgroup',SLICE).exists():cmd('stopSlice',['/usr/bin/systemctl','stop',SLICE],5)
            receipt['ok']=True
    except Exception as e:receipt['errors'].append(type(e).__name__+':'+str(e)[:180])
    atomic_json(DONE,receipt)
    return receipt
def watchdog():
    # This service has its own128MiB cap outside the2304MiB client slice.
    reason='watchdog-deadline';s=state();deadline=s['watchdogDeadline']
    try:
        while time.time()<deadline:
            if STOP.exists():reason=read(STOP);break
            headroom()
            s=state();pid=s['helperPid']
            try:started=P('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
            except FileNotFoundError:reason='attachment-helper-gone';break
            if started!=s['helperStart']:reason='attachment-helper-identity-changed';break
            for side,expected in s.get('clients',{}).items():
                info=unit_info(UNITS[side])
                if info.get('InvocationID')!=expected.get('InvocationID') or info.get('ActiveState') not in ('active','activating'):
                    reason='client-ended:'+side;stop_request(reason);break
            if STOP.exists():reason=read(STOP);break
            time.sleep(.5)
    except Exception as e:reason='watchdog:'+type(e).__name__+':'+str(e)[:100]
    return clean_trial(reason)
def wait_cleanup(seconds=140):
    until=time.monotonic()+seconds
    while not DONE.exists() and time.monotonic()<until:time.sleep(.2)
    assert DONE.is_file(),'watchdog-cleanup-missing'
    value=json.loads(DONE.read_text());assert value['ok'] and not value['errors'],'watchdog-cleanup-failed'
    return value

"""Finite native recovery progress and bounded public journal markers."""
import re

def recovery_markers(raw,invocation):
    markers=[]
    labels=('Opening database','Healing static file inconsistencies.','Verifying storage consistency.',
            'Executing unwind after consistency check.','Starting unwind','Unwind finished',
            'StoragesHistory: healing via changesets','StoragesHistory: unwinding batch',
            'AccountsHistory: healing via changesets','AccountsHistory: unwinding batch',
            'TransactionHashNumbers: healing via transaction ranges')
    for line in raw.splitlines():
        row=json.loads(line)
        assert row.get('_SYSTEMD_INVOCATION_ID')==invocation,'progress-journal-invocation'
        message=row.get('MESSAGE','')
        # journalctl JSON represents nonprintable fields (including ANSI ESC)
        # as unsigned byte arrays. Duplicate field values can also be arrays:
        # accept only a single bounded flat byte sequence, never coerce values.
        if type(message) is list:
            if len(message)>8192 or not all(type(b) is int and 0<=b<=255 for b in message):continue
            try:message=bytes(message).decode('utf-8',errors='strict')
            except UnicodeDecodeError:continue
        if not isinstance(message,str) or len(message)>8192:continue
        message=re.sub(r'\x1b\[[0-9;]*m','',message)
        label=next((v for v in labels if v in message),None)
        if label is None:continue
        numeric={k:int(v) for k,v in re.findall(r'\b(checkpoint|sf_tip|batch_num|total_batches|batch_start|batch_end|from|to)=([0-9]{1,20})\b',message)}
        match=re.search(r'\bstage=([A-Za-z]{1,40})\b',message)
        stage=match.group(1) if match else ''
        # No timestamps, paths, headers, arbitrary log text or JWTs in semantic identities.
        markers.append((label,stage,tuple(sorted(numeric.items()))))
    return markers

def sample_recovery_markers(info):
    invocation=info['InvocationID']
    assert len(invocation)==32 and all(c in '0123456789abcdef' for c in invocation),'progress-invocation'
    r=capture(['/usr/bin/journalctl','--no-pager','-o','json','-n','256',
               '--output-fields=MESSAGE,_SYSTEMD_INVOCATION_ID','_SYSTEMD_INVOCATION_ID='+invocation],4,limit=131072)
    assert r['rc']==0 and not r['reason'] and not r['truncated'],'progress-journal-read'
    return recovery_markers(r['stdout'],invocation)

def recovery_clock(now):
    return {'started':now,'lastWork':now,'lastSemantic':now,'previousCounters':None,
            'identity':None,'seenMarkers':set(),'validSamples':0,'invalidSamples':0}

def advance_recovery(clock,now,diagnostic,markers):
    assert now>=clock['started'],'progress-clock-reversed'
    if diagnostic.get('sameIncarnation') is not True:
        clock['invalidSamples']+=1
    else:
        identity=diagnostic['identity']
        token=(identity['pid'],identity['startTicks'],identity['invocationID'],tuple(identity['procIdentity']))
        if clock['identity'] is None:clock['identity']=token
        assert clock['identity']==token,'progress-incarnation-changed'
        io=diagnostic['io'];st=diagnostic['stat']
        counters=tuple(io[k] for k in ('read_bytes','write_bytes'))+(st['userTicks'],st['systemTicks'])
        assert all(type(v) is int and v>=0 for v in counters),'invalid-progress-counter'
        previous=clock['previousCounters']
        if previous is not None:
            assert all(b>=a for a,b in zip(previous,counters)),'progress-counter-reset'
            if any(b>a for a,b in zip(previous,counters)):clock['lastWork']=now
        clock['previousCounters']=counters;clock['validSamples']+=1
        for marker in markers:
            if marker not in clock['seenMarkers']:
                assert len(clock['seenMarkers'])<512,'progress-marker-cap'
                clock['seenMarkers'].add(marker);clock['lastSemantic']=now;clock['lastWork']=now
    return recovery_stop_reason(clock,now)

def recovery_stop_reason(clock,now):
    if now-clock['started']>=900:return 'recovery-window-ended'
    if now-clock['lastSemantic']>=600:return 'recovery-semantic-progress-limit'
    if now-clock['lastWork']>=300:return 'recovery-no-work-limit'
    return None

def recovery_clock_evidence(clock,now):
    return {'elapsedSeconds':now-clock['started'],'secondsWithoutWork':now-clock['lastWork'],
            'secondsWithoutSemanticProgress':now-clock['lastSemantic'],'validSamples':clock['validSamples'],
            'invalidSamples':clock['invalidSamples'],'semanticMarkers':len(clock['seenMarkers'])}

# PREPARED ONLY. Root reviews the complete combined program before one trial.
def seal_payload():
    EXEC.mkdir(mode=0o755);PAYLOAD.mkdir(mode=0o755);(PAYLOAD/'bin').mkdir(mode=0o755)
    for directory in (EXEC,PAYLOAD,PAYLOAD/'bin'):directory.chmod(0o755)
    for name,row in M['payloadFiles'].items():
        source=P(M['uploadDirectory'])/name;st=source.lstat()
        assert stat.S_ISREG(st.st_mode) and st.st_size==row['bytes'] and sha(source)==row['sha256'],'payload-upload-drift'
        target=PAYLOAD/row['destination']
        assert target.parent in (PAYLOAD,PAYLOAD/'bin')
        with source.open('rb') as src,target.open('xb') as dst:
            while True:
                data=src.read(1<<20)
                if not data:break
                headroom();dst.write(data)
            dst.flush();os.fsync(dst.fileno())
        target.chmod(0o755 if row['destination'].startswith('bin/') else 0o644)
        assert sha(target)==row['sha256']
    source=P(M['client']['path']);data=source.read_bytes();assert hashlib.sha256(data).hexdigest()==M['client']['sha256']
    with (EXEC/'nbd-client').open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    (EXEC/'nbd-client').chmod(0o700)
def library_receipt():
    values=[]
    for name in ('libstdc++.so.6','libm.so.6','libc.so.6','ld-linux-x86-64.so.2','libgcc_s.so.1','libz.so.1'):
        q=P('/usr/lib/x86_64-linux-gnu')/name;p=q.resolve(strict=True);st=p.stat()
        assert p.is_file() and st.st_uid==0 and not(st.st_mode&0o022) and str(p).startswith('/usr/lib/x86_64-linux-gnu/'),'runtime-library-permissions'
        aliases=[str(p),str(p).removeprefix('/usr')]
        owners=cmd('libraryOwner:'+name,['/usr/bin/dpkg-query','-S',*aliases],3,allowed=(0,1))
        packages=set()
        for line in owners.splitlines():
            for alias in aliases:
                if line.endswith(': '+alias):packages.add(line[:-(len(alias)+2)])
        assert len(packages)==1,'runtime-library-owner'
        package=packages.pop();version=cmd('libraryVersion:'+name,['/usr/bin/dpkg-query','-W','-f=${Version}\t${db:Status-Abbrev}',package],3)
        assert version.endswith('\tii '),'runtime-library-not-installed'
        values.append({'name':name,'path':str(p),'bytes':st.st_size,'sha256':sha(p),'package':package,'installedVersion':version.split('\t')[0]})
    return values
def main_trial():
    global client
    assert not STATE.exists() and not MOUNT.exists(),'trial-runtime-or-mount-preexists'
    assert executable_policy()
    out['runtimeLibraries']=library_receipt()
    seal_payload();MOUNT.mkdir(mode=0o755);MOUNT.chmod(0o755)
    st=ROOT.stat();ex=EXEC.stat()
    s={'nonce':M['nonce'],'unitPrefix':M['unitPrefix'],'rootIdentity':[st.st_dev,st.st_ino],
       'execIdentity':[ex.st_dev,ex.st_ino],'claimed':False,'clients':{},'watchStarted':False,
       'helperPid':os.getpid(),'helperStart':P('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],
       'watchdogDeadline':time.time()+1190,'moduleInitiallyLoaded':P('/sys/module/nbd').exists(),'moduleLoadedByFixture':False}
    save(s)
    with LOCK.open('x'):pass
    create_slice()
    s['watchLaunchIntent']=description('watchdog');save(s)
    cmd('startWatchdog',['/usr/bin/systemd-run','--quiet','--unit='+WATCH,'--slice='+GUARD_SLICE,'--description='+description('watchdog'),'--property=Type=exec','--property=User=root',
        '--property=MemoryMax=128M','--property=MemorySwapMax=0','--property=CPUQuota=50%',
        '--property=TasksMax=32','--property=RuntimeMaxSec=1330','--property=TimeoutStopSec=70',
        '--property=KillMode=control-group','--property=UMask=0077',
        '--property=ExecStopPost=/usr/bin/python3 -B '+str(ROOT/'program.py')+' emergency-cleanup',
        '/usr/bin/python3','-B',str(ROOT/'program.py'),'watchdog'],8)
    s['watchStarted']=True;s['watchInvocation']=unit_info(WATCH).get('InvocationID');save(s)
    with mutation():
        if not s['moduleInitiallyLoaded']:
            s['moduleLoadedByFixture']=True;save(s)
            cmd('loadModule',['/usr/sbin/modprobe','nbd','nbds_max=8','max_part=0'],8)
        assert DEV.is_block_device() and idle(),'nbd7-not-idle'
        st=DEV.stat();s['deviceNumber']=str(os.major(st.st_rdev))+':'+str(os.minor(st.st_rdev));save(s)
        assert not device_mounts(s['deviceNumber'])
        q=P(M['remoteSocket']);until=time.monotonic()+5
        while not q.exists() and time.monotonic()<until:time.sleep(.1)
        st=q.lstat();ps=q.parent.lstat()
        assert stat.S_ISSOCK(st.st_mode) and st.st_uid==1000 and stat.S_IMODE(st.st_mode)==0o600
        assert stat.S_ISDIR(ps.st_mode) and ps.st_uid==1000 and stat.S_IMODE(ps.st_mode)==0o700
        out['exportInfo']=probe(M['exportName']);s['socketIdentity']=[st.st_dev,st.st_ino]
        s['claimed']=True;s['attachCgroup']='0::/'+ATTACH_SLICE+'/'+NBD_UNIT;s['nbdLaunchIntent']=description('nbd');save(s)
        cmd('startNBDUnit',['/usr/bin/systemd-run','--quiet','--unit='+NBD_UNIT,'--slice='+ATTACH_SLICE,
            '--description='+description('nbd'),'--property=Type=exec','--property=User=root','--property=MemoryMax=128M',
            '--property=MemorySwapMax=0','--property=TasksMax=32','--property=KillMode=control-group',
            '--property=TimeoutStopSec=10','--property=RuntimeMaxSec=1410',
            str(EXEC/'nbd-client'),'-n','-L','-u','-N',M['exportName'],'-t','5','-b','4096',M['remoteSocket'],str(DEV)],8)
        s['nbdInvocation']=owned_info(NBD_UNIT,'nbd','root',str(EXEC/'nbd-client')).get('InvocationID');save(s)
        until=time.monotonic()+8
        while (size()!=M['bytes'] or not pidof()) and time.monotonic()<until:time.sleep(.1)
        assert size()==M['bytes'] and pidof(),'attach-timeout'
        s['nbdPid']=pidof();assert unitof(s['nbdPid'])==s['attachCgroup'];save(s)
        uuid=cmd('filesystemUuid',['/usr/sbin/blkid','-p','-s','UUID','-o','value',str(DEV)]).strip();assert uuid==M['uuid']
        cmd('readOnlyPreflightMount',['/usr/bin/mount','-t','ext4','-o','ro,noload,nosuid,nodev,noexec',str(DEV),str(MOUNT)],10)
        out['owners']=check_owners()
        config=MOUNT/'data/reth.toml';assert M['recoveryInput']=='frozen-r6-proposed-toml' and sha(config)==M['proposedTomlSha256'],'frozen-input-TOML-policy'
        assert (MOUNT/'snapshot-complete').is_file() and (MOUNT/'cl/beacon/chain_db').is_dir(),'actual-database-missing'
        for unit in UNITS.values():assert unit_info(unit).get('LoadState')=='not-found','unit-preexists:'+unit
        # Verify exact idle retained r2 account mappings. No account or file-owner changes.
        create_identities()
        cmd('unmountPreflight',['/usr/bin/umount',str(MOUNT)],10)
        cmd('privateCowWritableMount',['/usr/bin/mount','-t','ext4','-o','rw,nosuid,nodev,noexec',str(DEV),str(MOUNT)],10)
        assert len(mounts())==1 and mounts()[0][2]==s['deviceNumber'] and 'rw' in mounts()[0][5].split(',')
        old=config.stat();assert old.st_uid==997 and old.st_gid==987 and sha(config)==M['proposedTomlSha256'],'frozen-TOML-drift'
        out['recoveryTomlPreserved']=True
        jwt=PAYLOAD/'jwt.hex'
        with jwt.open('x') as f:f.write(secrets.token_hex(32));f.flush();os.fsync(f.fileno())
        os.chown(jwt,0,M['jwtGroup']['gid']);jwt.chmod(0o640)
        out['jwtCreatedPrivately']=True
        for side in ('el',):
            info=start_client(side);s=state();s['clients'][side]=info;save(s)
    assert s['watchdogDeadline']-time.time()>=905,'recovery-window-watchdog-headroom'
    samples=[];started=time.monotonic();until=started+900;diagnostic_at=0;diagnostic_count=0
    clock=recovery_clock(started);evidence_bytes=2;dropped=0;observed=0;rpc_observed=False;stop_reason='recovery-window-ended'
    while time.monotonic()<until and not STOP.exists():
        headroom();sample={'at':time.time(),'clientMemory':sample_client_memory(s['clients'])}
        now=time.monotonic()
        if now-diagnostic_at>=10 and diagnostic_count<91:
            sample['diagnostics']=sample_client_diagnostics(s['clients'])
            markers=sample_recovery_markers(s['clients']['el'])
            reason=advance_recovery(clock,now,sample['diagnostics'].get('el',{}),markers)
            sample['recoveryMarkers']=markers;sample['progress']=recovery_clock_evidence(clock,now)
            diagnostic_at=now;diagnostic_count+=1
        else:reason=recovery_stop_reason(clock,now)
        sample['rpc']=sample_rpc();rpc_observed=rpc_observed or sample['rpc'].get('el',{}).get('validBlockNumber') is True
        q=P('/sys/fs/cgroup')/SLICE
        sample['memory']={n:read(q/n) for n in ('memory.current','memory.peak','memory.events')}
        observed+=1;encoded=len(json.dumps(sample).encode())+2
        if len(samples)<451 and evidence_bytes+encoded<=1048576:
            samples.append(sample);evidence_bytes+=encoded
        else:dropped+=1
        out['lastSample']=sample
        if rpc_observed:stop_reason='bounded-trial-finished';break
        if reason:stop_reason=reason;break
        time.sleep(2)
    out['samples']=samples;out['sampleEvidence']={'observed':observed,'retained':len(samples),'dropped':dropped,'byteCount':evidence_bytes,'truncated':dropped>0}
    out['recoveryProgress']=recovery_clock_evidence(clock,time.monotonic());out['recoveryStopReason']=stop_reason
    out['elRpcObserved']=rpc_observed
    out['clStarted']=False
    assert set(s['clients'])=={'el'},'unexpected-launched-client'
    stop_request(stop_reason)
    out['cleanup']=wait_cleanup()
    for side,info in s['clients'].items():
        if info.get('InvocationID'):
            cmd('clientLog:'+side,['/usr/bin/journalctl','--no-pager','-o','cat','-n','40','_SYSTEMD_INVOCATION_ID='+info['InvocationID']],4)
    assert out['elRpcObserved'],'EL-RPC-startup-not-observed'
    assert out['cleanup']['reason']=='bounded-trial-finished','trial-stopped-by-watchdog'
    for info in out['cleanup']['clients'].values():
        assert info.get('Result')=='success' and info.get('ExecMainCode')=='1' and info.get('ExecMainStatus')=='0','client-not-gracefully-stopped'
    out['startupObserved']=True;out['productionReady']=False;out['paired']=False;out['syncVerified']=False;out['consensusOfflineExpected']=True
try:
    os.umask(0o077)
    assert os.geteuid()==0 and read('/proc/sys/kernel/random/boot_id')==M['bootId']
    assert sha(ROOT/'program.py')==M['programSha256']
    cg=read('/proc/self/cgroup');assert (cg.startswith('0::/enclavel1attachr8.slice/enclave-rpc-l1-') or cg.startswith('0::/enclavel1guardianr8.slice/enclave-rpc-l1-')) and cg.endswith('.service')
    c=P('/sys/fs/cgroup'+cg[3:]);assert read(c/'memory.max')==str(128<<20) and read(c/'memory.swap.max')=='0'
    for row in M['remotePins']:pin(row)
    def terminated(signum,frame):raise RuntimeError('unit-termination')
    signal.signal(signal.SIGTERM,terminated)
    signal.signal(signal.SIGUSR1,lambda signum,frame:stop_request('operator-stop'))
    if ACTION=='main':main_trial()
    elif ACTION=='watchdog':out['cleanup']=watchdog();assert out['cleanup']['ok']
    elif ACTION=='emergency-cleanup':
        cleaning=True
        if DONE.exists():out['cleanup']=json.loads(DONE.read_text())
        else:out['cleanup']=clean_trial('watchdog-ended')
        assert out['cleanup']['ok']
    elif ACTION=='wait-cleanup':
        if not STATE.exists():out['preMutationExit']=True
        else:
            s=state()
            info=owned_info(WATCH,'watchdog','root',str(ROOT/'program.py'),s.get('watchInvocation'))
            if info.get('LoadState')=='not-found':
                assert not s.get('claimed') and not s.get('clients'),'resources-without-watchdog'
                cleaning=True
                for unit in (SLICE,GUARD_SLICE):
                    cmd('stopUnusedSlice:'+unit,['/usr/bin/systemctl','stop',unit],5,allowed=(0,5))
                receipt={'ok':True,'errors':[],'reason':'pre-activation-failure','clients':{},'preActivationExit':True,'privatePayloadRetained':True}
                if not DONE.exists():atomic_json(DONE,receipt)
                out['cleanup']=receipt
            else:
                assert s.get('watchLaunchIntent')==description('watchdog')
                stop_request('helper-ended');out['cleanup']=wait_cleanup()
    elif ACTION=='verify':
        cleaning=True;s=state();out['cleanup']=wait_cleanup(85)
        until=time.monotonic()+12
        while time.monotonic()<until:
            if all(unit_info(unit).get('ActiveState') in ('inactive','failed') for unit in (HELPER,WATCH)):break
            time.sleep(.2)
        for unit in (*UNITS.values(),NBD_UNIT,HELPER,WATCH):out[unit]=dead(unit)
        assert not device_mounts(s['deviceNumber']) and (not SYS.exists() or idle())
        if s.get('moduleLoadedByFixture'):assert not P('/sys/module/nbd').exists()
        out['remoteCleanupVerified']=True
    elif ACTION=='request-stop':
        cleaning=True;s=state()
        owned_info(WATCH,'watchdog','root',str(ROOT/'program.py'),s.get('watchInvocation'))
        assert s.get('watchLaunchIntent')==description('watchdog')
        stop_request('operator-stop');out['stopRequested']=True
    elif ACTION=='socket-clear':
        cleaning=True;s=state();out['cleanup']=wait_cleanup(1)
        assert not device_mounts(s['deviceNumber']) and (not SYS.exists() or idle())
        clear_socket(s);out['socketClosedVerified']=True
    else:raise RuntimeError('unknown-action')
    out['ok']=True
except Exception as e:
    out['errors'].append(type(e).__name__+':'+str(e)[:180])
    if ACTION=='main':
        stop_request('main-error')
        try:
            if STATE.exists() and state().get('watchLaunchIntent'):
                info=owned_info(WATCH,'watchdog','root',str(ROOT/'program.py'),state().get('watchInvocation'))
                if info.get('LoadState')!='not-found':out['cleanup']=wait_cleanup()
        except Exception as cleanup_error:out['errors'].append('cleanup:'+type(cleanup_error).__name__)
finally:
    if client is not None:
        try:client.wait(timeout=3)
        except subprocess.TimeoutExpired:out['errors'].append('nbd-client-not-reaped');out['ok']=False
print(('STOP_POST_JSON=' if ACTION=='wait-cleanup' else 'RESULT_JSON=')+json.dumps(out,sort_keys=True),flush=True)
sys.exit(0 if out['ok'] and not out['errors'] else 2)
