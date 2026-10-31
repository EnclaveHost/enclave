#!/usr/bin/env python3
"""Own one authenticated NBD attachment in an independently bounded guest unit.

Static systemd mount units mount only after READY. No reconnect or foreign-device
cleanup. Operator adoption is a separate protected receipt, never produced here.
"""
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import time

ROOT=Path('/opt/enclave-rpc')
ROLES={
    'l1':{'device':'nbd6','uuid':'a2f2a8b5-06ac-4612-95a0-f48a00a7f6e0','mount':'/srv/enclave-l1-pair',
          'owners':{'data':(997,987),'tmp':(997,987),'cl':(995,986),'tmp-cl':(995,986)}},
    'base':{'device':'nbd7','uuid':'11c6bbac-f823-4052-a87a-066eed6ad590','mount':'/srv/enclave-base-holder',
            'owners':{'data':(994,985),'tmp':(994,985)}}}
BYTES=4000000000000
STOP=False
OPERATION_DEADLINE=None


def protected(path, mode=None):
    st=path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or st.st_mode&0o022:
        raise ValueError('Protected root file required')
    if mode is not None and stat.S_IMODE(st.st_mode)!=mode:raise ValueError('Unexpected protected file mode')
    return st


def validate_config(c, role, now_ns, boot):
    if role not in ROLES or set(c)!={'schema','instance','bootId','attempt','createdUtcNs','deadlineUtcNs','roles'}:
        raise ValueError('Exact attachment contract required')
    if c['schema']!='owned-rpc-attachment/1' or c['bootId']!=boot or not re.fullmatch('[0-9a-f]{32}',c['attempt']):
        raise ValueError('Attachment identity mismatch')
    if not re.fullmatch(r'rpc-owned-[a-z0-9-]{8,64}',c['instance']):raise ValueError('Invalid instance')
    if any(type(c[k]) is not int for k in ['createdUtcNs','deadlineUtcNs']):raise ValueError('Integral original times required')
    if c['createdUtcNs']<0 or c['deadlineUtcNs']-c['createdUtcNs']!=900_000_000_000 or not c['createdUtcNs']<=now_ns<c['deadlineUtcNs']:
        raise ValueError('Original startup window invalid or expired')
    if set(c['roles'])!=set(ROLES):raise ValueError('Both state roles required')
    exports=set()
    for name,row in c['roles'].items():
        if set(row)!={'host','port','tlsName','export','bytes','uuid','caSha256','certificateSha256','serverReceiptSha256'}:
            raise ValueError('Exact endpoint fields required')
        ip=ipaddress.ip_address(row['host'])
        if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip.is_link_local:
            raise ValueError('Explicit unicast storage address required')
        if type(row['port']) is not int or not 1024<=row['port']<=65535:raise ValueError('Invalid storage port')
        if row['bytes']!=BYTES or type(row['bytes']) is not int or row['uuid']!=ROLES[name]['uuid']:
            raise ValueError('Volume identity mismatch')
        if not re.fullmatch(r'rpc-storage-[a-z0-9-]{8,80}',row['tlsName']):raise ValueError('Explicit server TLS name required')
        if row['export']!=f"rpc-{c['attempt']}-{name}":raise ValueError('Export not bound to this attempt')
        endpoint=(row['host'],row['port'],row['export'])
        if endpoint in exports:raise ValueError('Shared role export')
        exports.add(endpoint)
        for field in ['caSha256','certificateSha256','serverReceiptSha256']:
            if not re.fullmatch('[0-9a-f]{64}',row[field]):raise ValueError('Pinned public credential/receipt required')
    return c['roles'][role]


def mounts(number):
    # Device use is global; inspect distinct mount namespaces before disconnect.
    found=[];seen=set();deadline=time.monotonic()+3;count=0
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        count+=1
        if count>512 or time.monotonic()>=deadline:raise ValueError('Mount census bound')
        try:
            ns=(p/'ns/mnt').stat().st_ino
            if ns in seen:continue
            data=(p/'mountinfo').read_text()
            if len(data)>1024**2:raise ValueError('Mount table bound')
            seen.add(ns)
        except FileNotFoundError:continue
        for line in data.splitlines():
            cols=line.split()
            if cols[2]==number:found.append({'namespace':ns,'target':cols[4]})
    return found


