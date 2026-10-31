"""Independent export guardian, with a closed work gate and systemd backstop.

Only the explicit CLI checks/adopts a production unit. Imported guard() is also
used by finite, isolated death/deadline fixtures. No RPC readiness is inferred.
"""
import ctypes
import hashlib
import json
import os
import re
from pathlib import Path
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time

from volume_export import CowExport, directory


def digest(path):
    with open(path, 'rb') as f:return hashlib.file_digest(f, 'sha256').hexdigest()


def protected_json(path):
    path=Path(path);directory(path.parent);s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1 or s.st_size>65536:
        raise ValueError('Protected bounded contract required')
    with path.open('rb') as f:data=f.read(65537)
    if len(data)>65536:raise ValueError('Contract grew')
    return json.loads(data)


def notify(message):
    address=os.environ.get('NOTIFY_SOCKET')
    if not address:raise ValueError('Missing independent systemd watchdog')
    if address.startswith('@'):address='\0'+address[1:]
    with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as s:s.sendto(message.encode(),address)


def unit_admission(c):
    unit='enclave-rpc-export-'+c['attempt']+'.service'
    props=['Id','MainPID','InvocationID','ControlGroup','KillMode','Restart','WatchdogUSec','WatchdogSignal','MemoryMax','MemorySwapMax','CPUQuotaPerSecUSec','TasksMax','LimitCORE']
    r=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property='+','.join(props)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=2,check=True)
    if len(r.stdout)+len(r.stderr)>16384:raise ValueError('Unit output bound')
    p=dict(line.split('=',1) for line in r.stdout.decode().splitlines() if '=' in line)
    if (p['Id']!=unit or p['MainPID']!=str(os.getpid()) or p['InvocationID']!=os.environ.get('INVOCATION_ID')
            or p['KillMode']!='control-group' or p['Restart']!='no' or p['WatchdogUSec']!='2s'
            or p['WatchdogSignal']!='9' or p['MemoryMax']!=str(384<<20) or p['MemorySwapMax']!='0'
            or p['CPUQuotaPerSecUSec']!='1s' or p['TasksMax']!='32' or p['LimitCORE']!='0'):
        raise ValueError('Independent unit envelope mismatch')
    group=Path('/sys/fs/cgroup'+p['ControlGroup'])
    if Path('/proc/self/cgroup').read_text().strip()!='0::'+p['ControlGroup'] or not p['ControlGroup'].endswith('/'+unit):
        raise ValueError('Exact unit membership required')
    if (group/'memory.max').read_text().strip()!=str(384<<20) or (group/'memory.swap.max').read_text().strip()!='0':
        raise ValueError('Kernel envelope mismatch')
    return p


def adoption(c,path,ready_sha,now_ns):
    if not path.exists():return None
    row=protected_json(path)
    expected={'attempt':c['attempt'],'bootId':c['bootId'],'contractSha256':c['contractSha256'],'readySha256':ready_sha}
    if set(row)!=set(expected)|{'adoptedUtcNs'} or any(row[k]!=v for k,v in expected.items()):
        raise ValueError('Adoption binding mismatch')
    t=row['adoptedUtcNs']
    if type(t) is not int or not c['createdUtcNs']<=t<=now_ns<c['deadlineUtcNs']:
        raise ValueError('Adoption was not observed within original startup window')
    return digest(path)


