"""Inert composition: actual AppControl/guard/export_owner, dummy QEMU children.
Only test fixtures call this. Never opens or exports a data volume.
"""
import json,os,signal,subprocess,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'rpc/server'))
import app_control as ac
import guarded_export as g

def start(pid):
    raw=Path('/proc',str(pid),'stat').read_text();return raw[raw.rfind(')')+2:].split()[19]
def identity(pid):return {'pid':pid,'start':start(pid)}
config=json.loads(Path(sys.argv[1]).read_text());deadline=time.monotonic()+1
control=ac.AppControl(config['control'],config['contract'],deadline)
print('LISTEN',flush=True)
class Dummy:
    def __init__(self,*args):
        self.proc=subprocess.Popen(['/usr/bin/sleep','60'])
        self.deadline=args[-1];self.originals=[]
    def start(self):pass
    def check(self):
        if time.monotonic()>=self.deadline:raise ValueError('dummy startup expired')
    def close(self):
        if self.proc.poll() is None:self.proc.terminate()
        self.proc.wait(timeout=1)
g.CowExport=Dummy
g.probe_export=lambda instance,row:{'worker':identity(os.getpid()),'child':identity(instance.proc.pid)}
roles={role:{'parent':'/run','originals':[],'bytes':4096,'tls':'/run','host':'127.0.0.1','port':1} for role in ('l1','base')}
c={'attempt':'a'*32,'roles':roles,'appControl':config['control']}
def worker(channel,d):
    if config['mode']=='worker-blocked':
        signal.signal(signal.SIGTERM,signal.SIG_IGN)
        children=[subprocess.Popen(['/usr/bin/sleep','60']) for _ in range(2)]
        channel.send(b'READY '+json.dumps({role:{'worker':identity(os.getpid()),'child':identity(child.pid)} for role,child in zip(('l1','base'),children)}).encode())
        while True:time.sleep(.1)
    else:g.export_owner(c,channel,d)
resource={'authenticated':True,'availableMiB':40000,'pendingMiB':1000,'floorMiB':27648,'unreadUnits':0}
argv=[sys.executable,'-B','-c','print('+repr(json.dumps(resource))+',flush=True)']
try:
    result=g.guard(worker,argv,deadline,27648,512,lambda:None,lambda rows:print('READY '+json.dumps(rows),flush=True),lambda:False,app_control=control)
    print('RESULT '+json.dumps(result),flush=True)
finally:control.close()
