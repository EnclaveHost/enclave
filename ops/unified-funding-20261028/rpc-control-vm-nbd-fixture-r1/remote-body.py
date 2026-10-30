# PREPARED ONLY. Invoked by root in a dedicated bounded systemd unit.
import pathlib, json, hashlib, stat, socket, struct, errno, mmap, fcntl, sys, resource
P=pathlib.Path
M=json.loads(MANIFEST_JSON);ACTION=ACTION_VALUE
ROOT=P('/run/enclave-rpc-nbd-fixture-r1');STATE=ROOT/'state.json'
DEV=P('/dev/nbd7');SYS=P('/sys/block/nbd7');MOUNT=ROOT/'mnt'
out={'action':ACTION,'ok':False,'errors':[]};client=None;mounted=False
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
def state():
    s=json.loads(STATE.read_text())
    assert s.get('nonce')==M['nonce'] and s.get('unitPrefix')==M['unitPrefix'],'foreign-attempt-state'
    st=ROOT.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o700
    assert s['rootIdentity']==[st.st_dev,st.st_ino],'root-identity-drift'
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
        cmd('detach',['/run/enclave-rpc-nbd-fixture-r1/nbd-client','-d',str(DEV)],8)
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
                assert info and info['bytes']==M['bytes'] and info['flags']&1 and info['flags']&4 and info['flags']&8,'export-size-flush-fua'
                sock.sendall(struct.pack('>QII',opts,2,0));return info
        raise RuntimeError('NBD-reply-limit')
