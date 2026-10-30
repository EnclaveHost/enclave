# PREPARED ONLY. Appended to the qualified transport/ownership helpers.
import pwd,grp,secrets,shutil,urllib.request,urllib.error,contextlib
PAYLOAD=EXEC/'payload';SLICE='enclavel1trialr1.slice';GUARD_SLICE='enclavel1guardianr1.slice';ATTACH_SLICE='enclavel1attachr1.slice';NBD_UNIT='enclave-rpc-l1-nbd-r1.service'
UNITS={'el':'enclave-rpc-l1-el-trial-r1.service','cl':'enclave-rpc-l1-cl-trial-r1.service'}
HELPER='enclave-rpc-l1-helper-r1.service';WATCH='enclave-rpc-l1-watch-r1.service'
STOP=ROOT/'STOP';DONE=ROOT/'CLEANUP.json';LOCK=ROOT/'operation.lock'
def atomic_json(path,value):
    tmp=path.with_suffix('.next')
    with tmp.open('x') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)
def unit_info(unit):
    text=cmd('unit:'+unit,['/usr/bin/systemctl','show',unit,'--property=LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,Result,ExecMainCode,ExecMainStatus,User,Group,Transient,Description,ExecStart'],3,allowed=(0,1,4))
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
def check_owners():
    records={}
    for side,identity in M['identities'].items():
        for rel in identity['paths']:
            q=MOUNT/rel;st=q.lstat()
            assert not stat.S_ISLNK(st.st_mode) and st.st_uid==identity['uid'] and st.st_gid==identity['gid'],'unexpected-datadir-owner:'+rel
            records[rel]={'uid':st.st_uid,'gid':st.st_gid,'mode':st.st_mode,'inode':st.st_ino}
        for lookup,value in ((pwd.getpwuid,identity['uid']),(pwd.getpwnam,identity['name']),(grp.getgrgid,identity['gid']),(grp.getgrnam,identity['name'])):
            try:lookup(value)
            except KeyError:pass
            else:raise RuntimeError('identity-already-occupied:'+str(value))
    for lookup,value in ((grp.getgrgid,M['jwtGroup']['gid']),(grp.getgrnam,M['jwtGroup']['name'])):
        try:lookup(value)
        except KeyError:pass
        else:raise RuntimeError('JWT-group-occupied')
    count=0;uids={x['uid'] for x in M['identities'].values()}
    for q in P('/proc').iterdir():
        if not q.name.isdigit():continue
        count+=1;assert count<=512,'process-census-limit'
        try:lines=(q/'status').read_text().splitlines()
        except FileNotFoundError:continue
        current=next(l for l in lines if l.startswith('Uid:')).split()[1:]
        assert not(uids & {int(x) for x in current}),'process-occupies-client-UID'
    return records
def create_identities():
    for identity in M['identities'].values():
        cmd('group:'+identity['name'],['/usr/sbin/groupadd','--system','--gid',str(identity['gid']),identity['name']],5)
        s=state();s.setdefault('createdGroups',[]).append({'name':identity['name'],'gid':identity['gid']});save(s)
        cmd('user:'+identity['name'],['/usr/sbin/useradd','--system','--uid',str(identity['uid']),'--gid',str(identity['gid']),'--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',identity['name']],5)
        s=state();s.setdefault('createdUsers',[]).append({'name':identity['name'],'uid':identity['uid'],'gid':identity['gid']});save(s)
        actual=pwd.getpwnam(identity['name']);assert actual.pw_uid==identity['uid'] and actual.pw_gid==identity['gid']
    cmd('jwtGroup',['/usr/sbin/groupadd','--system','--gid',str(M['jwtGroup']['gid']),M['jwtGroup']['name']],5)
    s=state();s.setdefault('createdGroups',[]).append(M['jwtGroup']);save(s)
def create_slice():
    for unit,mib,cpu in ((SLICE,2304,100),(GUARD_SLICE,128,50)):
        path=P('/run/systemd/system')/unit
        assert unit_info(unit).get('LoadState')=='not-found','slice-preexists'
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
def start_client(side):
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
    return info
def sample_rpc():
    value={}
    for name,url,request in (
        ('el','http://127.0.0.1:18645',{'jsonrpc':'2.0','id':1,'method':'eth_blockNumber','params':[]}),
        ('cl','http://127.0.0.1:15052/eth/v1/node/syncing',None)):
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
            s=state();receipt['retainedAccounts']={'users':s.get('createdUsers',[]),'groups':s.get('createdGroups',[])}
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