def pid_start(pid):
    try:
        text=Path('/proc',str(pid),'stat').read_text()
        return text[text.rfind(')')+2:].split()[19]
    except FileNotFoundError:return None


def validate_owner(pid, size, expected_pid, expected_start, current_start, current_group, expected_group, child_exit):
    if (child_exit is not None or not expected_start or pid!=str(expected_pid)
            or current_start!=expected_start or current_group!=expected_group or size!=BYTES):
        raise RuntimeError('Owned attachment lost or replaced')


def run(argv, seconds=5):
    if OPERATION_DEADLINE is not None:
        seconds=min(seconds,(OPERATION_DEADLINE-time.monotonic_ns())/1e9)
        if seconds<=0 or STOP:raise RuntimeError('Original attachment preparation deadline')
    r=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                     env={'PATH':'/usr/sbin:/usr/bin:/bin','LANG':'C'},timeout=seconds,text=True)
    if r.returncode or len(r.stdout)+len(r.stderr)>65536:
        raise RuntimeError('Bounded storage operation failed: '+argv[0]+':'+str(r.returncode))
    return r.stdout.strip()


def write_new(path,value):
    with path.open('x') as f:
        json.dump(value,f,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())
    fd=os.open(path.parent,os.O_DIRECTORY|os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)


def adopted(path, c, contract_sha, ready_sha, now_ns):
    if not path.exists():return False
    protected(path,mode=0o600);a=json.loads(path.read_text())
    if set(a)!={'attempt','bootId','contractSha256','readySha256','adoptedUtcNs'}:
        raise ValueError('Exact operator adoption required')
    if (a['attempt'],a['bootId'],a['contractSha256'],a['readySha256'])!=(c['attempt'],c['bootId'],contract_sha,ready_sha):
        raise ValueError('Foreign operator adoption')
    at=a['adoptedUtcNs']
    if type(at) is not int or not c['createdUtcNs']<=at<c['deadlineUtcNs'] or at>now_ns:
        raise ValueError('Late or future adoption')
    return True


