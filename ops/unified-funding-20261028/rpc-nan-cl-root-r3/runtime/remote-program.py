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
ROOT=P('/run/enclave-rpc-nan-client-n3');M=json.loads((ROOT/'manifest.json').read_text());ACTION=sys.argv[1];STATE=ROOT/'state.json'
EXEC=P('/var/lib/enclave-rpc-nan-client-n3')
DEV=P('/dev/nbd7');SYS=P('/sys/block/nbd7');MOUNT=P('/srv/enclave-nan-cl-n3/volume')
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
last_guard=0
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
    if s.get('execIdentity') is not None:
        st=EXEC.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o755
        assert s['execIdentity']==[st.st_dev,st.st_ino],'exec-identity-drift'
    else:
        # An interrupted fresh mkdir/seal is retained. No client or NBD can launch before sealing.
        assert not s.get('claimed') and not s.get('clients'),'resources-before-executable-seal'
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
        cmd('detach',[str(EXEC/'nbd-client'),'-d',str(DEV)],8)
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

# Functions appended after qualified transport, before operations; no mutation on load.
last_pending_check=0

def timer_window(rows, admitted, horizon):
    import datetime
    def due(value):
        if value==['-']:return None
        return datetime.datetime.strptime(' '.join(value),'%a %Y-%m-%d %H:%M:%S %Z').replace(tzinfo=datetime.timezone.utc).timestamp()
    before={tuple(r[0]):due(r[1]) for r in admitted};after={tuple(r[0]):due(r[1]) for r in rows}
    assert set(before)==set(after),'timer-set-or-target-changed'
    for key,new in after.items():
        old=before[key]
        # OS work already due inside the reviewed horizon was included in its residual policy.
        # Randomized future timers may move outside this horizon without adding a commitment.
        if new is not None and new<=horizon and (old is None or old>horizon):
            raise AssertionError('timer-work-entered-admitted-window')


