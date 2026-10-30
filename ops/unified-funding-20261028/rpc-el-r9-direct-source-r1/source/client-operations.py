# PREPARED ONLY. Appended to the qualified transport/ownership helpers.
import pwd,grp,secrets,shutil,urllib.request,urllib.error,contextlib
PAYLOAD=EXEC/'payload';SLICE='enclavel1trialr9.slice';GUARD_SLICE='enclavel1guardianr9.slice';ATTACH_SLICE='enclavel1attachr9.slice';NBD_UNIT='enclave-rpc-l1-nbd-r9.service'
UNITS={'el':'enclave-rpc-l1-el-trial-r9.service','cl':'enclave-rpc-l1-cl-trial-r9.service'}
HELPER='enclave-rpc-l1-helper-r9.service';WATCH='enclave-rpc-l1-watch-r9.service'
STOP=ROOT/'STOP';DONE=ROOT/'CLEANUP.json';LOCK=ROOT/'operation.lock'
def atomic_json(path,value):
    tmp=path.with_suffix('.next')
    with tmp.open('x') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)
def unit_info(unit):
    text=cmd('unit:'+unit,['/usr/bin/systemctl','show',unit,'--property=LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,Result,ExecMainCode,ExecMainStatus,ExecMainPID,ExecMainStartTimestampMonotonic,ControlPID,User,Group,Transient,Description,ExecStart,FragmentPath,DropInPaths'],3,allowed=(0,1,4))
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
          '--property=PrivateTmp=yes','--property=ReadWritePaths='+data+' '+tmp+' '+str(ROOT/'exit-receipts'),
          '--property=UMask=0027','--property=MemorySwapMax=0','--property=TasksMax=512',
          '--property=LimitNOFILE=65536','--property=OOMScoreAdjust=100',
          '--property=KillMode=control-group','--property=KillSignal=SIGINT','--property=TimeoutStopSec=45',
          '--property=Restart=no','--property=BindsTo='+WATCH,
          '--property=ExecStopPost=!/usr/bin/timeout --signal=TERM --kill-after=1 3 /usr/bin/python3 -I -B '+str(ROOT/'exit-recorder.py')+' '+side,
          '/usr/bin/python3','-I','-B',str(PAYLOAD/'chain_service.py'),side]
    s=state();s.setdefault('clientLaunchIntents',{})[side]={'description':description(side),'unit':UNITS[side],'executable':str(PAYLOAD/'chain_service.py'),'user':identity['name']};save(s)
    cmd('start:'+side,argv,8)
    info=unit_info(UNITS[side]);assert info.get('User')==identity['name'] and info.get('Group')==identity['name']
    cg=info.get('ControlGroup')
    assert cg=='/'+SLICE+'/'+UNITS[side],'unexpected-client-cgroup'
    st=(P('/sys/fs/cgroup'+cg)).stat()
    info['cgroupIdentity']=[st.st_dev,st.st_ino]
    bind_client_diagnostic(info)
    ident=info['diagnosticIdentity'];assert ident.get('bound') is True,'exit-launch-identity-unbound'
    assert info['ExecMainPID']==str(ident['pid']) and info['ExecMainStartTimestampMonotonic'].isdecimal(),'exit-launch-manager-binding'
    binding={'boot':M['bootId'],'nonce':M['nonce'],'unit':UNITS[side],
             'invocation':info['InvocationID'],'pid':ident['pid'],'startTicks':ident['startTicks'],
             'mainStartMonotonic':info['ExecMainStartTimestampMonotonic'],
             'cgroup':cg,'cgroupIdentity':info['cgroupIdentity'],
             'description':description(side),'user':identity['name']}
    data=json.dumps(binding).encode();assert len(data)<=4096
    fd=os.open(ROOT/'exit-receipts'/('el-binding.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    info['exitBinding']=binding
    return info

def retained_exit_receipt(info):
    binding=info['exitBinding'];path=ROOT/'exit-receipts/el-exit.json'
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        st=os.fstat(fd)
        assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1,'exit-receipt-file'
        raw=os.read(fd,4097);assert len(raw)<=4096,'exit-receipt-bound'
    finally:os.close(fd)
    receipt=json.loads(raw)
    for key in ('boot','nonce','unit','invocation','pid','startTicks','mainStartMonotonic','cgroup','cgroupIdentity'):
        assert receipt[key]==binding[key],'exit-receipt-identity:'+key
    assert receipt['managerStopPostVerified'] is True,'exit-receipt-manager'
    pid=P('/proc')/str(binding['pid'])
    try:
        raw=(pid/'stat').read_text();start=int(raw[raw.rfind(')')+2:].split()[19])
        assert start!=binding['startTicks'],'exit-main-still-alive'
    except FileNotFoundError:pass
    cg=P('/sys/fs/cgroup'+binding['cgroup'])
    assert not cg.exists() or all(not q.read_text().strip() for q in cg.rglob('cgroup.procs')),'exit-descendants-live'
    return receipt

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
            for side,unit in UNITS.items():
                receipt['clients'][side]=dead(unit)
                if side in s.get('clients',{}):
                    try:receipt.setdefault('exitReceipts',{})[side]=retained_exit_receipt(s['clients'][side])
                    except Exception as e:
                        # Missing graceful evidence must not prevent independent safe teardown.
                        receipt.setdefault('exitEvidenceErrors',{})[side]=type(e).__name__+':'+str(e)[:120]
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
