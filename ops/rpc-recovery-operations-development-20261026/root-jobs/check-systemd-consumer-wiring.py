#!/usr/bin/env python3
"""Bounded real systemd check of consumer dependency semantics; only uniquely named sleep canaries. No production unit changes."""
import json, os, pathlib, subprocess, time
assert os.geteuid()==0
prefix=f'enclave-rpc-wiring-canary-{os.getpid()}'
holder=prefix+'-holder.service'; consumer=prefix+'-consumer.service'
base=pathlib.Path('/run/systemd/system'); ready=pathlib.Path('/run/'+prefix+'.ready')
paths=[base/holder,base/consumer]
assert not ready.exists() and all(not p.exists() for p in paths)
protected=['enclave-rpc-base-snapshot.service','enclave-l1-el.service','enclave-l1-cl.service']
checks=[]
def ctl(*args,check=True):
    return subprocess.run(['systemctl',*args],text=True,capture_output=True,timeout=30,check=check)
def props(unit):
    return dict(x.split('=',1) for x in ctl('show',unit,'-p','ActiveState','-p','MainPID').stdout.splitlines() if '=' in x)
before={u:props(u) for u in protected}
def require(value,name):
    assert value,name
    checks.append(name)
error=None
try:
    paths[0].write_text('[Unit]\nDescription=Temporary RPC wiring test holder\n[Service]\nType=simple\nExecStart=/bin/sleep 120\n')
    paths[1].write_text(f'[Unit]\nDescription=Temporary RPC wiring test consumer\nRequisite={holder}\nAfter={holder}\nPartOf={holder}\n[Service]\nType=simple\nExecCondition=/usr/bin/test -f {ready}\nExecStart=/bin/sleep 120\n')
    ctl('daemon-reload')
    ctl('start',consumer,check=False)
    require(props(holder)['MainPID']=='0','consumer does not start inactive holder')
    require(props(consumer)['MainPID']=='0','consumer refuses absent holder')
    ctl('start',holder)
    ctl('start',consumer,check=False)
    require(props(consumer)['MainPID']=='0','ExecCondition refuses unready holder')
    ready.touch(mode=0o600)
    ctl('start',consumer)
    require(props(consumer)['ActiveState']=='active','ready consumer starts with existing holder')
    pid=props(holder)['MainPID']; st=pathlib.Path('/proc',pid,'stat').read_text().rsplit(')',1)[1].split()[19]
    require(pid.isdigit() and int(pid)>1 and st.isdigit(),'live MainPID and proc start time observable')
    ready.unlink()
    ctl('restart',holder)
    require(props(holder)['MainPID']!=pid,'holder restart changes process')
    require(props(consumer)['MainPID']=='0','PartOf restart applies ExecCondition and refuses stale readiness')
    ready.touch(mode=0o600);ctl('start',consumer);ctl('stop',holder)
    require(props(consumer)['MainPID']=='0','PartOf explicit stop stops consumer')
except Exception as e:
    error=f'{type(e).__name__}: {e}'
finally:
    for u in (consumer,holder):ctl('stop',u,check=False)
    ready.unlink(missing_ok=True)
    for p in paths:p.unlink(missing_ok=True)
    ctl('daemon-reload');ctl('reset-failed',consumer,holder,check=False)
after={u:props(u) for u in protected}
clean=all(not p.exists() for p in paths) and not ready.exists()
print(json.dumps({'ok':error is None and before==after and clean,'checks':checks,'error':error,'protectedBefore':before,'protectedAfter':after,'canaryFilesRemoved':clean},indent=2))
raise SystemExit(0 if error is None and before==after and clean else 1)
