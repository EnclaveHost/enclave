# PREPARED ONLY. Appended to the qualified transport/ownership helpers.
import pwd,grp,secrets,shutil,urllib.request,urllib.error,contextlib
PAYLOAD=EXEC/'payload';SLICE='enclavenantrialn2.slice';GUARD_SLICE='enclavenanguardn2.slice';ATTACH_SLICE='enclavenanattachn2.slice';NBD_UNIT='enclave-rpc-nan-nbd-n2.service'
UNITS={'cl':'enclave-rpc-nan-cl-trial-n2.service'}
HELPER='enclave-rpc-nan-helper-n2.service';WATCH='enclave-rpc-nan-watch-n2.service'
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
