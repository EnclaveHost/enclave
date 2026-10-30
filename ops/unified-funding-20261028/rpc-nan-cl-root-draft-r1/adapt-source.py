from pathlib import Path
import json,hashlib,uuid
p=Path(__file__).resolve().parent;s=p/'source'
seed=Path('/home/steven/Documents/Codex/2026-10-23/it/work/rpc-nan-cl-author-r1-20261030/seed')
def base(name):
 t=(seed/name).read_text()
 for a,b in [('/srv/enclave-l1-pair-r4','/srv/enclave-nan-cl-n1/volume'),('enclavel1trialr4','enclavenantrialn1'),('enclavel1attachr4','enclavenanattachn1'),('enclavel1guardianr4','enclavenanguardn1'),('enclave-rpc-l1','enclave-rpc-nan'),('rpc-l1-client-r4','rpc-nan-client-n1'),('rpc-control-l1-client-r4','rpc-nan-cl-n1'),('-r4','-n1')]:t=t.replace(a,b)
 return t
# Transport retains qualified NBD ownership/cleanup, parameters changed explicitly.
t=base('transport-helpers.py');t=t.replace("['/var/lib/enclave-rpc-nan-client-n1/nbd-client','-d'", "[str(EXEC/'nbd-client'),'-d'")
# Remove unused control seven-service reservation implementation entirely.
a=t.index('def headroom():');b=t.index('def mount_policy(',a)
t=t[:a]+"last_guard=0\n"+t[b:];(s/'transport-helpers.py').write_text(t)
# Client operations: new dedicated identity, one client, same independent teardown.
t=base('client-operations.py').replace("UNITS={'el':'enclave-rpc-nan-el-trial-n1.service','cl':'enclave-rpc-nan-cl-trial-n1.service'}","UNITS={'cl':'enclave-rpc-nan-cl-trial-n1.service'}")
a=t.index('def retained_identities():');b=t.index('def create_slice():',a)
t=t[:a]+'''def create_identities():
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
        cmd('createGroup:'+name,['/usr/sbin/groupadd','--gid',str(gid),name],5)
        g=grp.getgrnam(name);assert g.gr_gid==gid and not g.gr_mem
        st=state();st.setdefault('createdGroups',[]).append({'name':name,'gid':gid});save(st)
    cmd('createClientUser',['/usr/sbin/useradd','--uid','50011','--gid','50011','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',ident['name']],5)
    u=pwd.getpwnam(ident['name']);assert (u.pw_uid,u.pw_gid,u.pw_dir,u.pw_shell)==(50011,50011,'/nonexistent','/usr/sbin/nologin')
    st=state();st['createdUsers']=[{'name':ident['name'],'uid':50011,'gid':50011}];save(st)

'''+t[b:]
t=t.replace('(SLICE,2304','(SLICE,4096').replace('outside the2304MiB','outside the4096MiB')
t=t.replace("'--property=PrivateTmp=yes','--property=ReadWritePaths='+data+' '+tmp,", "'--property=PrivateTmp=yes','--property=InaccessiblePaths='+str(MOUNT/'data')+' '+str(MOUNT/'tmp'),'--property=ReadWritePaths='+data+' '+tmp,")
a=t.index("    info=unit_info(UNITS[side]);assert");b=t.index('\ndef sample_client_memory',a)
t=t[:a]+'''    info=owned_info(UNITS[side],side,identity['name'],str(PAYLOAD/'chain_service.py'))
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
'''+t[b:]
t=t.replace("        ('el','http://127.0.0.1:18645',{'jsonrpc':'2.0','id':1,'method':'eth_blockNumber','params':[]}),\n",'')
t=t.replace("info['cgroupIdentity']","info.get('cgroupIdentity')") if False else t
(s/'client-operations.py').write_text(t)
# Main path only manipulates private CL directories; no Reth config mutation.
t=base('client-main.py')
t=t.replace("seal_payload();MOUNT.mkdir(mode=0o755);MOUNT.chmod(0o755)","seal_payload();MOUNT.parent.mkdir(mode=0o700);MOUNT.mkdir(mode=0o700)")
t=t.replace("time.time()+210","time.time()+300").replace("RuntimeMaxSec=280","RuntimeMaxSec=380").replace("RuntimeMaxSec=360","RuntimeMaxSec=480")
t=t.replace("st.st_uid==1000","st.st_uid==M['sshUid']").replace("ps.st_uid==1000","ps.st_uid==M['sshUid']")
a=t.index("        out['owners']=check_owners()");b=t.index("        jwt=PAYLOAD/'jwt.hex'",a)
t=t[:a]+'''        assert (MOUNT/'snapshot-complete').is_file() and (MOUNT/'cl/beacon/chain_db').is_dir(),'actual-CL-database-missing'
        for unit in UNITS.values():assert unit_info(unit).get('LoadState')=='not-found','unit-preexists:'+unit
        def ownership_tick():
            assert not STOP.exists(),'ownership-stop-requested';headroom()
        ledger=remap_tree(str(MOUNT),(995,986),(50011,50011),tick=ownership_tick)
        atomic_json(ROOT/'ownership-preflight.json',ledger)
        create_identities()
        cmd('unmountPreflight',['/usr/bin/umount',str(MOUNT)],10)
        cmd('privateCowWritableMount',['/usr/bin/mount','-t','ext4','-o','rw,nosuid,nodev,noexec',str(DEV),str(MOUNT)],10)
        assert len(mounts())==1 and mounts()[0][2]==s['deviceNumber'] and 'rw' in mounts()[0][5].split(',')
        changed=remap_tree(str(MOUNT),(995,986),(50011,50011),ledger=ledger,tick=ownership_tick)
        verified=remap_tree(str(MOUNT),(50011,50011),(50011,50011),tick=ownership_tick)
        assert changed==verified,'ownership-verification-mismatch'
        atomic_json(ROOT/'ownership-complete.json',{'entries':len(changed),'ledgerSha256':hashlib.sha256(json.dumps(changed,sort_keys=True).encode()).hexdigest(),'originalModified':False})
        os.chown(MOUNT.parent,0,50011);MOUNT.parent.chmod(0o710)
'''+t[b:]
t=t.replace("for side in ('el','cl'):","for side in ('cl',):")
t=t.replace("    out['elRpcObserved']=any(isinstance(x['rpc'].get('el',{}).get('result'),str) for x in samples)\n",'')
t=t.replace("assert out['elRpcObserved'] and out['clRpcObserved'],'client-RPC-startup-not-observed'","assert out['clRpcObserved'],'CL-RPC-startup-not-observed'")
t=t.replace("out['startupObserved']=True;out['productionReady']=False","out['startupObserved']=True;out['productionReady']=False;out['engineOfflineExpected']=True")
t=t.replace("assert not device_mounts(s['deviceNumber']) and (not SYS.exists() or idle())","assert (not s.get('deviceNumber') or not device_mounts(s['deviceNumber'])) and (not SYS.exists() or idle())")
# Preserve client failure journal in error path, even when initial cgroup vanished.
needle="    if ACTION=='main':\n        stop_request('main-error')"
t=t.replace(needle,"""    if ACTION=='main':
        if STATE.exists():
            for side,info in state().get('clients',{}).items():
                inv=info.get('InvocationID')
                if inv:
                    try:cmd('failureLog:'+side,['/usr/bin/journalctl','--no-pager','-o','cat','-n','40','_SYSTEMD_INVOCATION_ID='+inv],4)
                    except Exception:pass
        stop_request('main-error')""")
