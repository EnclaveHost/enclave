"""Actual finite owner-entry unit/FD/user-namespace qualification using a stub.

No real signer, authority keys, network, exporter, image, VM or financial call.
Stub success is not consent. The blocked stub is killed by the actual20s unit.
Reserve1024MiB for wrapper/controller/actor/observer before invoking this fixture.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import select
import signal
import subprocess
import sys
import time
import uuid

SOURCE=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('owner_entry',SOURCE/'rpc/server/owner_entry.py')
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
c=e.clock_module()

STUB='''#!/usr/bin/python3
import fcntl,json,os,signal,stat,time
assert os.geteuid()==0
rows=[]
for fd in (3,4,5,6,7,8):
 s=os.fstat(fd);assert s.st_uid==0
 assert fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_ACCMODE==os.O_RDONLY
 rows.append([fd,stat.S_IMODE(s.st_mode),s.st_size])
assert len(os.pread(5,33,0))==32 and len(os.pread(6,33,0))==32
for name,n in [('memory.max',134217728),('memory.swap.max',0),('pids.max',32)]:
 group=open('/proc/self/cgroup').read().strip().split('::',1)[1]
 assert int(open('/sys/fs/cgroup'+group+'/'+name).read())==n
mode=json.load(open(0))['mode']
if mode=='block':
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 child=os.fork()
 if child==0:
  while True:time.sleep(1)
else:child=0
f=os.open('probe.json',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600,dir_fd=4)
os.write(f,json.dumps({'pid':os.getpid(),'child':child,'uid':os.geteuid(),'fds':rows,'mode':mode}).encode());os.fsync(f);os.close(f);os.fsync(4)
if mode=='block':
 while True:time.sleep(1)
print(json.dumps({'stub':True,'fdCount':len(rows),'uid':os.geteuid()}),flush=True)
'''


def write(path,value):return c.write_new(path,c.encode(value))


def inspect(unit):
    args=['/usr/bin/systemctl','--user','show',unit,'--property=LoadState,MainPID,InvocationID,ActiveState,Result,ExecMainStatus,ControlGroup,MemoryPeak','--no-pager']
    r=subprocess.run(args,capture_output=True,text=True,timeout=2,check=True)
    if len(r.stdout)>16384:raise ValueError('Observation bound')
    return dict(line.split('=',1) for line in r.stdout.splitlines())


def main(private,public,resource_config):
    os.umask(0o077);private.mkdir(mode=0o700);public.mkdir(mode=0o700)
    reader=SOURCE/'rpc/server/observe_resources.mjs'
    observed=subprocess.run(['/usr/bin/node',str(reader),str(resource_config)],capture_output=True,text=True,timeout=3,check=True)
    resource=json.loads(observed.stdout)
    if not resource['authenticated'] or resource['unreadUnits'] or resource['availableMiB']-resource['pendingMiB']-1024<max(27648,resource['floorMiB']):raise ValueError('Current full fixture admission refused')
    write(public/'ADMISSION.json',resource)
    results=[]
    for mode in ('normal','wrong-pin','block'):
        root=private/mode;root.mkdir(mode=0o700);attempt=uuid.uuid4().hex
        clocks=root/'clocks';clocks.mkdir(mode=0o700)
        begin=c.begin(clocks,attempt,'rpc-owned-fixture-'+attempt,uuid.uuid4().hex);b=json.loads(c.read_pinned(begin))
        sample=write(root/'synthetic-windows.json',{'schema':'owned-rpc-windows-clock/1','attempt':attempt,'vmAttempt':b['vmAttempt'],'windowsBoot':uuid.uuid4().hex,'monotonicMilliseconds':1000000000})
        clock=c.finish(begin,sample)
        contract=write(root/'contract.json',{'attempt':attempt,'startupClock':clock})
        policy=write(root/'policy.json',{'export':{'contractSha256':contract['sha256']}})
        journal=root/'journal';journal.mkdir(mode=0o700)
        seeds=[]
        for role in ('l1','base'):
            path=root/(role+'.seed');c.write_new(path,os.urandom(32));seeds.append(str(path))
        binary=root/'stub.py';c.write_new(binary,STUB.encode());binary.chmod(0o700)
        pins={str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in [SOURCE/'rpc/server/owner_entry.py',SOURCE/'rpc/startup_clock.py',SOURCE/'rpc/storage_protocol.py',Path('/usr/bin/bwrap'),Path('/usr/bin/python3')]}
        config={'schema':'enclave-rpc-owner-entry/1','attempt':attempt,'clock':clock,'contract':contract,'policy':policy,'journal':str(journal),'seeds':seeds,
            'binary':{'path':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest() if mode!='wrong-pin' else 'f'*64},'pins':pins,'receipt':str(root/'signer-started.json')}
        cb=write(root/'entry.json',config);request=root/'request.json';write(request,{'mode':mode})
        unit='enclave-rpc-owner-sign-'+attempt+'.service'
        if inspect(unit)['LoadState']!='not-found':raise ValueError('Fixture unit already consumed')
        props=['Type=exec','RuntimeMaxSec=20','TimeoutStopSec=1','MemoryMax=128M','MemorySwapMax=0','CPUQuota=100%',
            'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077',
            'StandardInput=file:'+str(request),'StandardOutput=file:'+str(root/'stdout'),'StandardError=file:'+str(root/'stderr')]
        args=['/usr/bin/systemd-run','--user','--quiet','--no-block','--unit='+unit,*['--property='+x for x in props],'/usr/bin/python3','-B',str(SOURCE/'rpc/server/owner_entry.py'),cb['path']]
        write(public/(mode+'-intent.json'),{'unit':unit,'argv':args,'stubOnly':True,'clock':clock['sha256']})
        started=time.monotonic();subprocess.run(args,check=True,timeout=3)
        fds=[];group=None;final=None
        try:
            until=started+8
            while True:
                row=inspect(unit)
                if row.get('ControlGroup'):group=row['ControlGroup']
                if mode=='wrong-pin' and row['ActiveState'] in ('failed','inactive'):break
                if (journal/'probe.json').exists():break
                if row['ActiveState']=='failed' or time.monotonic()>=until:raise ValueError('Stub did not reach required bootstrap stage: '+(root/'stderr').read_text()[:1000])
                time.sleep(.025)
            if mode=='wrong-pin':
                if (journal/'probe.json').exists() or row['ExecMainStatus']=='0':raise ValueError('Changed binary executed')
            else:
                probe=json.loads((journal/'probe.json').read_bytes())
                if probe['uid']!=0 or len(probe['fds'])!=6:raise ValueError('Actual namespace/FD mapping failed')
                if mode=='normal':
                    while row['ActiveState'] not in ('failed','inactive'):
                        if time.monotonic()>=until:raise TimeoutError('Normal stub did not finish')
                        time.sleep(.025);row=inspect(unit)
                    if row['ExecMainStatus']!='0' or json.loads((root/'stdout').read_bytes())!={'stub':True,'fdCount':6,'uid':0}:raise ValueError('Stub failed')
                else:
                    receipt=json.loads((root/'signer-started.json').read_bytes());main=int(receipt['unit']['MainPID'])
                    pids=(main,probe['pid'],probe['child'])
                    if len(set(pids))!=3:raise ValueError('Expected three distinct held processes')
                    identities=[]
                    for pid in pids:
                        def identity():
                            text=Path('/proc/'+str(pid)+'/stat').read_text();start=text[text.rfind(')')+2:].split()[19]
                            cg=Path('/proc/'+str(pid)+'/cgroup').read_text().strip()
                            if cg!='0::'+receipt['unit']['ControlGroup']:raise ValueError('Exact actor group differs')
                            return {'pid':pid,'start':start,'cgroup':cg}
                        before=identity();fds.append(os.pidfd_open(pid,0))
                        if identity()!=before:raise ValueError('Held process changed')
                        identities.append(before)
                    poll=select.poll()
                    for fd in fds:poll.register(fd,select.POLLIN)
                    if poll.poll(0):raise ValueError('Fixture process already dead')
                    # Stop ALL held processes, so no Python/Go timer can help.
                    for fd in fds:signal.pidfd_send_signal(fd,signal.SIGSTOP)
                    dead=set()
                    while len(dead)!=len(fds):
                        if time.monotonic()>started+24:raise TimeoutError('Independent20s unit failed to terminate held tree')
                        dead.update(fd for fd,_ in poll.poll(100))
                    row=inspect(unit)
                    if row['Result']!='timeout':raise ValueError('Expected independent runtime timeout')
            final=inspect(unit)
            if group:
                path=Path('/sys/fs/cgroup'+group+'/cgroup.procs')
                while path.exists() and path.read_text().strip():
                    if time.monotonic()>=started+24:raise ValueError('Actor cgroup is not empty')
                    time.sleep(.025)
                final=inspect(unit)
            receipt=json.loads((root/'signer-started.json').read_bytes())
            results.append({'mode':mode,'elapsed':time.monotonic()-started,'unit':unit,'state':final,'pass':True,'exactHeldProcesses':len(fds),'invocation':receipt['unit']['InvocationID'],'heldIdentities':identities if mode=='block' else []})
        finally:
            for fd in fds:os.close(fd)
            # No retry or claimed cleanup on failure: actual20s unit remains the
            # backstop and the next operator must inspect this exact unit.
    write(public/'RESULT.json',{'cases':results,'stubOnly':True,'productionAdmitted':False})
    print(json.dumps({'cases':len(results),'pass':True,'stubOnly':True}),flush=True)


if __name__=='__main__':
    raise SystemExit('Historical stub fixture retired: use qualify_owner_composition.py with required owner provisioning; prior evidence is preserved in ops/rpc-owner-entry-native-r1/r2')
