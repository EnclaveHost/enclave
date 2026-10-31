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

def main(private,public,observer_config):
    os.umask(0o077)
    if os.sched_getaffinity(0)!={1}:raise ValueError('CPU1 required')
    private.mkdir(mode=0o700);public.mkdir(mode=0o700)
    v.directory(private);v.tool_pins()
    sourcepaths=[SOURCE/'rpc/server'/n for n in ('guarded_export.py','volume_export.py','observe_resources.mjs')]
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
    contract=private/'contract.json';write(contract,c)
    props=['Type=notify','NotifyAccess=main','WatchdogSec=2','WatchdogSignal=SIGKILL','KillMode=control-group','Restart=no',
           'MemoryMax=384M','MemorySwapMax=0','CPUQuota=100%','TasksMax=32','LimitCORE=0','RuntimeMaxSec=40',
           'TimeoutStartSec=3','TimeoutStopSec=1','SendSIGKILL=yes','FinalKillSignal=SIGKILL','UMask=0077']
    args=['/usr/bin/systemd-run','--user','--no-block','--unit='+unit]+['--property='+x for x in props]+['/usr/bin/taskset','-c','1','/usr/bin/python3','-B',str(SOURCE/'rpc/server/guarded_export.py'),str(contract)]
    write(public/'ATTEMPT.json',{'unit':unit,'argv':args,'atUtcNs':now,'dummyOnly':True,'windowsClockSynthetic':True,'originalClockSha256':binding['sha256'],'contractSha256':g.digest(contract)})
    fds=[];killfd=None;before=None;launched=False
    try:
        for sock in sockets:sock.close()
        command(args);launched=True
        until=time.monotonic()+15;ready=state/attempt/'ready.json'
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
            fd=os.pidfd_open(pid);fds.append(fd)
            comm=Path('/proc',str(pid),'comm').read_text().strip()
            assert Path('/proc',str(pid),'cgroup').read_text().strip()=='0::'+before['ControlGroup']
            identities.append({'pid':pid,'comm':comm})
            if str(pid)==before['MainPID']:mainfd=fd
        assert mainfd is not None and sum(x['comm'].startswith('qemu-nbd') for x in identities)==2
        write(public/'READY.json',receipt);write(public/'IDENTITIES.json',identities)
        started=time.monotonic();signal.pidfd_send_signal(mainfd,signal.SIGSTOP)
        while len(select.select(fds,[],[],.05)[0])!=len(fds):
            if time.monotonic()-started>6:raise TimeoutError('Exact watchdog tree death deadline')
        elapsed=time.monotonic()-started;after=inspect(unit)
        assert after['MainPID']=='0' and after['Result']=='watchdog' and after['ExecMainStatus']=='9',after
        if cg.exists():
            st=cg.stat();assert (st.st_dev,st.st_ino)==(cgid.st_dev,cgid.st_ino)
            assert 'populated 0' in (cg/'cgroup.events').read_text()
        assert all(g.digest(Path(n))==h for n,h in hashes.items())
        assert all(g.digest(Path(n))==h for n,h in pins.items())
        result={'pass':True,'fullMaintainedCLI':True,'actualAuthenticatedAdmission':True,'bothTLSExportsReady':True,
                'originalHashesUnchanged':True,'sourcePinsUnchanged':True,'exactHeldProcessesExited':True,
                'cgroupEmptyOrRemoved':True,'watchdogDeathSeconds':elapsed,'before':before,'after':after,
                'dummyOnly':True,'productionData':False,'kernelAttachmentTested':False,'rpcReady':False,'reservationMayRelease':False}
        write(public/'RESULT.json',result);print(json.dumps(result),flush=True)
    finally:
        if killfd is not None:
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

if __name__=='__main__':main(*(Path(x).resolve() for x in sys.argv[1:]))