(s/'client-main.py').write_text(t)
# Existing wrapper is retained but CL-only entry eliminates accidental EL/Base execution or new checkpoint.
t=base('trial-chain-service.py');a=t.index("        if not pathlib.Path(datadir, 'beacon', 'chain_db').is_dir():");b=t.index("    elif side == 'base':",a)
t=t[:a]+"        assert pathlib.Path(datadir, 'beacon', 'chain_db').is_dir(), 'existing CL database required'\n"+t[b:]
t=t.replace("elif len(argv) == 1 and argv[0] in ('el', 'cl', 'base'):","elif argv == ['cl']:")
(s/'trial-chain-service.py').write_text(t)
# Local orchestration: fixed root SSH, local NBD upload; no original identity reuse.
t=base('run-body.py');a=t.index('def sshargs():');b=t.index('\ndef parent_identity',a)
t=t[:a]+'''def sshargs():
    return ['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5',
      '-oControlMaster=no','-oControlPath=none','-oServerAliveInterval=5','-oServerAliveCountMax=2']
'''+t[b:]
a=t.index('growth=0\n',t.index('def bootstrap():'));b=t.index("program=P(M['uploadDirectory'])",a)
t=t[:a]+"assert available-((4352+M['admission']['observedPendingMiB'])<<20)>=(2048<<20),'pre-bootstrap-headroom'\nassert M['admission']['authorized'] and M['admission']['at']<=time.time()<=M['admission']['expiresAt'],'stale-admission'\n"+t[b:]
t=t.replace(",'enclave-rpc-nan-el-trial-n1.service'",'')
a=t.index("    provenance=M['retainedAccountProvenance']");b=t.index("    admit=json.loads",a);t=t[:a]+t[b:]
t=t.replace("'actual-l1-bounded-client-n1'","'actual-nan-cl-bounded-client-n1'")
t=t.replace("runtime=220;stop_seconds=95;seconds=335","runtime=330;stop_seconds=95;seconds=445")
t=t.replace("sources['program.py']=str(P/'remote-program.py')","sources['program.py']=str(P/'remote-program.py');sources['nbd-client']=M['localNbdClient']")
# Admission file is read locally and uploaded only inside the immutable source manifest after matching root approval.
t=t.replace("    bootstrap();start_export();remote_attempted=True", "    bootstrap();start_export();remote_attempted=True")
(s/'run-body.py').write_text(t)
# Manifest parameterization and own file references assembled below after source review.
m=json.loads((seed/'MANIFEST.json').read_text());m['nonce']=str(uuid.uuid4());m['unitPrefix']='enclave-rpc-nan-';m['target']='nan';m['sshUid']=0
m['bootId']='4b84b9bd-a89d-4b37-94cb-26334dbf4666';m['remoteSocket']='/root/rpc-nan-client-n1/export.sock';m['uploadDirectory']='/root/rpc-nan-upload-n1'
m['overlayDirectory']='/vm/enclave-volumes/rpc-nan-cl-n1';m['overlayPath']=m['overlayDirectory']+'/overlay.qcow2';m['expectedProductionMount']='/srv/enclave-nan-cl-n1/volume'
m['exportName']='enclave-nan-cl-'+m['nonce'];m['ownedSlices']=['enclavenantrialn1.slice','enclavenanattachn1.slice','enclavenanguardn1.slice']
m['client']['path']=m['uploadDirectory']+'/nbd-client';m['localNbdClient']=str(p.parent/'rpc-nbd-local-public-copy-r1/nbd-client')
m['identities']={'cl':{'uid':50011,'gid':50011,'name':'enclavenancl','paths':['cl','cl/beacon','cl/beacon/chain_db','tmp-cl']}};m['jwtGroup']={'name':'enclavenanjwt','gid':50012}
for k in ('serviceCapsMiB','retainedAccountProvenance','stageOverrides'):m.pop(k,None)
for k in ('reth','original-reth.toml','proposed-reth.toml'):m['payloadFiles'].pop(k)
m['admission']={'authorized':False,'scope':'nan-cl-only-4096','nonce':m['nonce'],'observedPendingMiB':None,'osReserveMiB':2048,'creatorClassification':'two-launches-before-wait-no-repeated-allocator','at':0,'expiresAt':0,'ordinaryOsExecutables':[],'existingOtherProcesses':[],'scheduleFiles':[],'creatorCmdlineSha256':''}
(s/'MANIFEST.json').write_text(json.dumps(m,indent=2)+'\n')
d=json.loads((seed/'disks.json').read_text());d['disks'][0]['mount']=m['expectedProductionMount'];(s/'disks.json').write_text(json.dumps(d,indent=2)+'\n')
d=json.loads((seed/'payload-manifest.json').read_text());d['mounts']['l1']=m['expectedProductionMount'];(s/'payload-manifest.json').write_text(json.dumps(d,indent=2)+'\n')
print('Separate root source adaptation written, NOT executed/admitted')
