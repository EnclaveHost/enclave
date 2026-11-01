"""Actual signer-command -> dispatcher -> exporter composition on disposable data.

The opt-in Go TEST BINARY changes only the chain HTTP transport. All production
command code, journal writes, actual systemd envelopes and TLS exports execute.
No real chain, storage authority provisioning, remote attestation or RPC clients.
Reserve1664MiB: controller512+wrapper128+dispatcher256+signer128+export384+provisioner128+128.
"""
from pathlib import Path
import hashlib,importlib.util,json,os,select,socket,ssl,subprocess,sys,time,uuid
SOURCE=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(SOURCE/'rpc/server'))
import volume_export as v
import guarded_export as g
import app_control
spec=importlib.util.spec_from_file_location('startup_clock',SOURCE/'rpc/startup_clock.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def command(args,seconds=5):
    r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=seconds)
    if len(r.stdout)+len(r.stderr)>65536:raise ValueError('Output bound')
    if r.returncode:raise ValueError('Command failure: '+r.stderr.decode(errors='replace')[:2048])
    return r.stdout.decode()

def write(path,value):
    return c.write_new(path,c.encode(value))

def inspect(unit):
    keys='Id,LoadState,MainPID,ActiveState,SubState,InvocationID,ControlGroup,Result,ExecMainStatus,MemoryPeak'
    return dict(x.split('=',1) for x in command(['/usr/bin/systemctl','--user','show',unit,'--property='+keys]).splitlines() if '=' in x)

