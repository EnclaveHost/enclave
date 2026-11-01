"""Inert interoperability actor for Go BrokerSession; no exports or real keys.

Run only within the bounded private qualification PID/network/mount namespace.
Uses maintained AppControl and guard with an intentionally blocked worker tree.
The real systemd exporter/backstop is separately qualified; this is not it.
"""
import json
import os
from pathlib import Path
import signal
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'rpc/server'))
from app_control import AppControl
from guarded_export import guard

root=Path(sys.argv[1]);cfg=json.loads((root/'actor.json').read_text())
os.umask(0o077)
control=AppControl(cfg['control'],cfg['contract'],cfg['deadline'])
(root/'listening').write_text('inert fixture; not export readiness')

def identity(pid):
    raw=Path('/proc',str(pid),'stat').read_text()
    return {'pid':pid,'start':raw[raw.rfind(')')+2:].split()[19]}

def worker(channel,deadline):
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    child=os.fork()
    if child==0:
        while True:time.sleep(.05)
    temporary=root/'workers.tmp'
    temporary.write_text(json.dumps([identity(os.getpid()),identity(child)]))
    temporary.rename(root/'workers.json')
    while True:time.sleep(.05)

resources={'authenticated':True,'availableMiB':40000,'pendingMiB':1000,'floorMiB':27648,'unreadUnits':0}
command=[sys.executable,'-c','print('+repr(json.dumps(resources))+',flush=True)']
try:
    result=guard(worker,command,cfg['deadline'],27648,512,lambda:None,lambda _:None,lambda:False,app_control=control)
    (root/'result.json').write_text(json.dumps(result))
finally:control.close()