def fresh_nan_policy():
    global last_pending_check
    now=time.time();a=M['admission']
    assert a['authorized'] is True and a['nonce']==M['nonce']
    assert a['scope']=='nan-cl-only-4096' and a['observedPendingMiB']>=0
    assert a['osReserveMiB']==2048 and a['creatorClassification']=='two-launches-before-wait-no-repeated-allocator'
    assert a['at']<=now<=a['expiresAt'] and a['expiresAt']-a['at']<=600,'stale-Nan-admission'
    assert read('/proc/sys/kernel/random/boot_id')==M['bootId'],'Nan-boot-changed'
    if now-last_pending_check<5:return
    last_pending_check=now
    creator=P('/proc/1281392')
    assert (creator/'stat').read_text().rsplit(')',1)[1].split()[19]=='867080689','creator-replaced'
    assert str((creator/'exe').resolve(strict=True))=='/usr/bin/bash'
    assert hashlib.sha256((creator/'cmdline').read_bytes()).hexdigest()==a['creatorCmdlineSha256'],'creator-command-changed'
    assert str((creator/'cwd').resolve(strict=True))=='/root/padspill-20261005','creator-directory-changed'
    # Read only public executable identities/cgroup; never environments, pads or logs.
    count=0;until=time.monotonic()+3
    for q in P('/proc').iterdir():
        if not q.name.isdigit():continue
        count+=1;assert count<=512 and time.monotonic()<until,'pending-census-bound'
        try:
            exe=str((q/'exe').resolve(strict=True));cg=(q/'cgroup').read_text()
            if any('/'+x+'/' in cg or cg.strip().endswith('/'+x) for x in M['ownedSlices']):continue
            if any(cg.strip().endswith('/'+unit) for unit in M['ownedBootstrapUnits']):continue
            if cg.strip()=='0::/system.slice/cron.service':continue  # all cron sources pinned below; OS residual accounts this work
            if exe in ('/usr/bin/bash','/usr/bin/dash'):
                argv=(q/'cmdline').read_bytes().split(b'\0')
                if len(argv)==4 and argv[1]==b'-c' and argv[2].decode() in M['transportCommands']:continue
            if exe in ('/usr/bin/sudo','/usr/bin/systemd-run'):
                argv=[x.decode() for x in (q/'cmdline').read_bytes().split(b'\0') if x]
                if argv in M['transportArgv']:continue
            fields=(q/'stat').read_text().rsplit(')',1)[1].split()
            start=fields[19]
            if exe=='/usr/bin/pgrep' and fields[1]=='1281392':continue
            if exe in a['ordinaryOsExecutables']:continue
            identity=str(q.name)+':'+start+':'+exe
            assert identity in a['existingOtherProcesses'],'new-unclassified-workload'
        except FileNotFoundError:continue
    jobs=capture(['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager'],3,limit=8192)
    assert jobs['rc']==0 and not jobs['reason'],'pending-job-read'
    for line in jobs['stdout'].splitlines():
        fields=line.split();assert len(fields)>=4 and fields[1] in M['ownedUnits'],'unclassified-pending-job'
    timers=capture(['/usr/bin/systemctl','list-timers','--all','--no-legend','--no-pager'],3,limit=16384)
    assert timers['rc']==0 and not timers['reason'] and not timers['truncated'],'timer-read'
    timer_rows=sorted([line.split()[-2:],line.split()[:4] if line.split()[0]!='-' else ['-']] for line in timers['stdout'].splitlines() if line.strip())
    timer_window(timer_rows,a['timerRows'],a['expiresAt'])
    props=capture(['/usr/bin/systemctl','show',*sorted(a['timerUnitPaths']),'--property=Id,FragmentPath,DropInPaths'],4,limit=32768)
    assert props['rc']==0 and not props['reason'] and not props['truncated'],'timer-config-read'
    rows={}
    for block in props['stdout'].strip().split('\n\n'):
        values=dict(line.split('=',1) for line in block.splitlines() if '=' in line)
        if values:rows[values.pop('Id')]=values
    assert rows==a['timerUnitPaths'],'timer-unit-configuration-path-changed'
    for record in a['timerConfigFiles']:
        q=P(record['path']);assert q.is_file() and sha(q)==record['sha256'],'timer-configuration-content-changed'
    queued=capture(['/usr/bin/atq'],3,limit=4096)
    assert queued['rc']==0 and not queued['reason'] and not queued['stdout'].strip(),'pending-at-job'
    for row in a['scheduleDirectories']:
        names=[]
        with os.scandir(row['path']) as entries:
            for entry in entries:
                names.append(entry.name);assert len(names)<=128,'schedule-directory-bound'
        assert sorted(names)==row['entries'],'scheduled-work-added-or-removed'
    for row in a['scheduleFiles']:
        q=P(row['path']);assert q.is_file() and sha(q)==row['sha256'],'scheduled-work-changed'

