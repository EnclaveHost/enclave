from pathlib import Path
import os,json,subprocess,select,time
p=Path(__file__).resolve().parent
u=p.parent
attempt='8ee4452b174746c2b606b9b68f0fa623'
unit='enclave-rpc-export-'+attempt+'.service'
startup=u/'rpc-production-launch-r1/private/clocks'/attempt/'startup'
assert json.loads((startup/'HELD.json').read_text())['phase']=='define'
assert not any('copy' in f.name or 'boot' in f.name or 'guest' in f.name or 'endpoint' in f.name for f in startup.glob('*.intent.json'))
def show():
 r=subprocess.check_output(['systemctl','--user','show',unit,'-p','MainPID','-p','InvocationID','-p','ActiveState','-p','ControlGroup','-p','KillMode','-p','Result'],text=True)
 return dict(l.split('=',1) for l in r.splitlines())
a=show();assert a['MainPID']=='120163' and a['InvocationID']=='a7546105a12443b2a7da520d7da1a65f' and a['ActiveState']=='active' and a['KillMode']=='control-group'
c=Path('/sys/fs/cgroup'+a['ControlGroup']); ids=[int(x) for x in (c/'cgroup.procs').read_text().split()];assert len(ids)==4 and 120163 in ids
fds=[];receipts=[]
for pid in ids:
 fd=os.pidfd_open(pid);fds.append(fd)
 raw=Path('/proc/'+str(pid)+'/stat').read_text();start=raw.rsplit(')',1)[1].split()[19]
 assert a['ControlGroup'] in Path('/proc/'+str(pid)+'/cgroup').read_text()
 receipts.append({'pid':pid,'startTicks':start})
assert sorted(ids)==sorted(int(x) for x in (c/'cgroup.procs').read_text().split()) and show()==a
with (p/'STOP-INTENT.json').open('x') as f:json.dump({'unit':unit,'before':a,'exactProcesses':receipts,'noGuestSubmitted':True,'reservationMayRelease':False},f);f.flush();os.fsync(f.fileno())
t=time.monotonic();subprocess.run(['systemctl','--user','stop',unit],check=True,timeout=10)
poll=select.poll()
for fd in fds:poll.register(fd,select.POLLIN)
dead=set()
while time.monotonic()-t<12 and len(dead)<len(fds):
 for fd,event in poll.poll(100):
  if event & select.POLLIN:dead.add(fd)
b=show();empty=not c.exists() or not (c/'cgroup.procs').read_text().strip()
r={'unit':unit,'before':a,'after':b,'exactProcesses':receipts,'allPreheldPidfdsSignalled':len(dead)==len(fds),'cgroupEmptyOrRemoved':empty,'elapsedSeconds':time.monotonic()-t,'reservationMayRelease':False,'rpcReady':False,'overlaysRetained':True}
(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n')
assert r['allPreheldPidfdsSignalled'] and empty and b['MainPID']=='0'
for fd in fds:os.close(fd)
print(json.dumps(r))