def main(role):
    global OPERATION_DEADLINE
    if os.geteuid()!=0:raise ValueError('Guest root required')
    spec=importlib.util.spec_from_file_location('identity',ROOT/'identity.py');identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
    identity_path=Path('/etc/enclave-rpc/identity.json');protected(identity_path,mode=0o644)
    identity_config=json.loads(identity_path.read_text());identity.check_context(identity_config)
    path=Path('/etc/enclave-rpc/attachment.json');protected(path,mode=0o600)
    raw=path.read_bytes();c=json.loads(raw);contract_sha=hashlib.sha256(raw).hexdigest()
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();wall=time.time_ns();mono=time.monotonic_ns()
    row=validate_config(c,role,wall,boot)
    if identity_config['instance']!=c['instance']:raise ValueError('Contract belongs to another guest')
    local_deadline=mono+(c['deadlineUtcNs']-wall)
    OPERATION_DEADLINE=local_deadline
    credential=Path('/etc/enclave-rpc/storage')/c['attempt']/role
    for parent in [credential.parent.parent,credential.parent,credential]:
        st=parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o700:raise ValueError('Private credential directory required')
    for name,pin in [('ca-cert.pem','caSha256'),('client-cert.pem','certificateSha256'),('server-ready.json','serverReceiptSha256')]:
        p=credential/name;protected(p,mode=0o600)
        if hashlib.sha256(p.read_bytes()).hexdigest()!=row[pin]:raise ValueError('Public storage binding changed')
    protected(credential/'client-key.pem',mode=0o600)
    receipt=json.loads((credential/'server-ready.json').read_text())
    if (receipt.get('attempt'),receipt.get('export'),receipt.get('uuid'),receipt.get('bytes'))!=(c['attempt'],row['export'],row['uuid'],BYTES):
        raise ValueError('Server receipt not bound to this state')
    if receipt.get('exclusiveCow') is not True or receipt.get('originalsReadOnly') is not True:
        raise ValueError('Operator-reviewed exclusive COW receipt required')
    # Receipt arrives through the authenticated operator channel; booleans alone
    # do not independently establish server exclusivity or writer fencing.
    storage_spec=importlib.util.spec_from_file_location('storage_install',ROOT/'install_storage_client.py')
    storage=importlib.util.module_from_spec(storage_spec);storage_spec.loader.exec_module(storage);storage.install()
    root=Path('/run/enclave-rpc-attachment');root.mkdir(mode=0o700,exist_ok=True)
    st=root.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o700:raise ValueError('Private runtime root required')
    lock=(root/(role+'.lock')).open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    state=root/(c['attempt']+'-'+role);state.mkdir(mode=0o700) # consumed attempt, never restart
    with (root/'module.lock').open('a') as module_lock:
        fcntl.flock(module_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if not Path('/sys/module/nbd').exists():run(['/usr/sbin/modprobe','nbd','nbds_max=8','max_part=0'],5)
    device=Path('/dev')/ROLES[role]['device'];sysdev=Path('/sys/block')/device.name
    if not device.is_block_device():raise ValueError('Expected preloaded NBD device absent')
    number=f'{os.major(device.stat().st_rdev)}:{os.minor(device.stat().st_rdev)}'
    def status():
        pid=(sysdev/'pid').read_text().strip() if (sysdev/'pid').exists() else ''
        return pid if pid not in ('','0') else None,int((sysdev/'size').read_text())*512
    if status()!=(None,0) or list((sysdev/'holders').iterdir()) or mounts(number):raise ValueError('Reserved NBD device is already in use')
    ours=Path('/proc/self/cgroup').read_text();invocation=os.environ.get('INVOCATION_ID')
    if not invocation or not ours.strip().endswith('/enclave-rpc-attach-'+role+'.service'):raise ValueError('Exact attachment unit required')
    lib=ROOT/'nbd/lib';client=[str(lib/'ld-linux-x86-64.so.2'),'--inhibit-cache','--library-path',str(lib),str(ROOT/'nbd/nbd-client')]
    argv=client+['-n','-L','-x','-A',str(credential/'ca-cert.pem'),'-H',row['tlsName'],'-F',str(credential/'client-cert.pem'),'-K',str(credential/'client-key.pem'),'-N',row['export'],'-t','10','-b','4096',row['host'],str(row['port']),str(device)]
    write_new(state/'intent.json',{'attempt':c['attempt'],'bootId':boot,'contractSha256':contract_sha,'device':number,'unitInvocation':invocation,'deadlineUtcNs':c['deadlineUtcNs']})
    child=None;owner=None;owner_start=None;preflight=state/'preflight';preflight.mkdir();preflight_mounted=False;ready_sha=None;failure=None
    def stop(signum,frame):
        global STOP
        STOP=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:
        with (state/'client.txt').open('xb') as log:
            child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=log,stderr=log,env={'PATH':'/usr/bin:/bin','LANG':'C'})
            until=min(time.monotonic_ns()+10_000_000_000,local_deadline)
            while time.monotonic_ns()<until and not STOP:
                pid,size=status()
                if child.poll() is not None:raise RuntimeError('Authenticated attachment exited')
                if pid and size==BYTES:
                    if Path('/proc',pid,'cgroup').read_text()!=ours:raise ValueError('Foreign NBD owner')
                    owner=int(pid);owner_start=pid_start(owner);break
                time.sleep(.05)
            if owner is None:raise RuntimeError('Attachment deadline')
            if run(['/usr/sbin/blkid','-p','-s','UUID','-o','value',str(device)])!=row['uuid']:raise ValueError('Attached filesystem UUID differs')
            if run(['/usr/sbin/blkid','-p','-s','TYPE','-o','value',str(device)])!='ext4':raise ValueError('Expected ext4 state')
            run(['/usr/bin/mount','-t','ext4','-o','ro,noload,nosuid,nodev,noexec',str(device),str(preflight)],8);preflight_mounted=True
            for name,pair in ROLES[role]['owners'].items():
                q=preflight/name;st=q.lstat()
                if not stat.S_ISDIR(st.st_mode) or (st.st_uid,st.st_gid)!=pair or st.st_mode&0o022:raise ValueError('Unexpected state ownership')
            run(['/usr/bin/umount',str(preflight)],8);preflight_mounted=False
            if time.monotonic_ns()>=local_deadline or STOP:raise RuntimeError('Preparation expired before ready')
            pid,size=status()
            validate_owner(pid,size,owner,owner_start,pid_start(owner),Path('/proc',str(owner),'cgroup').read_text(),ours,child.poll())
            write_new(state/'ready.json',{'attempt':c['attempt'],'bootId':boot,'contractSha256':contract_sha,'device':number,'ownerPid':owner,'ownerStart':owner_start,'uuid':row['uuid'],'bytes':BYTES,'unitInvocation':invocation,'mountReady':True,'rpcReady':False})
            ready_sha=hashlib.sha256((state/'ready.json').read_bytes()).hexdigest()
            notify=os.environ['NOTIFY_SOCKET'];notify='\0'+notify[1:] if notify.startswith('@') else notify
            with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as sock:sock.sendto(b'READY=1',notify)
            adoption_sha=None
            while not STOP:
                now=time.time_ns();elapsed=time.monotonic_ns()-mono
                if abs(now-wall-elapsed)>2_000_000_000:raise RuntimeError('Guest clock changed')
                adoption=state/'adoption.json'
                if time.monotonic_ns()<local_deadline and adoption_sha is None:
                    if adopted(adoption,c,contract_sha,ready_sha,now):adoption_sha=hashlib.sha256(adoption.read_bytes()).hexdigest()
                if time.monotonic_ns()>=local_deadline and adoption_sha is None:raise RuntimeError('Original startup deadline without timely observed operator adoption')
                if adoption_sha is not None and (not adoption.exists() or hashlib.sha256(adoption.read_bytes()).hexdigest()!=adoption_sha):raise RuntimeError('Operator adoption changed')
                pid,size=status()
                validate_owner(pid,size,owner,owner_start,pid_start(owner),Path('/proc',str(owner),'cgroup').read_text(),ours,child.poll())
                if (state/'client.txt').stat().st_size>1024**2:raise RuntimeError('Attachment diagnostic bound')
                time.sleep(.1)
    except BaseException as error:
        failure=type(error).__name__+':'+str(error)
        raise
    finally:
        OPERATION_DEADLINE=None
        cleanup={'failure':failure,'deviceDisconnected':False,'writersFenced':False}
        try:
            if preflight_mounted:run(['/usr/bin/umount',str(preflight)],8)
            if mounts(number):raise RuntimeError('Mounted device retained; no forced detach')
            pid,size=status()
            if pid or size:
                if not pid or Path('/proc',pid,'cgroup').read_text()!=ours or (owner and (pid!=str(owner) or pid_start(owner)!=owner_start)):
                    raise RuntimeError('Ambiguous device owner; no disconnect')
                if list((sysdev/'holders').iterdir()):raise RuntimeError('Device holder retained')
                run(client+['-d',str(device)],5)
            until=time.monotonic()+3
            while status()!=(None,0) and time.monotonic()<until:time.sleep(.05)
            cleanup['deviceDisconnected']=status()==(None,0)
            if child is not None:
                try:child.wait(timeout=3)
                except subprocess.TimeoutExpired:raise RuntimeError('Client did not exit after disconnect')
        except BaseException as error:cleanup['cleanupError']=type(error).__name__+':'+str(error)
        write_new(state/'cleanup.json',cleanup)
        if 'cleanupError' in cleanup or not cleanup['deviceDisconnected']:raise RuntimeError('Attachment cleanup incomplete; reservation remains held')

if __name__=='__main__':main(sys.argv[1])
