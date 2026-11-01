"""Full maintained export CLI on sparse dummy images and real local admission.

Reserve 1024MiB for the 128MiB queue wrapper, its 512MiB controller scope,
and the separate 384MiB actor; all CPU1/noSwap. TLS keys and dummy images stay in the private work directory.
No production image, guest, adoption, or financial operation is used.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import select
import signal
import socket
import ssl
import subprocess
import sys
import time
import uuid

SOURCE=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(SOURCE/'rpc/server'))
import volume_export as v
import guarded_export as g
_spec=importlib.util.spec_from_file_location('startup_clock',SOURCE/'rpc/startup_clock.py')
clock=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(clock)

def command(args,seconds=5):
    r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=seconds)
    if len(r.stdout)+len(r.stderr)>65536:raise ValueError('Output bound')
    if r.returncode:raise ValueError('Command failure: '+r.stderr.decode(errors='replace')[:2048])
    return r.stdout.decode()

def write(path,value):
    with path.open('x') as f:
        json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())

def inspect(unit):
    keys='Id,LoadState,MainPID,ActiveState,SubState,InvocationID,ControlGroup,Result,ExecMainStatus,MemoryPeak'
    return dict(x.split('=',1) for x in command(['/usr/bin/systemctl','--user','show',unit,'--property='+keys]).splitlines() if '=' in x)

def main(private,public,observer_config,app_control_loss=False):
    os.umask(0o077)
    if os.sched_getaffinity(0)!={1}:raise ValueError('CPU1 required')
    private.mkdir(mode=0o700);public.mkdir(mode=0o700)
    v.directory(private);v.tool_pins()
    sourcepaths=[SOURCE/'rpc/server'/n for n in ('guarded_export.py','volume_export.py','observe_resources.mjs')]
    if app_control_loss:sourcepaths.append(SOURCE/'rpc/server/app_control.py')
    sourcepaths += [SOURCE/'rpc/storage_protocol.py',SOURCE/'rpc/startup_clock.py',Path('/usr/bin/node'),observer_config,Path(__file__).resolve()]
    pins={str(p):g.digest(p) for p in sourcepaths}
    write(public/'PINS.json',pins)
    argv=['/usr/bin/node',str(SOURCE/'rpc/server/observe_resources.mjs'),str(observer_config)]
    h=json.loads(command(argv,2))
    if not h['authenticated'] or h['unreadUnits'] or h['availableMiB']-h['pendingMiB']-1024<max(27648,h['floorMiB']):
        raise ValueError('Fresh complete1024MiB fixture resource admission failed')
    write(public/'ADMISSION.json',h)
    attempt=uuid.uuid4().hex;unit='enclave-rpc-export-'+attempt+'.service'
    if inspect(unit)['LoadState']!='not-found':raise ValueError('Consumed unit')
    instance='rpc-owned-fixture-'+attempt
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
        original=root/'dummy.qcow2'
        # Protocol requires exact volume geometry; sparse metadata only, no chain data.
        command(['/usr/bin/qemu-img','create','-q','-f','qcow2',str(original),'4000000000000'])
        if original.stat().st_blocks*512>16<<20:raise ValueError('Dummy allocation bound')
        hashes[str(original)]=g.digest(original)
        exports=root/'exports';exports.mkdir(mode=0o700)
        sock=socket.socket();sock.bind(('127.0.0.1',0));sockets.append(sock)
        roles[role]={'parent':str(exports),'originals':[[str(original),v.metadata(original)]],'bytes':4000000000000,
                     'tls':str(tls),'clientTls':str(tls),'tlsName':'rpc-fixture.local','host':'127.0.0.1','port':sock.getsockname()[1]}
    state=private/'state';state.mkdir(mode=0o700)
    clock_parent=private/'clock';clock_parent.mkdir(mode=0o700)
    original=clock.begin(clock_parent,attempt,instance,uuid.uuid4().hex)
    begin=json.loads(clock.read_pinned(original))
    # Explicitly synthetic Windows data for this Linux-only dummy fixture.
    # This does not qualify an authenticated Windows sample or any VM operation.
    sample=clock.write_new(private/'windows-clock-fixture.json',clock.encode({
        'schema':'owned-rpc-windows-clock/1','attempt':attempt,'vmAttempt':begin['vmAttempt'],
        'windowsBoot':uuid.uuid4().hex,'monotonicMilliseconds':1000000000}))
    binding=clock.finish(original,sample);actual_clock=clock.validate(binding)
    now=actual_clock['createdUtcNs']
    c={'attempt':attempt,'instance':instance,'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
       'createdUtcNs':now,'deadlineUtcNs':now+900_000_000_000,'floorMiB':27648,'reserveMiB':512,
       'resourceArgv':argv,'sourcePins':pins,'stateParent':str(state),'roles':roles,'startupClock':binding}
    if app_control_loss:
        # Fixture-only use of the generated L1 credential. Actual native-app
        # provisioning must bind a dedicated credential to authenticated consent.
        control_tls=Path(roles['l1']['tls'])
        reserve=socket.socket();reserve.bind(('127.0.0.1',0));sockets.append(reserve)
        c['appControl']={'schema':'enclave-rpc-export-control/1','host':'127.0.0.1','port':reserve.getsockname()[1],
            'tls':str(control_tls),'requestSha256':'12'*32,
            'clientCertificateSha256':hashlib.sha256(ssl.PEM_cert_to_DER_cert((control_tls/'client-cert.pem').read_text())).hexdigest()}
    contract=private/'contract.json';write(contract,c)
    props=['Type=notify','NotifyAccess=main','WatchdogSec=2','WatchdogSignal=SIGKILL','KillMode=control-group','Restart=no',
           'MemoryMax=384M','MemorySwapMax=0','CPUQuota=100%','TasksMax=32','LimitCORE=0','RuntimeMaxSec=40',
           'TimeoutStartSec=3','TimeoutStopSec=1','SendSIGKILL=yes','FinalKillSignal=SIGKILL','UMask=0077']
    args=['/usr/bin/systemd-run','--user','--no-block','--unit='+unit]+['--property='+x for x in props]+['/usr/bin/taskset','-c','1','/usr/bin/python3','-B',str(SOURCE/'rpc/server/guarded_export.py'),str(contract)]
    write(public/'ATTEMPT.json',{'unit':unit,'argv':args,'atUtcNs':now,'dummyOnly':True,'windowsClockSynthetic':True,'originalClockSha256':binding['sha256'],'contractSha256':g.digest(contract)})
    fds=[];killfd=None;before=None;launched=False;control_peer=None;settled=False
    try:
        for sock in sockets:sock.close()
        command(args);launched=True
        until=time.monotonic()+15;ready=state/attempt/'ready.json'
        if app_control_loss:
            listening=state/attempt/'control-listening.json'
            while not listening.exists():
                if inspect(unit)['ActiveState'] in ('failed','inactive'):raise ValueError('CLI exited before control listener')
                if time.monotonic()>=until:raise TimeoutError('Control listener fixture budget')
                time.sleep(.025)
            from app_control import HELLO,BOUND
            assert json.loads(listening.read_text())=={'contractSha256':g.digest(contract),'requestSha256':'12'*32,'bound':False,'rpcReady':False}
            ctx=ssl.create_default_context(cafile=str(control_tls/'ca-cert.pem'))
            ctx.minimum_version=ctx.maximum_version=ssl.TLSVersion.TLSv1_3
            ctx.load_cert_chain(str(control_tls/'client-cert.pem'),str(control_tls/'client-key.pem'))
            # Exactly one connect/submission, no transport retry.
            control_peer=ctx.wrap_socket(socket.create_connection(('127.0.0.1',c['appControl']['port']),timeout=3),server_hostname='rpc-fixture.local')
            hello=HELLO+bytes.fromhex('12'*32)+bytes.fromhex(g.digest(contract));control_peer.sendall(hello)
            expected=BOUND+hashlib.sha256(hello).digest();received=b''
            while len(received)<len(expected):
                part=control_peer.recv(len(expected)-len(received))
                if not part:raise EOFError('Control acknowledgement lost')
                received+=part
            assert received==expected
        while not ready.exists():
            p=inspect(unit)
            if p['ActiveState'] in ('failed','inactive'):raise ValueError('CLI exited before READY: '+str(p))
            if time.monotonic()>=until:raise TimeoutError('Finite fixture READY budget')
            time.sleep(.05)
        receipt=json.loads(ready.read_text());before=inspect(unit)
        assert receipt['invocation']==before['InvocationID'] and receipt['contractSha256']==g.digest(contract)
        assert receipt['rpcReady'] is False and receipt['instance']==instance
        g.protocol.negotiated(receipt['roles'],attempt)
        cg=Path('/sys/fs/cgroup'+before['ControlGroup']);cgid=cg.stat()
        killfd=os.open(cg/'cgroup.kill',os.O_WRONLY|os.O_CLOEXEC)
        identities=[];mainfd=None
        for pid in map(int,(cg/'cgroup.procs').read_text().split()):
            try:fd=os.pidfd_open(pid)
            except ProcessLookupError:continue # a short-lived resource reader
            try:
                comm=Path('/proc',str(pid),'comm').read_text().strip()
                raw=Path('/proc',str(pid),'stat').read_text();fields=raw[raw.rfind(')')+2:].split()
            except FileNotFoundError:os.close(fd);continue
            if not (str(pid)==before['MainPID'] or comm.startswith('qemu-nbd') or
                    (fields[1]==before['MainPID'] and comm.startswith('python3'))):
                os.close(fd);continue
            fds.append(fd)
            assert Path('/proc',str(pid),'cgroup').read_text().strip()=='0::'+before['ControlGroup']
            assert not select.select([fd],[],[],0)[0]
            identities.append({'pid':pid,'comm':comm,'start':fields[19]})
            if str(pid)==before['MainPID']:mainfd=fd
        assert len(identities)==4 and mainfd is not None and sum(x['comm'].startswith('qemu-nbd') for x in identities)==2
        write(public/'READY.json',receipt);write(public/'IDENTITIES.json',identities)
        assert all(not select.select([fd],[],[],0)[0] for fd in fds)
        started=time.monotonic()
        if app_control_loss:control_peer.close();control_peer=None
        else:signal.pidfd_send_signal(mainfd,signal.SIGSTOP)
        while len(select.select(fds,[],[],.05)[0])!=len(fds):
            if time.monotonic()-started>6:raise TimeoutError('Exact watchdog tree death deadline')
        elapsed=time.monotonic()-started;after=inspect(unit)
        while after['MainPID']!='0' and time.monotonic()-started<6:
            time.sleep(.025);after=inspect(unit)
        if app_control_loss:
            terminal=json.loads((state/attempt/'terminal.json').read_text())
            assert terminal['reason']=='app-control-lost' and terminal['released'] and terminal['ready'] and not terminal['adopted'],terminal
            assert not terminal['writersFenced'] and not terminal['reservationMayRelease']
            assert after['MainPID']=='0' and after['Result']=='exit-code' and after['ExecMainStatus']=='2',after
            write(public/'CONTROL-TERMINAL.json',terminal)
        else:assert after['MainPID']=='0' and after['Result']=='watchdog' and after['ExecMainStatus']=='9',after
        if cg.exists():
            st=cg.stat();assert (st.st_dev,st.st_ino)==(cgid.st_dev,cgid.st_ino)
            assert 'populated 0' in (cg/'cgroup.events').read_text()
        assert all(g.digest(Path(n))==h for n,h in hashes.items())
        assert all(g.digest(Path(n))==h for n,h in pins.items())
        result={'pass':True,'fullMaintainedCLI':True,'actualAuthenticatedAdmission':True,'bothTLSExportsReady':True,
                'originalHashesUnchanged':True,'sourcePinsUnchanged':True,'exactHeldProcessesExited':True,
                'cgroupEmptyOrRemoved':True,'terminationSeconds':elapsed,'appControlLoss':app_control_loss,'before':before,'after':after,
                'dummyOnly':True,'productionData':False,'kernelAttachmentTested':False,'rpcReady':False,'reservationMayRelease':False}
        if not app_control_loss:result['watchdogDeathSeconds']=elapsed
        settled=True;write(public/'RESULT.json',result);print(json.dumps(result),flush=True)
    finally:
        if control_peer is not None:control_peer.close()
        if killfd is not None:
            if not settled:
                try:os.write(killfd,b'1')
                except OSError:pass
            os.close(killfd)
        elif launched:
            # Exclusive random unit can only belong to this consumed fixture.
            command(['/usr/bin/systemctl','--user','stop',unit],4)
        for fd in fds:os.close(fd)
        if launched:
            write(public/'TERMINAL.json',inspect(unit))
            log=subprocess.run(['/usr/bin/journalctl','--user','-u',unit,'--no-pager','-n','35','-o','cat'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3)
            (public/'UNIT.log').write_bytes(log.stdout[:32768])

if __name__=='__main__':
    if len(sys.argv) not in (4,5) or (len(sys.argv)==5 and sys.argv[4]!='--app-control-loss'):
        raise SystemExit('private public observer-config [--app-control-loss]')
    main(*(Path(x).resolve() for x in sys.argv[1:4]),app_control_loss=len(sys.argv)==5)