def nan_headroom():
    global last_guard
    if cleaning or ACTION in ('verify','wait-cleanup','emergency-cleanup','request-stop','socket-clear'):return
    now=time.monotonic()
    if now-last_guard<.5:return
    last_guard=now;fresh_nan_policy()
    available=next(int(l.split()[1])*1024 for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
    pending=M['admission']['observedPendingMiB']<<20;groups=[]
    for name,mib in zip(M['ownedSlices'],(4096,128,128)):
        q=P('/sys/fs/cgroup')/name;current=int(read(q/'memory.current')) if q.exists() else 0
        if q.exists():assert read(q/'memory.max')==str(mib<<20) and read(q/'memory.swap.max')=='0','trial-budget-drift'
        pending+=max(0,(mib<<20)-current);groups.append({'path':str(q),'maximum':mib<<20,'current':current})
    assert available-pending>=2048<<20,'Nan-residual-reserve'
    out['lastHeadroom']={'available':available,'remainingTrialAndPending':pending,'residual':available-pending,'floor':2048<<20,'groups':groups,'policyNotWorstCaseReservation':True}
def checked_headroom():
    try:nan_headroom()
    except Exception as error:
        out['guardFailure']={'type':type(error).__name__,'message':str(error)[:180]}
        raise
headroom=checked_headroom
CAPTURE_GUARD=headroom

"""Bounded FD-anchored metadata-only ownership migration of a PRIVATE COW.
No mutation on import. Root parent stays 0700 until caller verifies completion.
"""
import os, stat, time, json, hashlib

def remap_tree(root, old, new, ledger=None, tick=lambda:None, seconds=60):
    deadline=time.monotonic()+seconds
    records={};count=0;encoded=0;device=None
    def budget():
        tick()
        if time.monotonic()>=deadline:raise RuntimeError('ownership-time-bound')
    def metadata(fd):
        s=os.fstat(fd)
        if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):raise RuntimeError('ownership-file-type')
        if s.st_mode & 0o6022:raise RuntimeError('ownership-privilege-or-write-mode')
        if stat.S_ISREG(s.st_mode) and s.st_nlink!=1:raise RuntimeError('ownership-hardlink')
        names=os.listxattr(fd)
        if len(names)>16:raise RuntimeError('ownership-xattr-count')
        attrs={};total=0
        for name in names:
            if name.startswith(('system.posix_acl_','security.','trusted.')):raise RuntimeError('ownership-privileged-xattr')
            value=os.getxattr(fd,name);total+=len(value)+len(name)
            if total>4096:raise RuntimeError('ownership-xattr-bound')
            attrs[name]=hashlib.sha256(value).hexdigest()
        return [s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_size,s.st_mtime_ns,s.st_nlink,attrs]
    def walk(parent,name,rel,depth):
        nonlocal count,encoded,device
        budget()
        if depth>32:raise RuntimeError('ownership-depth')
        before=os.stat(name,dir_fd=parent,follow_symlinks=False)
        if not (stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode)):raise RuntimeError('ownership-file-type')
        if stat.S_ISREG(before.st_mode) and before.st_nlink!=1:raise RuntimeError('ownership-hardlink')
        if before.st_mode&0o6022:raise RuntimeError('ownership-privilege-or-write-mode')
        if (before.st_uid,before.st_gid)!=old:raise RuntimeError('ownership-source-identity')
        if device is not None and before.st_dev!=device:raise RuntimeError('ownership-cross-device')
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK|(os.O_DIRECTORY if stat.S_ISDIR(before.st_mode) else 0),dir_fd=parent)
        try:
            opened=os.fstat(fd)
            if (opened.st_dev,opened.st_ino,opened.st_mode,opened.st_uid,opened.st_gid,opened.st_size,opened.st_mtime_ns,opened.st_nlink)!=(before.st_dev,before.st_ino,before.st_mode,before.st_uid,before.st_gid,before.st_size,before.st_mtime_ns,before.st_nlink):raise RuntimeError('ownership-open-race')
            row=metadata(fd);budget()
            if device is None:device=row[0]
            if row[0]!=device:raise RuntimeError('ownership-cross-device')
            count+=1;encoded+=len(json.dumps([rel,row],separators=(',',':')).encode())
            if count>20000 or encoded>3<<20:raise RuntimeError('ownership-ledger-bound')
            expected=ledger.get(rel) if ledger is not None else None
            if ledger is None:
                if tuple(row[3:5])!=old:raise RuntimeError('ownership-source-identity')
            else:
                if expected!=row:raise RuntimeError('ownership-preflight-drift')
                budget();os.fchown(fd,*new)
                after=metadata(fd);want=list(row);want[3:5]=list(new)
                if after!=want:raise RuntimeError('ownership-metadata-changed')
                row=after
            records[rel]=row
            if stat.S_ISDIR(row[2]):
                seen=set()
                with os.scandir(fd) as entries:
                    for entry in entries:
                        budget();n=entry.name
                        if n in seen or len(n.encode())>255:raise RuntimeError('ownership-entry-name')
                        seen.add(n)
                        if len(seen)>20000:raise RuntimeError('ownership-directory-count')
                        walk(fd,n,rel+'/'+n,depth+1)
                if ledger is not None:os.fsync(fd)
            elif ledger is not None:os.fsync(fd)
            after=metadata(fd)
            if after!=row:raise RuntimeError('ownership-concurrent-metadata-change')
        finally:os.close(fd)
    base=os.open(root,os.O_RDONLY|os.O_NOFOLLOW|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        device=os.fstat(base).st_dev
        for name in ('cl','tmp-cl'):walk(base,name,name,0)
        if ledger is not None and set(records)!=set(ledger):raise RuntimeError('ownership-tree-changed')
        if ledger is not None:os.fsync(base)
    finally:os.close(base)
    budget()
    return records

# PREPARED ONLY. Appended to the qualified transport/ownership helpers.
import pwd,grp,secrets,shutil,urllib.request,urllib.error,contextlib
PAYLOAD=EXEC/'payload';SLICE='enclavenantrialn3.slice';GUARD_SLICE='enclavenanguardn3.slice';ATTACH_SLICE='enclavenanattachn3.slice';NBD_UNIT='enclave-rpc-nan-nbd-n3.service'
UNITS={'cl':'enclave-rpc-nan-cl-trial-n3.service'}
HELPER='enclave-rpc-nan-helper-n3.service';WATCH='enclave-rpc-nan-watch-n3.service'
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
def create_identities():
    import pwd,grp
    ident=M['identities']['cl'];jwt=M['jwtGroup']
    assert ident['uid']==50011 and ident['gid']==50011 and ident['name']=='enclavenancl'
    assert jwt=={'name':'enclavenanjwt','gid':50012}
    users=pwd.getpwall();groups=grp.getgrall()
    assert not any(x.pw_uid==50011 or x.pw_name==ident['name'] or x.pw_gid in (50011,50012) for x in users),'new-UID-unavailable'
    assert not any(x.gr_gid in (50011,50012) or x.gr_name in (ident['name'],jwt['name']) for x in groups),'new-GID-unavailable'
    count=0
    for q in P('/proc').iterdir():
        if not q.name.isdigit():continue
        count+=1;assert count<=512
        try:fields=dict(x.split(':',1) for x in (q/'status').read_text().splitlines() if ':' in x)
        except FileNotFoundError:continue
        assert 50011 not in map(int,fields['Uid'].split()),'new-process-UID-collision'
        assert not {50011,50012}.intersection(map(int,(fields['Gid']+' '+fields['Groups']).split())),'new-process-GID-collision'
    for name,gid in ((ident['name'],50011),(jwt['name'],50012)):
        st=state();st.setdefault('identityMutationIntents',[]).append({'kind':'group','name':name,'gid':gid});save(st)
        cmd('createGroup:'+name,['/usr/sbin/groupadd','--gid',str(gid),name],5)
        g=grp.getgrnam(name);assert g.gr_gid==gid and not g.gr_mem
        st=state();st.setdefault('createdGroups',[]).append({'name':name,'gid':gid});save(st)
    st=state();st.setdefault('identityMutationIntents',[]).append({'kind':'user','name':ident['name'],'uid':50011,'gid':50011});save(st)
    cmd('createClientUser',['/usr/sbin/useradd','--uid','50011','--gid','50011','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',ident['name']],5)
    u=pwd.getpwnam(ident['name']);assert (u.pw_uid,u.pw_gid,u.pw_dir,u.pw_shell)==(50011,50011,'/nonexistent','/usr/sbin/nologin')
    st=state();st['createdUsers']=[{'name':ident['name'],'uid':50011,'gid':50011}];save(st)

def create_slice():
    # Bootstrap owns and configures all caps before library guard; do not reload timers again.
    for name,mib in zip(M['ownedSlices'],(4096,128,128)):
        info=unit_info(name)
        assert info.get('Description')=='Nan CL '+M['nonce']+' '+name and info.get('ActiveState')=='active','owned-slice-identity'
        q=P('/sys/fs/cgroup')/name
        assert read(q/'memory.max')==str(mib<<20) and read(q/'memory.swap.max')=='0','owned-slice-cap'
def description(role):return 'Enclave L1 '+M['nonce']+' '+role
def owned_info(unit,role,user,executable,expected=None):
    info=unit_info(unit)
    if info.get('LoadState')=='not-found':return info
    assert info.get('Transient')=='yes' and info.get('Description')==description(role),'foreign-unit-description'
    assert info.get('User') in (user, '0' if user=='root' else user),'foreign-unit-user'
    assert executable in info.get('ExecStart',''),'foreign-unit-command'
    if expected:assert info.get('InvocationID')==expected,'unit-invocation-drift'
    return info
def start_client(side):
    identity=M['identities'][side];data=str(MOUNT/('data' if side=='el' else 'cl'));tmp=str(MOUNT/('tmp' if side=='el' else 'tmp-cl'))
    argv=['/usr/bin/systemd-run','--quiet','--unit='+UNITS[side],'--slice='+SLICE,'--description='+description(side),'--property=Type=exec',
          '--property=User='+identity['name'],'--property=Group='+identity['name'],
          '--property=SupplementaryGroups='+M['jwtGroup']['name'],
          '--property=NoNewPrivileges=yes','--property=ProtectSystem=strict','--property=ProtectHome=yes',
          '--property=PrivateTmp=yes','--property=InaccessiblePaths='+str(MOUNT/'data')+' '+str(MOUNT/'tmp'),'--property=ReadWritePaths='+data+' '+tmp,
          '--property=UMask=0027','--property=MemorySwapMax=0','--property=TasksMax=512',
          '--property=LimitNOFILE=65536','--property=OOMScoreAdjust=100',
          '--property=KillMode=control-group','--property=KillSignal=SIGINT','--property=TimeoutStopSec=45',
          '--property=Restart=no','--property=BindsTo='+WATCH,
          '/usr/bin/python3','-I','-B',str(PAYLOAD/'chain_service.py'),side]
    s=state();s.setdefault('clientLaunchIntents',{})[side]={'description':description(side),'unit':UNITS[side],'executable':str(PAYLOAD/'chain_service.py'),'user':identity['name']};save(s)
    cmd('start:'+side,argv,8)
    info=owned_info(UNITS[side],side,identity['name'],str(PAYLOAD/'chain_service.py'))
    s=state();s.setdefault('clients',{})[side]=info;save(s)
    invocation=info.get('InvocationID')
    if invocation:
        out['initialClientJournal']=cmd('initialLog:'+side,['/usr/bin/journalctl','--no-pager','-o','cat','-n','20','_SYSTEMD_INVOCATION_ID='+invocation],4)
    assert info.get('User')==identity['name'] and info.get('Group')==identity['name'],'client-start-identity'
    cg=info.get('ControlGroup');assert cg=='/'+SLICE+'/'+UNITS[side],'client-not-started:'+str(info.get('Result'))
    q=P('/sys/fs/cgroup'+cg)
    if q.exists():
        st=q.stat();info['cgroupIdentity']=[st.st_dev,st.st_ino]
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
    value={}
    for name,url,request in (
        ('cl','http://127.0.0.1:15052/eth/v1/node/syncing',None),):
        try:
            data=json.dumps(request).encode() if request else None
            req=urllib.request.Request(url,data,{'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=1) as response:raw=response.read(65537)
            assert len(raw)<=65536;value[name]=json.loads(raw)
        except Exception as e:value[name]={'unavailable':type(e).__name__}
    return value
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
            receipt['identityMutationIntents']=s.get('identityMutationIntents',[])
            receipt['identityReconciliation']=[]
            for intent in receipt['identityMutationIntents']:
                row=dict(intent)
                try:
                    if intent['kind']=='group':
                        g=grp.getgrnam(intent['name']);row['observedExact']=(g.gr_gid==intent['gid'] and not g.gr_mem)
                    else:
                        u=pwd.getpwnam(intent['name']);row['observedExact']=(u.pw_uid==intent['uid'] and u.pw_gid==intent['gid'] and u.pw_dir=='/nonexistent' and u.pw_shell=='/usr/sbin/nologin')
                except KeyError:row['observedAbsent']=True
                receipt['identityReconciliation'].append(row)
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
    # This service has its own128MiB cap outside the4096MiB client slice.
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
            if STOP.exists():break
            time.sleep(.5)
    except Exception as e:reason='watchdog:'+type(e).__name__+':'+str(e)[:100]
    return clean_trial(reason)
def wait_cleanup(seconds=85):
    until=time.monotonic()+seconds
    while not DONE.exists() and time.monotonic()<until:time.sleep(.2)
    assert DONE.is_file(),'watchdog-cleanup-missing'
    value=json.loads(DONE.read_text());assert value['ok'] and not value['errors'],'watchdog-cleanup-failed'
    return value

EXT4_IDENTITY_PROBE="import os,sys,stat,mmap,struct,uuid,json\n\ndef crc32c(raw):\n    value=0xffffffff\n    for byte in raw:\n        value^=byte\n        for _ in range(8):value=(value>>1)^(0x82f63b78 if value&1 else 0)\n    return value\n\ndef decode_superblock(raw, expected):\n    assert len(raw)==4096,'short-ext4-identity-read'\n    sb=raw[1024:2048]\n    assert struct.unpack_from('<H',sb,0x38)[0]==0xef53,'ext4-magic'\n    if struct.unpack_from('<I',sb,0x64)[0]&0x400:\n        assert sb[0x175]==1,'ext4-checksum-type'\n        assert crc32c(sb[:0x3fc])==struct.unpack_from('<I',sb,0x3fc)[0],'ext4-superblock-checksum'\n    actual=str(uuid.UUID(bytes=sb[0x68:0x78]))\n    assert actual==expected,'filesystem-uuid'\n    state=struct.unpack_from('<H',sb,0x3a)[0];incompat=struct.unpack_from('<I',sb,0x60)[0]\n    assert state==1 and not incompat&4 and not struct.unpack_from('<I',sb,0x64)[0]&0x10000,'filesystem-needs-recovery-before-read'\n    return {'uuid':actual,'state':state,'incompat':incompat,'bytesRead':4096,'offset':0,'direct':True}\n\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_DIRECT)\ntry:\n    st=os.fstat(fd)\n    assert stat.S_ISBLK(st.st_mode) and str(os.major(st.st_rdev))+':'+str(os.minor(st.st_rdev))==sys.argv[2],'block-device-identity'\n    with mmap.mmap(-1,4096) as aligned:\n        count=os.preadv(fd,[aligned],0)\n        assert count==4096,'short-ext4-identity-read'\n        result=decode_superblock(aligned[:],sys.argv[3])\nfinally:os.close(fd)\nprint(json.dumps(result))\n"
# PREPARED ONLY. Root reviews the complete combined program before one trial.
def seal_payload():
    EXEC.mkdir(mode=0o755);EXEC.chmod(0o755)
    st=EXEC.stat();s=state();s['execIdentity']=[st.st_dev,st.st_ino];save(s)
    PAYLOAD.mkdir(mode=0o755);(PAYLOAD/'bin').mkdir(mode=0o755)
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
    source=P(M['client']['path']);nst=source.lstat();assert stat.S_ISREG(nst.st_mode) and nst.st_size==56376,'NBD-upload-type-size'
    data=source.read_bytes();assert hashlib.sha256(data).hexdigest()==M['client']['sha256']
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
    assert not STATE.exists() and not MOUNT.exists() and not MOUNT.parent.exists(),'trial-runtime-or-mount-preexists'
    assert executable_policy()
    st=ROOT.stat();socket_path=P(M['remoteSocket']);socket_stat=socket_path.lstat();parent_stat=socket_path.parent.lstat()
    assert stat.S_ISSOCK(socket_stat.st_mode) and socket_stat.st_uid==M['sshUid'] and stat.S_IMODE(socket_stat.st_mode)==0o600
    assert stat.S_ISDIR(parent_stat.st_mode) and parent_stat.st_uid==M['sshUid'] and stat.S_IMODE(parent_stat.st_mode)==0o700
    s={'nonce':M['nonce'],'unitPrefix':M['unitPrefix'],'rootIdentity':[st.st_dev,st.st_ino],
       'execIdentity':None,'claimed':False,'clients':{},'watchStarted':False,'socketIdentity':[socket_stat.st_dev,socket_stat.st_ino],
       'helperPid':os.getpid(),'helperStart':P('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],
       'watchdogDeadline':time.time()+300,'moduleInitiallyLoaded':P('/sys/module/nbd').exists(),'moduleLoadedByFixture':False}
    save(s)
    out['runtimeLibraries']=library_receipt()
    seal_payload();MOUNT.parent.mkdir(mode=0o700);MOUNT.mkdir(mode=0o700)
    s=state()
    with LOCK.open('x'):pass
    create_slice()
    s['watchLaunchIntent']=description('watchdog');save(s)
    cmd('startWatchdog',['/usr/bin/systemd-run','--quiet','--unit='+WATCH,'--slice='+GUARD_SLICE,'--description='+description('watchdog'),'--property=Type=exec','--property=User=root',
        '--property=MemoryMax=128M','--property=MemorySwapMax=0','--property=CPUQuota=50%',
        '--property=TasksMax=32','--property=RuntimeMaxSec=380','--property=TimeoutStopSec=70',
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
        assert stat.S_ISSOCK(st.st_mode) and st.st_uid==M['sshUid'] and stat.S_IMODE(st.st_mode)==0o600
        assert stat.S_ISDIR(ps.st_mode) and ps.st_uid==M['sshUid'] and stat.S_IMODE(ps.st_mode)==0o700
        out['exportInfo']=probe(M['exportName']);s['socketIdentity']=[st.st_dev,st.st_ino]
        s['claimed']=True;s['attachCgroup']='0::/'+ATTACH_SLICE+'/'+NBD_UNIT;s['nbdLaunchIntent']=description('nbd');save(s)
        cmd('startNBDUnit',['/usr/bin/systemd-run','--quiet','--unit='+NBD_UNIT,'--slice='+ATTACH_SLICE,
            '--description='+description('nbd'),'--property=Type=exec','--property=User=root','--property=MemoryMax=128M',
            '--property=MemorySwapMax=0','--property=TasksMax=32','--property=KillMode=control-group',
            '--property=TimeoutStopSec=10','--property=RuntimeMaxSec=480',
            str(EXEC/'nbd-client'),'-n','-L','-u','-N',M['exportName'],'-t','5','-b','4096',M['remoteSocket'],str(DEV)],8)
        s['nbdInvocation']=owned_info(NBD_UNIT,'nbd','root',str(EXEC/'nbd-client')).get('InvocationID');save(s)
        until=time.monotonic()+8
        while (size()!=M['bytes'] or not pidof()) and time.monotonic()<until:time.sleep(.1)
        assert size()==M['bytes'] and pidof(),'attach-timeout'
        s['nbdPid']=pidof();assert unitof(s['nbdPid'])==s['attachCgroup'];save(s)
        out['filesystemIdentity']=json.loads(cmd('filesystemIdentityRead',['/usr/bin/python3','-B','-c',EXT4_IDENTITY_PROBE,str(DEV),s['deviceNumber'],M['uuid']],20))
        assert out['filesystemIdentity']['uuid']==M['uuid']
        cmd('readOnlyPreflightMount',['/usr/bin/mount','-t','ext4','-o','ro,noload,nosuid,nodev,noexec',str(DEV),str(MOUNT)],10)
        assert (MOUNT/'snapshot-complete').is_file() and (MOUNT/'cl/beacon/chain_db').is_dir(),'actual-CL-database-missing'
        for unit in UNITS.values():assert unit_info(unit).get('LoadState')=='not-found','unit-preexists:'+unit
        def ownership_tick():
            assert not STOP.exists(),'ownership-stop-requested';headroom()
        ownership_deadline=time.monotonic()+60
        ledger=remap_tree(str(MOUNT),(995,986),(50011,50011),tick=ownership_tick,seconds=ownership_deadline-time.monotonic())
        atomic_json(ROOT/'ownership-preflight.json',ledger)
        create_identities()
        cmd('unmountPreflight',['/usr/bin/umount',str(MOUNT)],10)
        cmd('privateCowWritableMount',['/usr/bin/mount','-t','ext4','-o','rw,nosuid,nodev,noexec',str(DEV),str(MOUNT)],10)
        assert len(mounts())==1 and mounts()[0][2]==s['deviceNumber'] and 'rw' in mounts()[0][5].split(',')
        changed=remap_tree(str(MOUNT),(995,986),(50011,50011),ledger=ledger,tick=ownership_tick,seconds=ownership_deadline-time.monotonic())
        verified=remap_tree(str(MOUNT),(50011,50011),(50011,50011),tick=ownership_tick,seconds=ownership_deadline-time.monotonic())
        assert changed==verified,'ownership-verification-mismatch'
        atomic_json(ROOT/'ownership-complete.json',{'entries':len(changed),'ledgerSha256':hashlib.sha256(json.dumps(changed,sort_keys=True).encode()).hexdigest(),'originalModified':False})
        os.chown(MOUNT.parent,0,50011);MOUNT.parent.chmod(0o710)
        jwt=PAYLOAD/'jwt.hex'
        with jwt.open('x') as f:f.write(secrets.token_hex(32));f.flush();os.fsync(f.fileno())
        os.chown(jwt,0,M['jwtGroup']['gid']);jwt.chmod(0o640)
        out['jwtCreatedPrivately']=True
        for side in ('cl',):
            info=start_client(side);s=state();s['clients'][side]=info;save(s)
    samples=[];until=time.monotonic()+90
    while time.monotonic()<until and not STOP.exists():
        headroom();sample={'at':time.time(),'clientMemory':sample_client_memory(s['clients'])}
        sample['rpc']=sample_rpc()
        q=P('/sys/fs/cgroup')/SLICE
        sample['memory']={n:read(q/n) for n in ('memory.current','memory.peak','memory.events')} if q.exists() else {'unavailable':'slice-removed'}
        samples.append(sample);time.sleep(2)
    out['samples']=samples
    out['clRpcObserved']=any(isinstance(x['rpc'].get('cl',{}).get('data'),dict) for x in samples)
    stop_request('bounded-trial-finished')
    out['cleanup']=wait_cleanup()
    for side,info in s['clients'].items():
        if info.get('InvocationID'):
            cmd('clientLog:'+side,['/usr/bin/journalctl','--no-pager','-o','cat','-n','40','_SYSTEMD_INVOCATION_ID='+info['InvocationID']],4)
    assert out['clRpcObserved'],'CL-RPC-startup-not-observed'
    assert out['cleanup']['reason']=='bounded-trial-finished','trial-stopped-by-watchdog'
    for info in out['cleanup']['clients'].values():
        assert info.get('Result')=='success' and info.get('ExecMainCode')=='1' and info.get('ExecMainStatus')=='0','client-not-gracefully-stopped'
    out['startupObserved']=True;out['productionReady']=False;out['engineOfflineExpected']=True
try:
    os.umask(0o077)
    assert os.geteuid()==0 and read('/proc/sys/kernel/random/boot_id')==M['bootId']
    assert sha(ROOT/'program.py')==M['programSha256']
    cg=read('/proc/self/cgroup');assert (cg.startswith('0::/enclavenanattachn3.slice/enclave-rpc-nan-') or cg.startswith('0::/enclavenanguardn3.slice/enclave-rpc-nan-')) and cg.endswith('.service')
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
        assert (not s.get('deviceNumber') or not device_mounts(s['deviceNumber'])) and (not SYS.exists() or idle())
        if s.get('moduleLoadedByFixture'):assert not P('/sys/module/nbd').exists()
        out['remoteCleanupVerified']=True
    elif ACTION=='request-stop':
        cleaning=True;s=state()
        owned_info(WATCH,'watchdog','root',str(ROOT/'program.py'),s.get('watchInvocation'))
        assert s.get('watchLaunchIntent')==description('watchdog')
        stop_request('operator-stop');out['stopRequested']=True
    elif ACTION=='socket-clear':
        cleaning=True;s=state();out['cleanup']=wait_cleanup(1)
        assert (not s.get('deviceNumber') or not device_mounts(s['deviceNumber'])) and (not SYS.exists() or idle())
        clear_socket(s);out['socketClosedVerified']=True
    else:raise RuntimeError('unknown-action')
    out['ok']=True
except Exception as e:
    out['errors'].append(type(e).__name__+':'+str(e)[:180])
    if ACTION=='main':
        if STATE.exists():
            for side,info in state().get('clients',{}).items():
                inv=info.get('InvocationID')
                if inv:
                    try:cmd('failureLog:'+side,['/usr/bin/journalctl','--no-pager','-o','cat','-n','40','_SYSTEMD_INVOCATION_ID='+inv],4)
                    except Exception:pass
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
