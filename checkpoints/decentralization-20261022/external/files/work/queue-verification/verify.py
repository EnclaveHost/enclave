from pathlib import Path
import subprocess,time,signal,json,os
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo/work'); D=ROOT/'queue-verification'
results=[]
def clone(source,label):
 s=(ROOT/source).read_text().replace('ROOT = Path(__file__).resolve().parent','ROOT = Path('+repr(str(ROOT))+')')
 s=s.replace('"claude-test-queue.lock"',repr('queue-verification/'+label+'-main.lock')).replace('"claude-test-small-queue.lock"',repr('queue-verification/'+label+'-small.lock'))
 p=D/(label+'.py');p.write_text(s);return p
def start(script,label,cap,seconds,code):
 marker=D/(label+'.marker.json');log=D/(label+'.out')
 body="import pathlib,json,time; p=pathlib.Path('/sys/fs/cgroup'+pathlib.Path('/proc/self/cgroup').read_text().strip().split(':',2)[2]); pathlib.Path("+repr(str(marker))+").write_text(json.dumps({'memoryMax':(p/'memory.max').read_text().strip(),'swapMax':(p/'memory.swap.max').read_text().strip(),'at':time.time()})); time.sleep("+str(seconds)+"); raise SystemExit("+str(code)+")"
 out=log.open('w');p=subprocess.Popen(['python3',str(script),'--mib',str(cap),'--log',str(D/(label+'.guard.log')),'--','python3','-c',body],stdout=out,stderr=subprocess.STDOUT)
 return p,out,marker,log
def ready(p,m):
 end=time.monotonic()+65
 while not m.exists():
  if p.poll() is not None:raise RuntimeError('not started exit '+str(p.returncode))
  if time.monotonic()>end:raise RuntimeError('not started timeout')
  time.sleep(.05)
old=clone('claude-test-queue-before-signal-fix.py','old');new=clone('claude-test-queue.py','new')
for label,script,expect_hang in [('old-signal',old,True),('new-signal',new,False)]:
 p,out,m,l=start(script,label,256,30,0);ready(p,m);time.sleep(.2);p.send_signal(signal.SIGTERM)
 try:rc=p.wait(timeout=4);hung=False
 except subprocess.TimeoutExpired:
  hung=True;wchan=Path(f'/proc/{p.pid}/wchan').read_text();p.kill();rc=p.wait(timeout=3)
 out.close();assert hung==expect_hang,(label,hung,rc,l.read_text())
 if not hung:assert rc==143,(label,rc)
 r={'case':label,'hung':hung,'exit':rc,'limits':json.loads(m.read_text())}
 if hung:r['wchan']=wchan
 results.append(r)
small,so,sm,sl=start(new,'small',256,5,7);ready(small,sm)
large,lo,lm,ll=start(new,'large',512,.8,3);ready(large,lm)
assert small.poll() is None,'small ended before large started'
other,oo,om,ol=start(new,'second-small',256,0,0)
rc3=other.wait(timeout=5);oo.close();assert rc3==98 and not om.exists(),(rc3,ol.read_text())
rc2=large.wait(timeout=5);lo.close();rc1=small.wait(timeout=8);so.close()
assert (rc1,rc2)==(7,3),(rc1,rc2)
for m,cap in [(sm,256),(lm,512)]:
 d=json.loads(m.read_text());assert d['memoryMax']==str(cap*1024*1024) and d['swapMax']=='0',d
assert 'concurrentSmall=256MiB' in ll.read_text(),ll.read_text()
results.append({'case':'overlap-and-exit','smallExit':rc1,'largeExit':rc2,'secondSmallExit':rc3,'small':json.loads(sm.read_text()),'large':json.loads(lm.read_text()),'largerReservedFullSmallCap':True})
(D/'result.json').write_text(json.dumps({'result':'pass','cases':results},indent=2)+'\n');print(json.dumps({'result':'pass','cases':results}))