def main(private,public,observer_config,binary):
    os.umask(0o077)
    if os.sched_getaffinity(0)!={1}:raise ValueError('CPU1 required')
    private.mkdir(mode=0o700);public.mkdir(mode=0o700);v.directory(private);v.tool_pins()
    paths=list((SOURCE/'rpc').rglob('*.py'))+[SOURCE/'rpc/server/observe_resources.mjs',Path('/usr/bin/node'),observer_config,Path(__file__).resolve()]
    pins={str(p):g.digest(p) for p in paths};write(public/'PINS.json',pins)
    argv=['/usr/bin/node',str(SOURCE/'rpc/server/observe_resources.mjs'),str(observer_config)]
    admission=json.loads(command(argv,3))
    if not admission['authenticated'] or admission['unreadUnits'] or admission['availableMiB']-admission['pendingMiB']-1664<max(27648,admission['floorMiB']):raise ValueError('Full1664MiB fixture admission failed')
    write(public/'ADMISSION.json',admission)
    attempt=uuid.uuid4().hex;instance='rpc-owned-fixture-'+attempt
    exportunit='enclave-rpc-export-'+attempt+'.service';dispatchunit='enclave-rpc-owner-dispatch-'+attempt+'.service';signunit='enclave-rpc-owner-sign-'+attempt+'.service'
    for unit in (exportunit,dispatchunit,signunit):
        if inspect(unit)['LoadState']!='not-found':raise ValueError('Consumed unit')
    cp=private/'clocks';cp.mkdir(mode=0o700)
    begin=c.begin(cp,attempt,instance,uuid.uuid4().hex);started=c.protocol.decode(c.read_pinned(begin))
    sample=write(private/'synthetic-windows-clock.json',{'schema':'owned-rpc-windows-clock/1','attempt':attempt,'vmAttempt':started['vmAttempt'],'windowsBoot':uuid.uuid4().hex,'monotonicMilliseconds':1000000000})
    clock=c.finish(begin,sample);original=c.validate(clock)
    # Explicit test artifact, not the release issuer. The only injected behavior
    # is its HTTP RoundTripper; the command main/run below remain unchanged.
    issuer=private/'TEST-ONLY-owner';issuer.write_bytes(binary.read_bytes());issuer.chmod(0o700)
    (private/'openssl.cnf').write_text('[req]\ndistinguished_name=dn\n[dn]\n')
    os.environ['OPENSSL_CONF']=str(private/'openssl.cnf')
    ca=private/'ca';ca.mkdir(mode=0o700)
    command(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(ca/'ca-key.pem'),'-out',str(ca/'ca-cert.pem'),'-days','1','-subj','/CN=owned-rpc-inert-fixture','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'])
    roles={};hashes={};sockets=[]
    for role in ('l1','base'):
        root=private/role;root.mkdir(mode=0o700)
        tls=root/'tls';tls.mkdir(mode=0o700)
        (tls/'ca-cert.pem').write_bytes((ca/'ca-cert.pem').read_bytes())
        for prefix,cn,usage in [('server','rpc-fixture.local','serverAuth'),('client','rpc-client-'+attempt+'-'+role,'clientAuth')]:
            command(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(tls/(prefix+'-key.pem')),'-out',str(tls/(prefix+'.csr')),'-subj','/CN='+cn])
            (tls/(prefix+'.ext')).write_text('extendedKeyUsage='+usage+'\nsubjectAltName=DNS:'+cn+'\n')
            command(['openssl','x509','-req','-in',str(tls/(prefix+'.csr')),'-CA',str(ca/'ca-cert.pem'),'-CAkey',str(ca/'ca-key.pem'),'-CAcreateserial','-out',str(tls/(prefix+'-cert.pem')),'-days','1','-extfile',str(tls/(prefix+'.ext'))])
        image_path=root/'dummy.qcow2'
        # Protocol requires exact volume geometry; sparse metadata only, no chain data.
        command(['/usr/bin/qemu-img','create','-q','-f','qcow2',str(image_path),'4000000000000'])
        if image_path.stat().st_blocks*512>16<<20:raise ValueError('Dummy allocation bound')
        hashes[str(image_path)]=g.digest(image_path)
        exports=root/'exports';exports.mkdir(mode=0o700)
        sock=socket.socket();sock.bind(('127.0.0.1',0));sockets.append(sock)
        roles[role]={'parent':str(exports),'originals':[[str(image_path),v.metadata(image_path)]],'bytes':4000000000000,
                     'tls':str(tls),'clientTls':str(tls),'tlsName':'rpc-fixture.local','host':'127.0.0.1','port':sock.getsockname()[1]}
    ownerparent=private/'owner';ownerparent.mkdir(mode=0o700)
    ownerroles={role:{'volumeId':('a' if role=='l1' else 'b')*64,'originals':roles[role]['originals']} for role in ('l1','base')}
    provisionpaths=[SOURCE/'rpc/server'/n for n in ('owner_state.py','owner_entry.py','volume_export.py','observe_resources.mjs')]
    provisionpaths += [SOURCE/'rpc/startup_clock.py',SOURCE/'rpc/storage_protocol.py',observer_config]+[Path('/usr/bin/'+n) for n in ('python3','node','openssl','stat')]
    pc={'schema':'enclave-rpc-owner-provision/1','attempt':attempt,'clock':clock,
        'parent':{'path':str(ownerparent),'identity':[ownerparent.stat().st_dev,ownerparent.stat().st_ino]},'roles':ownerroles,
        'resourceConfig':{'path':str(observer_config),'sha256':g.digest(observer_config)},'pins':{str(p):g.digest(p) for p in provisionpaths}}
    write(private/'provision.json',pc)
    provisionunit='enclave-rpc-owner-provision-'+attempt+'.service'
    if inspect(provisionunit)['LoadState']!='not-found':raise ValueError('Provision unit consumed')
    pp=['Type=exec','RuntimeMaxSec=20','TimeoutStopSec=1','MemoryMax=128M','MemorySwapMax=0','CPUQuota=100%',
        'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077']
    pa=['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit='+provisionunit,*['--property='+x for x in pp],
        '/usr/bin/python3','-B',str(SOURCE/'rpc/server/owner_state.py'),str(private/'provision.json')]
    write(public/'PROVISION-INTENT.json',{'unit':provisionunit,'argv':pa,'originalClock':clock,'productionAuthority':False})
    provision=json.loads(command(pa,24));write(public/'PROVISION.json',provision)
    authority=Path(provision['authority']['path']).parent;journal=authority/'journal'
    # The fixture's manifest keys now derive from the ACTUAL one-time owner setup.
    command([str(issuer),'--prepare-composition',str(authority),str(SOURCE/'isolation/m2/bootstrap/testdata/vectors.json'),str(original['originMonotonicNs'])])
    request=json.loads((authority/'request.json').read_bytes())['request']
    requestsha=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    state=private/'state';state.mkdir(mode=0o700)
    outputs=private/'outputs';outputs.mkdir(mode=0o700);out=outputs/attempt
    controltls=Path(roles['l1']['tls']);reserve=socket.socket();reserve.bind(('127.0.0.1',0));sockets.append(reserve)
    clientsha=hashlib.sha256(ssl.PEM_cert_to_DER_cert((controltls/'client-cert.pem').read_text())).hexdigest()
    serversha=hashlib.sha256(ssl.PEM_cert_to_DER_cert((controltls/'server-cert.pem').read_text())).hexdigest()
    contract={'attempt':attempt,'instance':instance,'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
        'createdUtcNs':original['createdUtcNs'],'deadlineUtcNs':original['deadlineUtcNs'],'floorMiB':27648,'reserveMiB':512,
        'resourceArgv':argv,'sourcePins':pins,'stateParent':str(state),'roles':roles,'startupClock':clock,
        'appControl':{'schema':'enclave-rpc-export-control/1','host':'127.0.0.1','port':reserve.getsockname()[1],
        'tls':str(controltls),'requestSha256':requestsha,'clientCertificateSha256':clientsha}}
    cb=write(private/'contract.json',contract)
    meta=json.loads((authority/'fixture-policy.json').read_bytes())
    binding={'host':'127.0.0.1','port':contract['appControl']['port'],'serverName':'rpc-fixture.local',
        'serverCertificateSha256':serversha,'clientCertificateSha256':clientsha,'contractSha256':cb['sha256']}
    policy={'schema':'enclave-rpc-storage-owner/1','runtime':meta['runtime'],'l1Volume':request['l1Volume'],'baseVolume':request['baseVolume'],
        'chainId':8453,'ledger':meta['ledger'],'rpcs':['https://one.rpc.example','https://two.rpc.example','https://three.rpc.example'],
        'confirmations':2,'maxAgeSeconds':90,'export':binding}
    pb=write(private/'policy.json',policy)
    entrypaths=[SOURCE/'rpc/server/owner_state.py',SOURCE/'rpc/server/volume_export.py',SOURCE/'rpc/server/owner_entry.py',SOURCE/'rpc/startup_clock.py',SOURCE/'rpc/storage_protocol.py',Path('/usr/bin/bwrap'),Path('/usr/bin/python3')]
    entry={'schema':'enclave-rpc-owner-entry/1','attempt':attempt,'clock':clock,'contract':cb,'policy':pb,'ownerProvision':provision['authority'],
        'binary':{'path':str(issuer),'sha256':g.digest(issuer)},
        'pins':{str(p):g.digest(p) for p in entrypaths},'receipt':str(out/'signer-started.json')}
    eb=write(private/'entry.json',entry)
    dispatchpaths=list((SOURCE/'rpc').rglob('*.py'))+[Path('/usr/bin/'+n) for n in ('python3','systemd-run','systemctl','bwrap','node')]
    config={'schema':'enclave-rpc-owner-dispatch/1','entry':eb,'request':{'path':str(authority/'request.json'),'sha256':g.digest(authority/'request.json')},
        'outputParent':str(outputs),'pins':{str(p):g.digest(p) for p in dispatchpaths}}
    write(private/'dispatch.json',config)
    props=['Type=exec','RuntimeMaxSec=60','TimeoutStopSec=1','MemoryMax=256M','MemorySwapMax=0','CPUQuota=100%',
        'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077',
        'StandardOutput=file:'+str(private/'dispatch.stdout'),'StandardError=file:'+str(private/'dispatch.stderr')]
    args=['/usr/bin/systemd-run','--user','--quiet','--unit='+dispatchunit,*['--property='+p for p in props],'/usr/bin/python3','-B',str(SOURCE/'rpc/server/dispatch_owner.py'),str(private/'dispatch.json')]
    write(public/'ATTEMPT.json',{'attempt':attempt,'units':[provisionunit,dispatchunit,signunit,exportunit],'argv':args,'clockSha256':clock['sha256'],
        'contractSha256':cb['sha256'],'requestSha256':requestsha,'testBinarySha256':g.digest(issuer),'chainMocked':True,'syntheticWindows':True})
    fds=[];killfd=None;peer=None;settled=False;launched=False
    try:
        for sock in sockets:sock.close()
        command(args);launched=True
        until=time.monotonic()+30
        while not (out/'response.json').exists():
            if inspect(dispatchunit)['ActiveState'] in ('failed','inactive'):raise ValueError('Dispatcher exited before response')
            if time.monotonic()>=until:raise TimeoutError('Finite composition dispatch bound')
            time.sleep(.025)
        reply=json.loads((out/'response.json').read_bytes());proof=reply['proof']
        assert proof['schema']=='enclave-rpc-storage-consent/2' and proof['export']==binding
        assert not reply['rpcReady'] and not reply['reservationMayRelease'] and not reply['writersFenced']
        persisted=json.loads((journal/('proof-'+requestsha)).read_bytes());assert persisted==proof
        for name in ('signer-submit.intent','signer-started.json','signer-result.json','export-submit.intent','export-submitted.json','response.json'):
            write(public/name,json.loads((out/name).read_bytes()))
        # No dispatcher response without the exact live export identity.
        live=inspect(exportunit);assert reply['exporter']['invocation']==live['InvocationID']
        group=Path('/sys/fs/cgroup'+live['ControlGroup']);groupid=group.stat()
        killfd=os.open(group/'cgroup.kill',os.O_WRONLY|os.O_CLOEXEC)
        ctx=ssl.create_default_context(cafile=str(controltls/'ca-cert.pem'));ctx.minimum_version=ctx.maximum_version=ssl.TLSVersion.TLSv1_3
        ctx.load_cert_chain(str(controltls/'client-cert.pem'),str(controltls/'client-key.pem'))
        peer=ctx.wrap_socket(socket.create_connection((binding['host'],binding['port']),timeout=3),server_hostname=binding['serverName'])
        assert hashlib.sha256(peer.getpeercert(binary_form=True)).hexdigest()==binding['serverCertificateSha256']
        hello=app_control.HELLO+bytes.fromhex(requestsha)+bytes.fromhex(cb['sha256']);peer.sendall(hello)
        expected=app_control.BOUND+hashlib.sha256(hello).digest();received=b''
        while len(received)<len(expected):
            part=peer.recv(len(expected)-len(received))
            if not part:raise EOFError('Control acknowledgement lost')
            received+=part
        assert received==expected
        ready=state/attempt/'ready.json'
        while not ready.exists():
            if inspect(exportunit)['ActiveState'] in ('failed','inactive'):raise ValueError('Exporter exited before dummy exports READY')
            if time.monotonic()>=until:raise TimeoutError('Finite composition READY bound')
            time.sleep(.025)
        receipt=json.loads(ready.read_bytes());assert receipt['invocation']==live['InvocationID'] and receipt['contractSha256']==cb['sha256'] and not receipt['rpcReady']
        g.protocol.negotiated(receipt['roles'],attempt);write(public/'READY.json',receipt)
        identities=[]
        for pid in map(int,(group/'cgroup.procs').read_text().split()):
            fd=None
            try:
                fd=os.pidfd_open(pid);text=Path('/proc',str(pid),'stat').read_text();fields=text[text.rfind(')')+2:].split();comm=Path('/proc',str(pid),'comm').read_text().strip()
            except FileNotFoundError:
                if fd is not None:os.close(fd)
                continue
            if not (str(pid)==live['MainPID'] or comm.startswith('qemu-nbd') or (fields[1]==live['MainPID'] and comm.startswith('python3'))):os.close(fd);continue
            assert Path('/proc',str(pid),'cgroup').read_text().strip()=='0::'+live['ControlGroup'] and not select.select([fd],[],[],0)[0]
            fds.append(fd);identities.append({'pid':pid,'start':fields[19],'comm':comm})
        assert len(fds)==4 and sum(x['comm'].startswith('qemu-nbd') for x in identities)==2
        write(public/'IDENTITIES.json',identities)
        started=time.monotonic();peer.close();peer=None
        while len(select.select(fds,[],[],.025)[0])!=4:
            if time.monotonic()-started>6:raise TimeoutError('Exact exporter tree did not terminate')
        elapsed=time.monotonic()-started
        terminal=state/attempt/'terminal.json'
        while not terminal.exists() or inspect(exportunit)['MainPID']!='0':
            if time.monotonic()-started>6:raise TimeoutError('Terminal exporter receipt missing')
            time.sleep(.025)
        t=json.loads(terminal.read_bytes());assert t['reason']=='app-control-lost' and t['released'] and t['ready'] and not t['adopted']
        if group.exists():
            st=group.stat();assert (st.st_dev,st.st_ino)==(groupid.st_dev,groupid.st_ino) and 'populated 0' in (group/'cgroup.events').read_text()
        assert all(g.digest(Path(n))==h for n,h in hashes.items())
        assert all(g.digest(Path(n))==h for n,h in pins.items())
        assert json.loads((journal/('proof-'+requestsha)).read_bytes())==proof
        # Actual provisioned state refuses spliced mappings and changed key
        # inodes after the one complete execution, without a second signer call.
        import owner_state as statecheck
        rejected=[]
        wrong=dict(policy);wrong['l1Volume']='f'*64
        wrongcontract=json.loads(json.dumps(contract));wrongcontract['roles']['l1']['originals']=contract['roles']['base']['originals']
        for label,cc,pp in [('wrong-volume',contract,wrong),('wrong-original-chain',wrongcontract,policy)]:
            try:statecheck.inspect(provision['authority'],cc,pp)
            except ValueError:rejected.append(label)
            else:raise AssertionError('Owner state accepted '+label)
        assert statecheck.inspect(provision['authority'],contract,policy)['journal']==[journal.stat().st_dev,journal.stat().st_ino]
        seedpath=authority/'l1-seed';seedpath.rename(authority/'retained-original-seed')
        seedpath.write_bytes(os.urandom(32));seedpath.chmod(0o600)
        try:statecheck.bind(provision['authority'],contract,policy)
        except ValueError:rejected.append('replaced-key')
        else:raise AssertionError('Owner state accepted replacement key')
        # Original key and all journals remain private and retained. No reset,
        # re-sign, re-provision or export restart follows this destructive fixture.
        write(public/'RESULT.json',{'pass':True,'actualCommandCode':True,'chainHTTPMocked':True,'actualDispatcher':True,'actualExports':True,'actualOwnerProvisioning':True,'stateRejections':rejected,
            'exactHeldProcessesExited':True,'secondsAfterControlLoss':elapsed,'journalRecordsRetained':sorted(p.name for p in journal.iterdir()),
            'originalHashesUnchanged':True,'sourcePinsUnchanged':True,'rpcReady':False,'reservationMayRelease':False})
        settled=True
    finally:
        if peer is not None:peer.close()
        if launched and not settled and killfd is None:
            # Only this fixture's exclusive random unit, never a broad job scan.
            row=inspect(exportunit)
            if row.get('MainPID','0')!='0':
                pid=int(row['MainPID']);fd=os.pidfd_open(pid)
                assert Path('/proc',str(pid),'cgroup').read_text().strip()=='0::'+row['ControlGroup']
                assert inspect(exportunit)['InvocationID']==row['InvocationID']
                fds.append(fd)
                killfd=os.open(Path('/sys/fs/cgroup'+row['ControlGroup'])/'cgroup.kill',os.O_WRONLY|os.O_CLOEXEC)
        if killfd is not None:
            if not settled:
                try:os.write(killfd,b'1')
                except OSError:pass
            os.close(killfd)
        if not settled and fds:
            until=time.monotonic()+6
            while len(select.select(fds,[],[],.025)[0])!=len(fds):
                if time.monotonic()>=until:raise TimeoutError('Failed fixture cleanup remains ambiguous')
        for fd in fds:os.close(fd)
        if launched:
            for unit in (provisionunit,dispatchunit,signunit,exportunit):
                write(public/(unit+'.json'),inspect(unit))
                log=subprocess.run(['/usr/bin/journalctl','--user','-u',unit,'--no-pager','-n','30','-o','cat'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3)
                # Journals contain failures/identities, never input private keys.
                (public/(unit+'.log')).write_bytes(log.stdout[:32768])
            for name in ('dispatch.stdout','dispatch.stderr'):
                if (private/name).exists():(public/name).write_bytes((private/name).read_bytes()[:65536])
    print(json.dumps({'pass':True,'chainMocked':True,'productionRPC':False}),flush=True)

if __name__=='__main__':main(*(Path(x).resolve() for x in sys.argv[1:]))
