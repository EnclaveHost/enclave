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
        cmd('readOnlyPreflightMount',['/usr/bin/mount','-t','ext4','-o','ro,noload,nosuid,nodev,noexec,nosymfollow',str(DEV),str(MOUNT)],10)
        assert (MOUNT/'snapshot-complete').is_file() and (MOUNT/'cl/beacon/chain_db').is_dir(),'actual-CL-database-missing'
        for unit in UNITS.values():assert unit_info(unit).get('LoadState')=='not-found','unit-preexists:'+unit
        # Own public chain snapshot only. Preserve inode ownership/ACLs; do not rewrite the database.
        paths=('cl','cl/beacon','cl/beacon/chain_db','tmp-cl')
        before=[]
        for rel in paths:
            q=MOUNT/rel;st=q.lstat()
            assert stat.S_ISDIR(st.st_mode) and (st.st_uid,st.st_gid)==(995,986),'CL-source-directory-identity'
            before.append({'path':rel,'inode':st.st_ino,'mode':stat.S_IMODE(st.st_mode)})
        create_identities()
        cmd('unmountPreflight',['/usr/bin/umount',str(MOUNT)],10)
        assert M['idmapOptions']=='u:995:50011:1 g:986:50011:1'
        cmd('privateCowIdmappedMount',['/usr/bin/mount','-t','ext4','-o','rw,nosuid,nodev,noexec,nosymfollow,X-mount.idmap='+M['idmapOptions'],str(DEV),str(MOUNT)],10)
        rows=mounts();assert len(rows)==1 and rows[0][2]==s['deviceNumber']
        assert {'rw','nosuid','nodev','noexec','nosymfollow'}.issubset(set(rows[0][5].split(','))),'mapped-mount-flags'
        for row in before:
            st=(MOUNT/row['path']).lstat()
            assert stat.S_ISDIR(st.st_mode) and (st.st_uid,st.st_gid)==(50011,50011),'CL-mapped-directory-identity'
            assert st.st_ino==row['inode'] and stat.S_IMODE(st.st_mode)==row['mode'],'CL-directory-metadata-changed'
        atomic_json(ROOT/'ownership-view.json',{'mode':'idmapped-whole-ext4','mapping':M['idmapOptions'],'directories':before,'inodesRewritten':False,'recursiveAuditPerformed':False,'sourcePolicy':'own-public-L1-snapshot-only','originalModified':False})
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
    cg=read('/proc/self/cgroup');assert (cg.startswith('0::/enclavenanattachn4.slice/enclave-rpc-nan-') or cg.startswith('0::/enclavenanguardn4.slice/enclave-rpc-nan-')) and cg.endswith('.service')
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
