# PREPARED ONLY. Invoked by root in a dedicated bounded systemd unit.
import pathlib, json, hashlib, stat, socket, struct, errno, mmap, fcntl, sys, resource, tomllib
P=pathlib.Path
M=json.loads(MANIFEST_JSON);ACTION=ACTION_VALUE
ROOT=P('/run/enclave-rpc-l1-metadata-r1');STATE=ROOT/'state.json'
EXEC=P('/var/lib/enclave-rpc-l1-metadata-r1')
DEV=P('/dev/nbd7');SYS=P('/sys/block/nbd7');MOUNT=ROOT/'mnt'
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
    if cleaning or ACTION in ('cleanup','verify','stop-post'):return
    now=time.monotonic()
    if now-last_guard<.5:return
    last_guard=now
    available=next(int(l.split()[1])*1024 for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
    growth=0
    for unit,mib in M['serviceCapsMiB'].items():
        q=P('/sys/fs/cgroup/system.slice')/unit
        maximum=int(read(q/'memory.max'));current=int(read(q/'memory.current'))
        assert maximum==mib*(1<<20),'existing-service-cap-changed'
        growth+=max(0,maximum-current)
    cg=read('/proc/self/cgroup');q=P('/sys/fs/cgroup'+cg[3:]);maximum=int(read(q/'memory.max'));current=int(read(q/'memory.current'))
    residual=available-growth-max(0,maximum-current)
    assert residual>=1536*(1<<20),'service-growth-residual-floor'
    out['lastHeadroom']={'available':available,'existingRemainingCapGrowth':growth,'helperMaximum':maximum,'helperCurrent':current,'residual':residual,'floor':1536*(1<<20)}
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
    st=EXEC.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o700
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
        cmd('detach',['/var/lib/enclave-rpc-l1-metadata-r1/nbd-client','-d',str(DEV)],8)
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
                assert info and info['bytes']==M['bytes'] and info['flags']&1 and info['flags']&2,'export-size-readonly'
                sock.sendall(struct.pack('>QII',opts,2,0));return info
        raise RuntimeError('NBD-reply-limit')
try:
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_FSIZE,(1<<20,1<<20))
    assert os.geteuid()==0 and read('/proc/sys/kernel/random/boot_id')==M['bootId']
    cg=read('/proc/self/cgroup');assert cg.startswith('0::/system.slice/enclave-rpc-l1-metadata-') and cg.endswith('.service')
    c=P('/sys/fs/cgroup'+cg[3:]);assert read(c/'memory.max')==str(256<<20) and read(c/'memory.swap.max')=='0'
    if ACTION not in ('cleanup','verify','stop-post'):
        available=next(int(l.split()[1]) for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
        headroom()
    for row in M['remotePins']:pin(row)
    def termination(signum,frame):raise RuntimeError('unit-termination')
    signal.signal(signal.SIGTERM,termination)
    if ACTION=='policy':
        out['executableMount']=executable_policy();out['runMount']=mount_policy('/run')
    elif ACTION=='bootstrap':
        out['executableMount']=executable_policy();out['runMount']=mount_policy('/run')
        ROOT.mkdir(mode=0o700);MOUNT.mkdir(mode=0o700);EXEC.mkdir(mode=0o700)
        assert not ROOT.is_symlink()
        loaded=P('/sys/module/nbd').exists()
        st=ROOT.stat();s={'nonce':M['nonce'],'unitPrefix':M['unitPrefix'],'rootIdentity':[st.st_dev,st.st_ino],'execIdentity':[EXEC.stat().st_dev,EXEC.stat().st_ino],'moduleInitiallyLoaded':loaded,'moduleLoadedByFixture':False,'claimed':False}
        with (ROOT/'stop-post.py').open('x') as f:f.write(STOP_POST_SOURCE);f.flush();os.fsync(f.fileno())
        (ROOT/'stop-post.py').chmod(0o700)
        s['stopPostSha256']=sha(ROOT/'stop-post.py');save(s)
        data=P(M['client']['path']).read_bytes();assert hashlib.sha256(data).hexdigest()==M['client']['sha256']
        with (EXEC/'nbd-client').open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        (EXEC/'nbd-client').chmod(0o700)
        if not loaded:
            # Save ownership before loading so an interrupted load remains collectable.
            s['moduleLoadedByFixture']=True;save(s)
            cmd('loadModule',['/usr/sbin/modprobe','nbd','nbds_max=8','max_part=0'])
        assert DEV.is_block_device() and SYS.is_dir() and idle(),'nbd7-not-idle'
        st=DEV.stat();s['deviceNumber']=str(os.major(st.st_rdev))+':'+str(os.minor(st.st_rdev))
        assert not device_mounts(s['deviceNumber']),'preexisting-device-mount'
        save(s);out['state']=s
    elif ACTION=='read':
        assert ROOT.stat().st_uid==0 and stat.S_IMODE(ROOT.stat().st_mode)==0o700 and not ROOT.is_symlink()
        s=state();assert idle() and not device_mounts(s['deviceNumber'])
        assert sha(EXEC/'nbd-client')==M['client']['sha256']
        q=P(M['remoteSocket']);until=time.monotonic()+5
        while not q.exists() and time.monotonic()<until:time.sleep(.1)
        st=q.lstat();parent=q.parent.lstat()
        assert stat.S_ISSOCK(st.st_mode) and stat.S_IMODE(st.st_mode)==0o600 and st.st_uid==1000
        assert stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode)==0o700 and parent.st_uid==1000
        out['exportInfo']=probe(M['exportName']);out['unknownExport']=probe(M['exportName']+'-wrong',True)
        time.sleep(.2)
        s['claimed']=True;s['attachCgroup']=cg;s['socketIdentity']=[st.st_dev,st.st_ino];save(s)
        log=(ROOT/(ACTION+'-client.log')).open('xb')
        client=subprocess.Popen([str(EXEC/'nbd-client'),'-n','-L','-R','-u','-N',M['exportName'],'-t','5','-b','4096',M['remoteSocket'],str(DEV)],
                                stdin=subprocess.DEVNULL,stdout=log,stderr=log,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'},start_new_session=True)
        until=time.monotonic()+8
        while (size()!=M['bytes'] or not pidof()) and time.monotonic()<until:time.sleep(.1)
        assert size()==M['bytes'] and pidof(),'attach-timeout'
        s['nbdPid']=pidof();assert unitof(s['nbdPid'])==cg,'attach-owner';save(s)
        uuid=cmd('filesystemUuid',['/usr/sbin/blkid','-p','-s','UUID','-o','value',str(DEV)]).strip()
        assert uuid==M['uuid'],'filesystem-uuid'
        assert read(SYS/'ro')=='1','device-not-readonly'
        fd=os.open(DEV,os.O_RDONLY)
        try:superblock=os.pread(fd,1024,1024)
        finally:os.close(fd)
        assert len(superblock)==1024 and struct.unpack_from('<H',superblock,56)[0]==0xef53
        fsstate=struct.unpack_from('<H',superblock,58)[0];incompat=struct.unpack_from('<I',superblock,96)[0]
        out['filesystemSuperblock']={'state':fsstate,'incompat':incompat,'needsRecovery':bool(incompat&4)}
        assert fsstate&1 and not incompat&4,'filesystem-needs-recovery-before-read'
        cmd('mount',['/usr/bin/mount','-t','ext4','-o','ro,noload,nosuid,nodev,noexec',str(DEV),str(MOUNT)])
        rows=mounts();assert len(rows)==1 and rows[0][2]==s['deviceNumber'] and 'ro' in rows[0][5].split(',')
        out['mounted']={'filesystemOptions':rows[0][rows[0].index('-')+3],'uuid':uuid,'deviceNumber':s['deviceNumber'],'path':str(MOUNT),'options':rows[0][5],'expectedProductionMount':M['expectedProductionMount']}
        def confined(rel):
            q=MOUNT
            for part in P(rel).parts:
                assert part not in ('..','.','')
                q=q/part;st=q.lstat();assert not stat.S_ISLNK(st.st_mode),'symlink-not-admitted'
            return q
        def meta(rel,required=False):
            headroom()
            try:q=confined(rel);st=q.stat()
            except FileNotFoundError:
                assert not required,'required-path-missing:'+rel
                return {'present':False}
            return {'present':True,'bytes':st.st_size,'mode':st.st_mode,'inode':st.st_ino,'mtimeNs':st.st_mtime_ns,'directory':stat.S_ISDIR(st.st_mode),'regular':stat.S_ISREG(st.st_mode)}
        out['paths']={rel:meta(rel,rel in ('snapshot-complete','data','data/reth.toml','data/db','data/static_files')) for rel in ('snapshot-complete','data','data/reth.toml','data/db','data/db/mdbx.dat','data/static_files','cl','cl/beacon','cl/beacon/chain_db','anchor/state.ssz','anchor/block.ssz')}
        q=confined('data/reth.toml');assert q.is_file() and q.stat().st_size<=1<<20
        raw=q.read_bytes();profile=tomllib.loads(raw.decode())
        assert profile.get('static_files',{}).get('blocks_per_file'),'missing-static-segment-config'
        assert isinstance(profile.get('prune'),dict),'missing-prune-profile'
        # Standard Reth TOML is public configuration. Refuse unexpected key-bearing fields.
        assert not any(word in raw.lower() for word in (b'private_key',b'jwtsecret',b'jwt_secret',b'password')),'unexpected-sensitive-config-field'
        out['effectiveRethToml']={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'text':raw.decode(),'parsed':profile}
        out['staticFiles']=[]
        for index,q in enumerate(confined('data/static_files').iterdir()):
            headroom();assert index<1024,'static-inventory-limit'
            st=q.lstat();assert not stat.S_ISLNK(st.st_mode),'static-symlink'
            out['staticFiles'].append({'name':q.name,'bytes':st.st_size,'mode':st.st_mode,'mtimeNs':st.st_mtime_ns})
        out['staticFiles'].sort(key=lambda x:x['name'])
        marker=confined('snapshot-complete');assert marker.is_file() and marker.stat().st_size<=65536
        raw=marker.read_bytes();out['snapshotMarker']={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        out['clientStarted']=False;out['configModified']=False;out['databaseContentRead']=False
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
        for name in ('bootstrap','read'):
            unit='enclave-rpc-l1-metadata-'+name+'-r1.service'
            cmd('stop:'+name,['/usr/bin/systemctl','stop',unit],8,allowed=(0,5))
        if s.get('moduleLoadedByFixture') and P('/sys/module/nbd').exists():
            for q in P('/sys/block').glob('nbd*'):
                assert int(read(q/'size'))==0 and (not(q/'pid').exists() or read(q/'pid') in ('','0')) and not list((q/'holders').iterdir()),'other-nbd-active'
            cmd('unloadModule',['/usr/sbin/modprobe','-r','nbd'],8)
        s['cleanupCompleted']=True;save(s);out['state']=s
    elif ACTION=='verify':
        s=state();assert s.get('cleanupCompleted') and not device_mounts(s['deviceNumber'])
        assert not SYS.exists() or idle()
        if s.get('moduleLoadedByFixture'):assert not P('/sys/module/nbd').exists()
        units=[]
        for name in ('policy','bootstrap','read','cleanup'):
            unit='enclave-rpc-l1-metadata-'+name+'-r1.service'
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
    if ACTION in ('read',) and STATE.exists():
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
