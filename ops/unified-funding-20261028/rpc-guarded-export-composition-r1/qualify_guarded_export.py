"""Finite, real Warden exporter composition qualification with dummy volumes.

Run only in an independently admitted bounded controller. Uses actual local
resource authority and user systemd, ephemeral private credentials and sparse
dummy QCOW2 images. The Windows clock sample is explicitly synthetic. Never
opens production volumes, calls a VM provider, adopts an export or runs RPC.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import socket
import ssl
import struct
import subprocess
import sys
import time
import uuid

SOURCE = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


startup = load('startup', SOURCE/'rpc/run_startup.py')
credentials = load('fixture_credentials', SOURCE/'rpc/guest/credentials.py')
c, p, prepare = startup.c, startup.p, startup.prepare


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def command(argv, timeout=5):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if len(result.stdout)+len(result.stderr)>65536 or result.returncode:
        raise ValueError('Bounded qualification command failed: '+str(argv[0]))
    return result.stdout


def process(pid):
    text = Path('/proc',str(pid),'stat').read_text()
    row = text[text.rfind(')')+2:].split()
    return {'pid':pid,'parent':int(row[1]),'start':row[19],
            'exe':os.readlink('/proc/'+str(pid)+'/exe'),
            'group':Path('/proc',str(pid),'cgroup').read_text().strip()}


def receive(sock, length):
    result = b''
    while len(result)<length:
        part = sock.recv(length-len(result))
        if not part:raise EOFError('NBD closed')
        result += part
    return result


class Client:
    def __init__(self, row, attempt, role):
        self.sock = socket.create_connection((row['host'],row['port']),timeout=2)
        self.sock.settimeout(2);self.sequence=0
        try:
            magic,opt,flags = struct.unpack('>QQH',receive(self.sock,18))
            assert (magic,opt)==(0x4e42444d41474943,0x49484156454f5054) and flags&3==3
            self.sock.sendall(struct.pack('>I',3))
            self.sock.sendall(struct.pack('>QII',opt,5,0))
            assert struct.unpack('>QIII',receive(self.sock,20))==(0x3e889045565a9,5,1,0)
            tls=Path(row['clientTls']);ctx=ssl.create_default_context(cafile=str(tls/'ca-cert.pem'))
            ctx.load_cert_chain(str(tls/'client-cert.pem'),str(tls/'client-key.pem'))
            self.sock=ctx.wrap_socket(self.sock,server_hostname=row['tlsName'])
            name=('rpc-'+attempt+'-'+role).encode()
            self.sock.sendall(struct.pack('>QII',opt,1,len(name))+name)
            size,flags=struct.unpack('>QH',receive(self.sock,10))
            assert size==p.BYTES and flags&15==13
        except BaseException:
            self.sock.close();raise

    def request(self, operation, payload=b'', flags=0):
        self.sequence+=1
        size=4096 if operation==0 else len(payload)
        assert operation in (0,1,3) and (not payload or len(payload)==4096)
        self.sock.sendall(struct.pack('>IHHQQI',0x25609513,flags,operation,self.sequence,0,size)+payload)
        assert struct.unpack('>IIQ',receive(self.sock,16))==(0x67446698,0,self.sequence)
        return receive(self.sock,size) if operation==0 else b''

    def close(self):
        self.sequence+=1
        try:self.sock.sendall(struct.pack('>IHHQQI',0x25609513,0,2,self.sequence,0,0))
        finally:self.sock.close()


def qualify(parent, resource_binding, host):
    os.umask(0o077)
    parent=c.directory(parent)
    attempt=uuid.uuid4().hex;instance='rpc-owned-fixture-'+attempt
    root=parent/attempt;root.mkdir(mode=0o700)
    for name in ('clock','credentials','originals','exports','state','prepared'):
        (root/name).mkdir(mode=0o700)
    # This fixture has a real original owner clock and an explicitly synthetic
    # Windows sample. It makes no Windows/production clock provenance claim.
    begin=c.begin(root/'clock',attempt,instance,uuid.uuid4().hex)
    sample=c.write_new(root/'clock/sample.json',c.encode({'schema':'owned-rpc-windows-clock/1',
        'attempt':attempt,'vmAttempt':p.decode(c.read_pinned(begin))['vmAttempt'],
        'windowsBoot':uuid.uuid4().hex,'monotonicMilliseconds':1_000_000}))
    clock=c.finish(begin,sample)
    toolpins={name:{'path':'/usr/bin/'+name,'sha256':digest('/usr/bin/'+name)} for name in ('openssl','ssh-keygen')}
    bundle=credentials.generate(root/'credentials',attempt,instance,toolpins)
    public={'path':bundle['path']+'/PUBLIC.json','sha256':bundle['publicReceiptSha256']}
    required={str(SOURCE/'rpc/server'/n) for n in ('guarded_export.py','volume_export.py','observe_resources.mjs')}
    required|={str(SOURCE/'rpc'/n) for n in ('startup_clock.py','storage_protocol.py')}
    required|={'/usr/bin/node',resource_binding['path']}|set(prepare.volume.TOOLS)
    pins={name:digest(name) for name in required}
    cfg={'clock':clock,'credentialReceipt':public,'resourceConfig':resource_binding,'runtimePins':pins,
         'roles':{},'stateParent':str(root/'state'),'output':str(root/'prepared'/attempt),
         'floorMiB':27648,'reserveMiB':1280}
    # Fresh actual authority: controller512+outer128+export384+bootstrap allowance.
    admitted=startup.resource_admission({'export':cfg,'ownerReserveMiB':1280})
    c.write_new(root/'ADMISSION.json',c.encode(admitted))
    held_ports=[];original_hashes={}
    try:
        for role in ('l1','base'):
            sock=socket.socket();sock.bind((host,0));held_ports.append(sock)
            original=root/'originals'/(role+'.qcow2')
            command(['/usr/bin/qemu-img','create','-q','-f','qcow2',str(original),str(p.BYTES)])
            assert original.stat().st_size<8<<20
            original_hashes[str(original)]=digest(original)
            cfg['roles'][role]={'parent':str(root/'exports'),'originals':[[str(original),prepare.volume.metadata(original)]],
                'tls':bundle['path']+'/'+role+'/server','clientTls':bundle['path']+'/'+role+'/client',
                'host':host,'port':sock.getsockname()[1]}
        prepared=prepare.prepare(cfg)
    finally:
        for sock in held_ports:sock.close()
    # This exclusive fixture intent precedes the single actual launcher call.
    c.write_new(root/'launch.intent',c.encode({'contract':prepared['contract'],'dummyOnly':True}))
    lease=None;killfd=None;held=[];fallback=False;success=False
    try:
        lease=startup.start_export(clock,prepared['contract'])
        identity=lease.check();c.write_new(root/'IDENTITY.json',c.encode(identity))
        cg=Path('/sys/fs/cgroup'+lease.group);cg_stat=cg.stat()
        killfd=os.open(cg/'cgroup.kill',os.O_WRONLY|os.O_CLOEXEC)
        ready=startup.await_ready(clock,prepared['contract'],lease)
        server=p.decode(c.read_pinned(prepared['contract']))
        for role,row in server['roles'].items():
            client=Client(row,attempt,role)
            try:
                assert client.request(0)==bytes(4096)
                client.request(1,b'B'*4096,flags=1);client.request(3)
                assert client.request(0)==b'B'*4096
            finally:client.close()
            client=Client(row,attempt,role)
            try:assert client.request(0)==b'B'*4096
            finally:client.close()
        # Hold exact guardian, forked owner and both qemu-nbd process handles
        # before loss injection. Short-lived resource readers may exit normally.
        rows=[]
        for value in (cg/'cgroup.procs').read_text().split():
            pid=int(value)
            try:row=process(pid)
            except FileNotFoundError:continue
            if pid==lease.pid or row['exe']==str(Path('/usr/sbin/qemu-nbd').resolve()) or (row['parent']==lease.pid and row['exe']==str(Path('/usr/bin/python3').resolve())):
                fd=os.pidfd_open(pid);held.append(fd)
                assert process(pid)==row and row['group']=='0::'+lease.group
                rows.append(row)
        assert len(rows)==4 and sum(r['exe']==str(Path('/usr/sbin/qemu-nbd').resolve()) for r in rows)==2
        assert all(not select.select([fd],[],[],0)[0] for fd in held)
        lease.check();before=startup.show(lease.unit)
        stopped=time.monotonic();signal.pidfd_send_signal(lease.fd,signal.SIGSTOP)
        until=stopped+6
        while len(select.select(held,[],[],.05)[0])!=len(held):
            if time.monotonic()>=until:raise TimeoutError('Composed watchdog did not kill exact tree')
        death_seconds=time.monotonic()-stopped
        after=startup.show(lease.unit)
        while after['MainPID']!='0' and time.monotonic()<until:
            time.sleep(.025);after=startup.show(lease.unit)
        status=dict(line.split('=',1) for line in command(['/usr/bin/systemctl','--user','show',lease.unit,
            '-p','Result','-p','ExecMainStatus','-p','MainPID']).decode().splitlines())
        assert status=={'Result':'watchdog','ExecMainStatus':'9','MainPID':'0'}
        if cg.exists():
            st=cg.stat();assert (st.st_dev,st.st_ino)==(cg_stat.st_dev,cg_stat.st_ino)
            assert 'populated 0' in (cg/'cgroup.events').read_text()
        assert all(digest(path)==sha for path,sha in original_hashes.items())
        assert all(digest(path)==sha for path,sha in pins.items())
        c.validate(clock)
        result={'allPass':True,'attempt':attempt,'controllerInvocation':os.environ.get('INVOCATION_ID'),
            'identity':identity,'exactProcesses':rows,'before':before,'after':after,'terminal':status,
            'readySha256':ready['sha256'],'authenticatedPendingAwareAdmission':admitted,
            'bothRolesReadWriteFuaFlushReconnect':True,'originalHashesUnchanged':True,
            'exactFourPidfdsExited':True,'cgroupEmptyOrRemoved':True,'watchdogDeathSeconds':death_seconds,
            'virtualBytesPerDummyVolume':p.BYTES,'applicationBytesWrittenPerRole':4096,
            'sourcePinsUnchanged':True,'syntheticWindowsSample':True,'productionData':False,
            'kernelAttachmentTested':False,'cleanFilesystemProven':False,'rpcReady':False,
            'writersFenced':False,'reservationMayRelease':False}
        c.write_new(root/'RESULT.json',c.encode(result))
        success=True
        return result
    finally:
        if killfd is not None:
            # Exact held cgroup descriptor cannot target a replacement unit.
            # Only fallback cleanup on failure, never evidence of watchdog death.
            if not success:
                try:os.write(killfd,b'1');fallback=True
                except OSError:pass
            os.close(killfd)
        for fd in held:os.close(fd)
        if lease is not None:lease.close()
        c.write_new(root/'CONTROLLER-FINALLY.json',c.encode({'fallbackKillAttempted':fallback}))


if __name__=='__main__':
    config=json.loads(Path(sys.argv[1]).read_text())
    result=qualify(Path(config['privateParent']),config['resourceConfig'],config['host'])
    print(json.dumps(result),flush=True)
