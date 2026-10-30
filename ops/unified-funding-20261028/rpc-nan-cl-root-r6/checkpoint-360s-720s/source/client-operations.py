# PREPARED ONLY. Appended to the qualified transport/ownership helpers.
import pwd,grp,secrets,shutil,urllib.request,urllib.error,contextlib
PAYLOAD=EXEC/'payload';SLICE='enclavenantrialn6.slice';GUARD_SLICE='enclavenanguardn6.slice';ATTACH_SLICE='enclavenanattachn6.slice';NBD_UNIT='enclave-rpc-nan-nbd-n6.service'
UNITS={'cl':'enclave-rpc-nan-cl-trial-n6.service'}
HELPER='enclave-rpc-nan-helper-n6.service';WATCH='enclave-rpc-nan-watch-n6.service'
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
    selected=[x for x in users if x.pw_uid==50011 or x.pw_name==ident['name'] or x.pw_gid in (50011,50012)]
    assert len(selected)==1,'retained-user-set'
    u=selected[0]
    assert (u.pw_name,u.pw_uid,u.pw_gid,u.pw_dir,u.pw_shell)==('enclavenancl',50011,50011,'/nonexistent','/usr/sbin/nologin'),'retained-user-identity'
    selected_groups=[x for x in groups if x.gr_gid in (50011,50012) or x.gr_name in (ident['name'],jwt['name'])]
    assert sorted((x.gr_name,x.gr_gid,x.gr_mem) for x in selected_groups)==[('enclavenancl',50011,[]),('enclavenanjwt',50012,[])],'retained-group-identity'
    assert not any(ident['name'] in x.gr_mem for x in groups),'retained-supplementary-membership'
    count=0
    for q in P('/proc').iterdir():
        if not q.name.isdigit():continue
        count+=1;assert count<=512
        try:fields=dict(x.split(':',1) for x in (q/'status').read_text().splitlines() if ':' in x)
        except FileNotFoundError:continue
        assert 50011 not in map(int,fields['Uid'].split()),'new-process-UID-collision'
        assert not {50011,50012}.intersection(map(int,(fields['Gid']+' '+fields['Groups']).split())),'new-process-GID-collision'
    st=state();st['reusedGroups']=[{'name':ident['name'],'gid':50011},{'name':jwt['name'],'gid':50012}]
    st['reusedUsers']=[{'name':ident['name'],'uid':50011,'gid':50011}];save(st)

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

# Diagnostic metadata only: never read cmdline, environ, fd contents, maps or JWT.
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
            ex=os.stat('exe',dir_fd=fd);lh=(PAYLOAD/'bin/lighthouse').stat();py=P('/usr/bin/python3').stat()
            executable='lighthouse' if (ex.st_dev,ex.st_ino)==(lh.st_dev,lh.st_ino) else 'python-wrapper' if (ex.st_dev,ex.st_ino)==(py.st_dev,py.st_ino) else None
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

DIAGNOSTIC_LOG_MARKERS=('Lighthouse started','Configured network','Data directory initialised','Deposit contract',
    'Opening HotColdDB','Opening LevelDB','Loaded anchor info','Hot-Cold DB initialized',
    'Block production enabled','HTTP API started','Unable to open database')
def diagnostic_journal(invocation):
    # Never attach raw debug text to evidence. Fixed labels and journal timestamps only.
    assert len(invocation)==32 and all(c in '0123456789abcdef' for c in invocation)
    r=capture(['/usr/bin/journalctl','--no-pager','-o','json','-n','256','--output-fields=MESSAGE,__MONOTONIC_TIMESTAMP,_SYSTEMD_INVOCATION_ID','_SYSTEMD_INVOCATION_ID='+invocation],4,limit=131072)
    labels=[];seen=0;unmatched=0;invalid=0
    for line in r['stdout'].splitlines()[:256]:
        seen+=1
        try:
            row=json.loads(line);assert row.get('_SYSTEMD_INVOCATION_ID')==invocation
            stamp=row.get('__MONOTONIC_TIMESTAMP');assert isinstance(stamp,str) and stamp.isdigit()
            message=row.get('MESSAGE');assert isinstance(message,str)
            found=[x for x in DIAGNOSTIC_LOG_MARKERS if x in message]
            if found:labels.append({'monotonicUsec':int(stamp),'markers':found})
            else:unmatched+=1
        except Exception:invalid+=1
    return {'invocationID':invocation,'markers':labels,'entriesObserved':seen,'unmatchedEntries':unmatched,
        'invalidEntries':invalid,'tailLimit':256,'tailMayBeTruncated':seen>=256,
        'captureTruncated':r['truncated'],'captureReason':r['reason'],'rc':r['rc'],
        'rawMessagesRetained':False}

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
        out['initialClientJournal']=diagnostic_journal(invocation)
    assert info.get('User')==identity['name'] and info.get('Group')==identity['name'],'client-start-identity'
    cg=info.get('ControlGroup');assert cg=='/'+SLICE+'/'+UNITS[side],'client-not-started:'+str(info.get('Result'))
    q=P('/sys/fs/cgroup'+cg)
    if q.exists():
        st=q.stat();info['cgroupIdentity']=[st.st_dev,st.st_ino]
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
def wait_cleanup(seconds=140):
    until=time.monotonic()+seconds
    while not DONE.exists() and time.monotonic()<until:time.sleep(.2)
    assert DONE.is_file(),'watchdog-cleanup-missing'
    value=json.loads(DONE.read_text());assert value['ok'] and not value['errors'],'watchdog-cleanup-failed'
    return value