def reap_group(pid, grace=.5):
    # Sole reaper keeps the leader PID reserved until every group signal is sent.
    try:os.killpg(pid,signal.SIGTERM)
    except ProcessLookupError:pass
    until=time.monotonic()+grace
    while time.monotonic()<until:
        value=os.waitid(os.P_PID,pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
        if value is not None:break
        time.sleep(.01)
    try:os.killpg(pid,signal.SIGKILL)
    except ProcessLookupError:pass
    _,status=os.waitpid(pid,0)
    return os.waitstatus_to_exitcode(status)


def guard(owner, resource_argv, deadline, floor_mib, reserve_mib, watchdog, on_ready, adopted):
    """Guardian never runs disk/provider work. Owner waits for current resources.

    The caller must provide the independent cgroup/watchdog envelope. Child/group
    death on guardian failure is backed by systemd; PDEATHSIG also kills the owner.
    """
    if not 0<deadline-time.monotonic()<=900:raise ValueError('Expired original deadline')
    parent,child=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
    parent.setblocking(False)
    original_parent=os.getpid();pid=os.fork()
    if pid==0:
        parent.close()
        try:
            os.setsid()
            if ctypes.CDLL(None,use_errno=True).prctl(1,signal.SIGKILL,0,0,0)!=0:raise OSError('PDEATHSIG')
            if os.getppid()!=original_parent:os._exit(125)
            child.send(b'HELD')
            if child.recv(8)!=b'GO':os._exit(125)
            owner(child,deadline)
            os._exit(0)
        except BaseException:
            os._exit(126)
    child.close();pidfd=os.pidfd_open(pid);os.set_blocking(pidfd,False)
    sel=selectors.DefaultSelector();sel.register(parent,selectors.EVENT_READ,'owner');sel.register(pidfd,selectors.EVENT_READ,'death')
    resource=None;buffer=bytearray();resource_eof=False;resource_started=0.;last_good=None
    held=False;released=False;ready=False;adopted_once=False;last_probe=0.;why='guardian-error';owner_exit=None
    try:
        watchdog()
        while True:
            now=time.monotonic()
            if now>=deadline and not adopted_once:why='startup-deadline';break
            if last_good is not None and now-last_good>=2:why='resource-observation-expired';break
            if resource is not None and now-resource_started>=1.5:why='resource-observer-timeout';break
            if ready and not adopted_once:
                accepted=adopted()
                if accepted:
                    if time.monotonic()>=deadline:why='late-adoption';break
                    parent.send(b'ADOPT');adopted_once=True
            elif adopted_once and not adopted():raise ValueError('Adoption withdrawn or changed')
            if resource is None and now-last_probe>=.5:
                resource=subprocess.Popen(resource_argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True,bufsize=0)
                os.set_blocking(resource.stdout.fileno(),False);sel.register(resource.stdout,selectors.EVENT_READ,'resource')
                resource_started=now;last_probe=now;buffer=bytearray();resource_eof=False
            for key,_ in sel.select(.05):
                if key.data=='death':why='owner-exited';break
                if key.data=='owner':
                    data=parent.recv(65537)
                    if not data:why='owner-channel-closed';break
                    if data==b'HELD' and not held:
                        if os.getpgid(pid)!=pid:raise ValueError('Owner is not in its private group')
                        held=True
                    elif data.startswith(b'READY ') and released and not ready and len(data)<=65536:
                        on_ready(json.loads(data[6:]));ready=True
                    else:raise ValueError('Unexpected owner message')
                if key.data=='resource':
                    data=os.read(resource.stdout.fileno(),65537-len(buffer));buffer.extend(data)
                    if len(buffer)>65536:raise ValueError('Resource output bound')
                    if not data:
                        sel.unregister(resource.stdout);resource.stdout.close()
                        resource_eof=True
            if resource is not None and resource_eof:
                # EOF may precede process exit. Keep its PID reserved and poll,
                # subject to the same original observer timeout; never respawn.
                info=os.waitid(os.P_PID,resource.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                if info is not None:
                    rc=reap_group(resource.pid,0);resource.returncode=rc;resource=None
                    row=json.loads(buffer)
                    if rc!=0 or row.get('authenticated') is not True or row.get('unreadUnits')!=0:
                        raise ValueError('Authoritative resource status unavailable')
                    for field in ['availableMiB','pendingMiB','floorMiB']:
                        if type(row.get(field)) is not int or row[field]<0:raise ValueError('Resource schema')
                    if row['availableMiB']-row['pendingMiB']-reserve_mib<max(floor_mib,row['floorMiB']):
                        why='host-reserve';break
                    if time.monotonic()-resource_started>=1.5:raise ValueError('Resource observation too old')
                    last_good=resource_started
            if why in ('owner-exited','owner-channel-closed','host-reserve'):break
            if held and not released and last_good is not None:
                if time.monotonic()>=deadline:why='startup-deadline';break
                parent.send(b'GO');released=True
            watchdog()
    finally:
        # Send group signals before reaping either exact group leader. systemd
        # KillMode=control-group is the independent backstop if this code stalls.
        owner_exit=reap_group(pid)
        if resource is not None:
            resource.returncode=reap_group(resource.pid,0)
            resource.stdout.close()
        sel.close();parent.close();os.close(pidfd)
    return {'reason':why,'ownerExit':owner_exit,'released':released,'ready':ready,'adopted':adopted_once,
            'writersFenced':False,'reservationMayRelease':False}


def parse_probe(text,name,size):
    # Pinned QEMU's actual single-quoted names and padded numeric fields.
    lines=[line.strip() for line in text.splitlines()]
    names=[m.group(1) for line in lines if (m:=re.fullmatch(r"export: '([^']+)'",line))]
    sizes=[int(m.group(1)) for line in lines if (m:=re.fullmatch(r'size:\s+(\d+)',line))]
    flags=[int(m.group(1),16) for line in lines if (m:=re.fullmatch(r'flags:\s+0x([0-9a-fA-F]+)(?: \(.*\))?',line))]
    if names!=[name] or sizes!=[size] or len(flags)!=1 or flags[0]&15!=13:
        raise ValueError('Negotiated writable export/size/flush/FUA mismatch')
    return True


def probe_export(instance, row):
    """Authenticated exact-binary metadata negotiation; no data writes."""
    client=directory(row['clientTls'])
    for name in ('ca-cert.pem','client-cert.pem','client-key.pem'):
        path=client/name;s=path.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1:
            raise ValueError('Protected client credential required')
    args=['/usr/sbin/qemu-nbd','--list','--bind',instance.host,'--port',str(instance.port),
          '--object','tls-creds-x509,id=client0,endpoint=client,dir='+str(client)+',verify-peer=on',
          '--tls-creds','client0','--tls-hostname',row['tlsName']]
    until=min(instance.deadline,time.monotonic()+3)
    while time.monotonic()<until:
        instance.check()
        if instance.proc.poll() is not None:raise ValueError('Export died before negotiation')
        result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=min(1,until-time.monotonic()))
        if len(result.stdout)+len(result.stderr)>65536:raise ValueError('Probe output bound')
        if result.returncode==0:
            text=result.stdout.decode('utf-8','strict')
            parse_probe(text,instance.name,instance.size)
            if instance.proc.poll() is not None:raise ValueError('Export died after negotiation')
            instance.check()
            return {'export':instance.name,'bytes':instance.size,'authenticated':True,'flush':True,'fua':True}
        time.sleep(.025)
    raise TimeoutError('Authenticated export negotiation deadline')


def export_owner(c,channel,deadline):
    exports=[];stopping=False;adopted=False
    def stop(*_):
        nonlocal stopping
        stopping=True
    signal.signal(signal.SIGTERM,stop)
    try:
        ready={}
        for role,row in c['roles'].items():
            instance=CowExport(Path(row['parent']),c['attempt'],role,row['originals'],row['bytes'],Path(row['tls']),row['host'],row['port'],deadline)
            exports.append(instance);instance.start()
            ready[role]=probe_export(instance,row)
        channel.send(b'READY '+json.dumps(ready).encode());channel.setblocking(False)
        while not stopping:
            try:
                message=channel.recv(32)
                if message==b'ADOPT' and not adopted and time.monotonic()<deadline:adopted=True
                else:raise ValueError('Closed or unexpected guardian channel')
            except BlockingIOError:pass
            for instance in exports:
                if instance.proc.poll() is not None:raise RuntimeError('Export child exited')
                if not adopted:instance.check()
                else:
                    from volume_export import metadata
                    if any(metadata(p)!=expected for p,expected in instance.originals):raise ValueError('Original changed')
            time.sleep(.1)
    finally:
        for instance in reversed(exports):instance.close()


def main(path):
    os.umask(0o077)
    c=protected_json(path);c['contractSha256']=digest(path)
    if not re.fullmatch('[0-9a-f]{32}',c['attempt']):raise ValueError('Exact attempt required')
    if any(type(c[k]) is not int for k in ('createdUtcNs','deadlineUtcNs','floorMiB','reserveMiB')):
        raise ValueError('Integral original timing/resource contract required')
    here=Path(__file__).resolve().parent
    argv=c['resourceArgv']
    if len(argv)!=3 or argv[:2]!=['/usr/bin/node',str(here/'observe_resources.mjs')]:
        raise ValueError('Maintained authenticated resource observer required')
    protected_json(argv[2])
    required={str(here/'guarded_export.py'),str(here/'volume_export.py'),str(here/'observe_resources.mjs'),argv[2],'/usr/bin/node'}
    if not required.issubset(c['sourcePins']):raise ValueError('Complete runtime pins required')
    if c['bootId']!=Path('/proc/sys/kernel/random/boot_id').read_text().strip():raise ValueError('Wrong boot')
    if c['deadlineUtcNs']-c['createdUtcNs']!=900_000_000_000 or not c['createdUtcNs']<=time.time_ns()<c['deadlineUtcNs']:
        raise ValueError('Original 900-second startup window required')
    if c['floorMiB']<27648 or c['reserveMiB']<512:raise ValueError('Export floor/reserve weakened')
    if set(c['roles'])!={'l1','base'}:raise ValueError('Both state volumes required')
    for name,h in c['sourcePins'].items():
        if digest(name)!=h:raise ValueError('Source pin drift')
    unit_admission(c)
    deadline=time.monotonic()+(c['deadlineUtcNs']-time.time_ns())/1e9
    state=directory(c['stateParent'])/c['attempt'];state.mkdir(mode=0o700)
    # Independent unit envelope is valid before any owner/observer process exists.
    notify('READY=1\nSTATUS=Guardian armed; exports are not RPC readiness\nWATCHDOG=1')
    original_wall=time.time_ns();original_mono=time.monotonic();ready_hash=None;adoption_hash=None
    def watchdog():
        if abs((time.time_ns()-original_wall)/1e9-(time.monotonic()-original_mono))>2:
            raise ValueError('Clock relationship changed')
        notify('WATCHDOG=1')
    def record_ready(roles):
        nonlocal ready_hash
        if time.monotonic()>=deadline or set(roles)!={'l1','base'}:raise ValueError('Late/incomplete export readiness')
        value={'attempt':c['attempt'],'bootId':c['bootId'],'contractSha256':c['contractSha256'],'roles':roles,
               'rpcReady':False,'atUtcNs':time.time_ns()}
        with (state/'ready.json').open('x') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
        ready_hash=digest(state/'ready.json')
    def is_adopted():
        nonlocal adoption_hash
        if ready_hash is None:return False
        path=state/'adoption.json'
        if adoption_hash is None:
            adoption_hash=adoption(c,path,ready_hash,time.time_ns())
            return adoption_hash is not None
        # Successful adoption persists, but operator removal/modification stops the export.
        protected_json(path)
        return digest(path)==adoption_hash
    result=guard(lambda channel,d:export_owner(c,channel,d),c['resourceArgv'],deadline,c['floorMiB'],c['reserveMiB'],
                 watchdog,record_ready,is_adopted)
    with (state/'terminal.json').open('x') as f:json.dump(result,f);f.flush();os.fsync(f.fileno())
    return 2


if __name__=='__main__':
    raise SystemExit(main(sys.argv[1]))
