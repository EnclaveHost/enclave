"""Finite real user-systemd watchdog qualification; dummy processes only.

Controller must run in the shared small lane with128MiB; actor has a separate
128MiB unit. Total256MiB commitment, both CPU1/noSwap. Not RPC admission.
"""
from pathlib import Path
import hashlib
import json
import os
import select
import signal
import socket
import subprocess
import sys
import time
import uuid


def start(pid):
    text=Path('/proc',str(pid),'stat').read_text()
    return text[text.rfind(')')+2:].split()[19]


def actor(directory):
    child=subprocess.Popen(['/usr/bin/python3','-I','-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    row={'pid':os.getpid(),'start':start(os.getpid()),'childPid':child.pid,'childStart':start(child.pid),
         'invocation':os.environ['INVOCATION_ID'],'cgroup':Path('/proc/self/cgroup').read_text().strip()}
    with (directory/'IDENTITY.json').open('x') as f:json.dump(row,f);f.flush();os.fsync(f.fileno())
    address=os.environ['NOTIFY_SOCKET']
    if address.startswith('@'):address='\0'+address[1:]
    with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as sock:
        sock.sendto(b'READY=1\nWATCHDOG=1',address)
        while True:
            time.sleep(.1);sock.sendto(b'WATCHDOG=1',address)


def command(args,seconds=3):
    r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=seconds)
    if len(r.stdout)+len(r.stderr)>32768:raise ValueError('Command output bound')
    if r.returncode:raise ValueError('Command failed: '+r.stderr[:2048])
    return r.stdout


def inspect(unit):
    keys='Id,LoadState,MainPID,ActiveState,SubState,InvocationID,ControlGroup,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec,WatchdogUSec,WatchdogSignal,WatchdogTimestampMonotonic,Result,ExecMainCode,ExecMainStatus,KillMode'
    return dict(line.split('=',1) for line in command(['/usr/bin/systemctl','--user','show',unit,'--property='+keys]).splitlines() if '=' in line)