try:
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_FSIZE,(1<<20,1<<20))
    assert os.geteuid()==0 and read('/proc/sys/kernel/random/boot_id')==M['bootId']
    cg=read('/proc/self/cgroup');assert cg.startswith('0::/system.slice/enclave-rpc-nbd-fixture-') and cg.endswith('.service')
    c=P('/sys/fs/cgroup'+cg[3:]);assert read(c/'memory.max')==str(256<<20) and read(c/'memory.swap.max')=='0'
    if ACTION not in ('cleanup','verify','stop-post'):
        available=next(int(l.split()[1]) for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
        assert available>=5632*1024,'memory-floor'
    for row in M['remotePins']:pin(row)
    def termination(signum,frame):raise RuntimeError('unit-termination')
    signal.signal(signal.SIGTERM,termination)
    if ACTION=='bootstrap':
        ROOT.mkdir(mode=0o700);MOUNT.mkdir(mode=0o700)
        assert not ROOT.is_symlink()
        loaded=P('/sys/module/nbd').exists()
        st=ROOT.stat();s={'nonce':M['nonce'],'unitPrefix':M['unitPrefix'],'rootIdentity':[st.st_dev,st.st_ino],'moduleInitiallyLoaded':loaded,'moduleLoadedByFixture':False,'claimed':False}
        with (ROOT/'stop-post.py').open('x') as f:f.write(STOP_POST_SOURCE);f.flush();os.fsync(f.fileno())
        (ROOT/'stop-post.py').chmod(0o700)
        s['stopPostSha256']=sha(ROOT/'stop-post.py');save(s)
        data=P(M['client']['path']).read_bytes();assert hashlib.sha256(data).hexdigest()==M['client']['sha256']
        with (ROOT/'nbd-client').open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        (ROOT/'nbd-client').chmod(0o700)
        if not loaded:
            # Save ownership before loading so an interrupted load remains collectable.
            s['moduleLoadedByFixture']=True;save(s)
            cmd('loadModule',['/usr/sbin/modprobe','nbd','nbds_max=8','max_part=0'])
        assert DEV.is_block_device() and SYS.is_dir() and idle(),'nbd7-not-idle'
        st=DEV.stat();s['deviceNumber']=str(os.major(st.st_rdev))+':'+str(os.minor(st.st_rdev))
        assert not device_mounts(s['deviceNumber']),'preexisting-device-mount'
        save(s);out['state']=s
    elif ACTION in ('write','read','disconnect'):
        assert ROOT.stat().st_uid==0 and stat.S_IMODE(ROOT.stat().st_mode)==0o700 and not ROOT.is_symlink()
        s=state();assert idle() and not device_mounts(s['deviceNumber'])
        assert sha(ROOT/'nbd-client')==M['client']['sha256']
        q=P(M['remoteSocket']);until=time.monotonic()+5
        while not q.exists() and time.monotonic()<until:time.sleep(.1)
        st=q.lstat();parent=q.parent.lstat()
        assert stat.S_ISSOCK(st.st_mode) and stat.S_IMODE(st.st_mode)==0o600 and st.st_uid==1000
        assert stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode)==0o700 and parent.st_uid==1000
        out['exportInfo']=probe(M['exportName']);out['unknownExport']=probe(M['exportName']+'-wrong',True)
        time.sleep(.2)
        s['claimed']=True;s['attachCgroup']=cg;s['socketIdentity']=[st.st_dev,st.st_ino];save(s)
        log=(ROOT/(ACTION+'-client.log')).open('xb')
        client=subprocess.Popen([str(ROOT/'nbd-client'),'-n','-L','-u','-N',M['exportName'],'-t','5','-b','4096',M['remoteSocket'],str(DEV)],
                                stdin=subprocess.DEVNULL,stdout=log,stderr=log,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'},start_new_session=True)
        until=time.monotonic()+8
        while (size()!=M['bytes'] or not pidof()) and time.monotonic()<until:time.sleep(.1)
        assert size()==M['bytes'] and pidof(),'attach-timeout'
        s['nbdPid']=pidof();assert unitof(s['nbdPid'])==cg,'attach-owner';save(s)
        uuid=cmd('filesystemUuid',['/usr/sbin/blkid','-p','-s','UUID','-o','value',str(DEV)]).strip()
        assert uuid==M['uuid'],'filesystem-uuid'
        if ACTION in ('write','read'):
            cmd('mount',['/usr/bin/mount','-t','ext4','-o','rw,nosuid,nodev,noexec',str(DEV),str(MOUNT)])
            assert len(mounts())==1 and mounts()[0][2]==s['deviceNumber']
            file=MOUNT/'durability.bin';data=(M['payload']+'\n').encode()*4096
            if ACTION=='write':
                with file.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
                d=os.open(MOUNT,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(d)
                finally:os.close(d)
            else:assert file.read_bytes()==data,'reopen-data-mismatch'
            out['dataSha256']=sha(file);out['dataBytes']=len(data)
        else:
            # Unmounted O_DIRECT read after tunnel loss cannot pass from page cache.
            print('READY_DISCONNECT',flush=True);time.sleep(2)
            fd=os.open(DEV,os.O_RDONLY|os.O_DIRECT);buf=mmap.mmap(-1,4096)
            try:
                os.lseek(fd,8<<20,os.SEEK_SET)
                try:os.readv(fd,[buf])
                except OSError as e:
                    assert e.errno in (errno.EIO,errno.ENODEV,errno.ENOTCONN,errno.ESHUTDOWN,errno.ETIMEDOUT)
                    out['disconnectErrno']=e.errno
                else:raise RuntimeError('read-succeeded-after-disconnect')
            finally:buf.close();os.close(fd)
        detach(s)
    elif ACTION=='stop-post':
        s=state();assert sha(ROOT/'stop-post.py')==s['stopPostSha256']
        if SYS.exists() and 'deviceNumber' in s:detach(s)
        elif SYS.exists():assert idle(),'partial-bootstrap-active-device'
        out['stopPostDetached']=not SYS.exists() or idle()
    elif ACTION=='cleanup':
        assert ROOT.is_dir() and ROOT.stat().st_uid==0
        s=state()
        if SYS.exists():detach(s)
        for name in ('bootstrap','write','read','disconnect'):
            unit='enclave-rpc-nbd-fixture-'+name+'-r1.service'
            cmd('stop:'+name,['/usr/bin/systemctl','stop',unit],8,allowed=(0,5))
        if s.get('moduleLoadedByFixture') and P('/sys/module/nbd').exists():
            for q in P('/sys/block').glob('nbd*'):
                assert int(read(q/'size'))==0 and (not(q/'pid').exists() or read(q/'pid') in ('','0')) and not list((q/'holders').iterdir()),'other-nbd-active'
            cmd('unloadModule',['/usr/sbin/modprobe','-r','nbd'],8)
        s['cleanupCompleted']=True;save(s);out['state']=s
    elif ACTION=='socket-clear':
        s=state();assert idle() and not device_mounts(s['deviceNumber']);clear_socket(s)
    elif ACTION=='verify':
        s=state();assert s.get('cleanupCompleted') and not device_mounts(s['deviceNumber'])
        assert not SYS.exists() or idle()
        if s.get('moduleLoadedByFixture'):assert not P('/sys/module/nbd').exists()
        units=[]
        for name in ('bootstrap','write','read','disconnect','socket-clear-1','socket-clear-2','cleanup'):
            unit='enclave-rpc-nbd-fixture-'+name+'-r1.service'
            value=cmd('unit:'+name,['/usr/bin/systemctl','show',unit,'--property=ActiveState,SubState,ControlGroup,MainPID,InvocationID'],3)
            props=dict(l.split('=',1) for l in value.splitlines() if '=' in l)
            assert props.get('ActiveState') in ('inactive','failed') and props.get('MainPID')=='0','unit-still-live'
            if props.get('ControlGroup'):
                path=P('/sys/fs/cgroup'+props['ControlGroup'])
                assert not path.exists() or all(not p.read_text().strip() for p in path.rglob('cgroup.procs')),'unit-processes-remain'
            units.append(props)
        clear_socket(s)
        out['units']=units;out['remoteCleanupVerified']=True
    else:raise RuntimeError('unknown-action')
    out['ok']=True
except Exception as e:out['errors'].append(type(e).__name__+':'+str(e)[:200])
finally:
    if ACTION in ('write','read','disconnect') and STATE.exists():
        try:detach(state())
        except Exception as e:out['ok']=False;out['errors'].append('cleanup:'+type(e).__name__+':'+str(e)[:160])
    if client is not None:
        try:client.wait(timeout=3)
        except subprocess.TimeoutExpired:
            client.kill()
            try:client.wait(timeout=2)
            except Exception as e:out['ok']=False;out['errors'].append('client:'+type(e).__name__)
print(('STOP_POST_JSON=' if ACTION=='stop-post' else 'RESULT_JSON=')+json.dumps(out,sort_keys=True),flush=True)
sys.exit(0 if out['ok'] and not out['errors'] else 2)