def controller(directory):
    if os.sched_getaffinity(0)!={1}:raise ValueError('CPU1 required')
    directory.mkdir(mode=0o700)
    nonce=uuid.uuid4().hex;unit='enclave-rpc-watchdog-fixture-'+nonce+'.service'
    if inspect(unit)['LoadState']!='not-found':raise ValueError('Unit already exists')
    source=Path(__file__).resolve();pin=hashlib.sha256(source.read_bytes()).hexdigest()
    args=['/usr/bin/systemd-run','--user','--quiet','--unit='+unit,
          '--property=Type=notify','--property=NotifyAccess=main','--property=WatchdogSec=2','--property=WatchdogSignal=SIGKILL',
          '--property=KillMode=control-group','--property=Restart=no','--property=MemoryMax=128M','--property=MemorySwapMax=0',
          '--property=CPUQuota=100%','--property=TasksMax=8','--property=LimitCORE=0','--property=RuntimeMaxSec=12',
          '--property=TimeoutStartSec=3','--property=TimeoutStopSec=1','--property=UMask=0077','--property=NoNewPrivileges=yes',
          '/usr/bin/taskset','-c','1','/usr/bin/python3','-I','-B',str(source),'actor',str(directory)]
    invocation=None;mainfd=None;childfd=None;killfd=None;observed={}
    try:
        # --no-block keeps the actor's independent3s startup timeout authoritative.
        launch=args[:2]+['--no-block']+args[2:]
        (directory/'COMMAND.json').write_text(json.dumps({'unit':unit,'argv':launch},indent=2)+'\n')
        command(launch)
        until=time.monotonic()+4
        while not (directory/'IDENTITY.json').exists():
            if time.monotonic()>=until:raise TimeoutError('Actor identity deadline')
            time.sleep(.025)
        row=json.loads((directory/'IDENTITY.json').read_text());invocation=row['invocation']
        mainfd=os.pidfd_open(row['pid']);childfd=os.pidfd_open(row['childPid'])
        if start(row['pid'])!=row['start'] or start(row['childPid'])!=row['childStart']:raise ValueError('Process identity changed')
        p=inspect(unit)
        while p['ActiveState']=='activating' and time.monotonic()<until:
            time.sleep(.025);p=inspect(unit)
        if p['MainPID']!=str(row['pid']) or p['InvocationID']!=invocation or p['ActiveState']!='active':raise ValueError('Exact active actor mismatch')
        if p['WatchdogUSec']!='2s' or p['WatchdogSignal']!='9' or int(p['WatchdogTimestampMonotonic'])<=0 or p['KillMode']!='control-group':raise ValueError('Independent watchdog not armed')
        if p['MemoryMax']!=str(128<<20) or p['MemorySwapMax']!='0' or p['CPUQuotaPerSecUSec']!='1s':raise ValueError('Actor envelope mismatch')
        if row['cgroup']!='0::'+p['ControlGroup']:raise ValueError('Actor cgroup mismatch')
        child_group=Path('/proc',str(row['childPid']),'cgroup').read_text().strip()
        if child_group!=row['cgroup']:raise ValueError('Child escaped actor cgroup')
        cg=Path('/sys/fs/cgroup'+p['ControlGroup']);cg_identity=cg.stat()
        killfd=os.open(cg/'cgroup.kill',os.O_WRONLY|os.O_CLOEXEC)
        if select.select([mainfd,childfd],[],[],0)[0]:raise ValueError('Actor exited before freeze')
        stopped=time.monotonic();signal.pidfd_send_signal(mainfd,signal.SIGSTOP)
        deadline=stopped+6
        while True:
            done=select.select([mainfd,childfd],[],[],.05)[0]
            if len(done)==2:break
            if time.monotonic()>=deadline:raise TimeoutError('Watchdog failed to kill exact tree')
        elapsed=time.monotonic()-stopped
        after=inspect(unit)
        until=time.monotonic()+2
        while after['MainPID']!='0' and time.monotonic()<until:
            time.sleep(.025);after=inspect(unit)
        if after['MainPID']!='0' or after['Result']!='watchdog' or after['ExecMainStatus']!='9':raise ValueError('Not watchdog termination')
        if cg.exists():
            st=cg.stat()
            if (st.st_dev,st.st_ino)!=(cg_identity.st_dev,cg_identity.st_ino):raise ValueError('Cgroup replaced')
            if 'populated 0' not in (cg/'cgroup.events').read_text():raise ValueError('Actor descendants remain')
        if hashlib.sha256(source.read_bytes()).hexdigest()!=pin:raise ValueError('Source changed')
        observed={'unit':unit,'invocation':invocation,'sourceSha256':pin,'before':p,'after':after,
                  'exactMainAndChildPidfdsExited':True,'cgroupEmptyOrRemoved':True,'frozenGuardKilledWithinSeconds':elapsed,
                  'watchdogSeconds':2,'fallbackRuntimeSeconds':12,'dummyOnly':True,'productionExport':False,
                  'production384MiBEnvelopeQualified':False,'sourceSupervisorCompositionQualified':False}
        (directory/'RESULT.json').write_text(json.dumps(observed,indent=2)+'\n')
        print(json.dumps(observed),flush=True)
    finally:
        # This held cgroup.kill descriptor was opened only after exact incarnation
        # binding. It cannot target a replacement unit. No broad process scan/kill.
        if killfd is not None:
            try:os.write(killfd,b'1')
            except OSError:pass
            os.close(killfd)
        for fd in (mainfd,childfd):
            if fd is not None:os.close(fd)
    return observed


if __name__=='__main__':
    target=Path(sys.argv[2])
    if sys.argv[1]=='actor':actor(target)
    elif sys.argv[1]=='controller':controller(target)
    else:raise ValueError('Unknown fixture role')
