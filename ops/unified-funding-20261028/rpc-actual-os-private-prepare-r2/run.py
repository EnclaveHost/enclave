"""One admitted private OS derivative. No boot, publication, backend change, or finance."""
from pathlib import Path
import hashlib,json,os,fcntl,subprocess,signal,time,re
p=Path(__file__).resolve().parent
assert os.geteuid()==1000 and os.sched_getaffinity(0)=={1}
pins=json.loads((p/'INPUT-PINS.json').read_text())
def sha(path):
    with open(path,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def verify():
    for f,h in pins.items():assert sha(f)==h,f
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'scope':'actual OS private derivative only; no boot or publication'},f)
plan=json.loads((p/'PLAN-TEMPLATE.json').read_text())
cg=next(l[3:] for l in Path('/proc/self/cgroup').read_text().splitlines() if l.startswith('0::'))
assert re.fullmatch(r'/user.slice/user-1000.slice/user@1000.service/app.slice/run-[A-Za-z0-9-]+\.scope',cg),cg
cgdir=Path('/sys/fs/cgroup'+cg)
scope={'cgroup':cg,'memoryMax':(cgdir/'memory.max').read_text().strip(),'swapMax':(cgdir/'memory.swap.max').read_text().strip()}
assert scope['memoryMax']=='536870912' and scope['swapMax']=='0'
assert plan['resourceEnvelope']=={'cgroup':'BIND-TO-ADMITTED-512-MIB-SCOPE-AT-START','memoryMax':'536870912','swapMax':'0'}
plan['resourceEnvelope']=scope
encoded=json.dumps(plan,sort_keys=True).encode();pf=p/'PLAN.json'
with pf.open('xb') as f:f.write(encoded)
lock=plan['workflowLocks'][0];fd=os.open(lock['path'],os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
st=os.fstat(fd);assert(st.st_dev,st.st_ino)==(lock['device'],lock['inode'])
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
child=None
try:
    env={'PATH':'/usr/bin:/bin','HOME':'/home/steven','LANG':'C','PYTHONDONTWRITEBYTECODE':'1','XDG_RUNTIME_DIR':'/run/user/1000','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1000/bus'}
    args=['/usr/bin/python3','-I',plan['writerSource']['path'],'--plan',str(pf),'--plan-sha256',hashlib.sha256(encoded).hexdigest(),'--lock-fd',str(fd)]
    with (p/'writer.stdout').open('xb') as out,(p/'writer.stderr').open('xb') as err:
        child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=out,stderr=err,env=env,pass_fds=(fd,),start_new_session=True)
        (p/'PROCESS.json').write_text(json.dumps({'pid':child.pid,'startTicks':Path('/proc/'+str(child.pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]})+'\n')
        end=time.monotonic()+1650
        while child.poll() is None:
            if time.monotonic()>end or out.tell()+err.tell()>4<<20:raise RuntimeError('bounded writer time/output exceeded')
            time.sleep(.25)
        rc=child.returncode
    verify()
    result={'exit':rc,'resourceEnvelope':scope,'stdoutSha256':sha(p/'writer.stdout'),'stderrSha256':sha(p/'writer.stderr'),'writerGone':not Path('/proc/'+str(child.pid)).exists(),'sourceAndBackupWriteAuthorized':False,'published':False,'booted':False}
    try:
        value=json.loads((p/'writer.stdout').read_text());result['writerResult']=value
        if 'receipt' in value:
            receipt=Path(value['receipt']);r=json.loads(receipt.read_text());result.update(receiptPath=str(receipt),receiptSha256=sha(receipt),receiptStatus=r['status'],publishable=r['publishable'],derivative=r['evidence'].get('derivativeFinal'),operationsCompleted=len(r['operationsCompleted']))
            assert r['publishable'] is False and r['rpcReady'] is False
    except (ValueError,KeyError):result['outputUnclassified']=True
    (p/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
    raise SystemExit(rc)
finally:
    if child is not None and child.poll() is None:
        os.killpg(child.pid,signal.SIGTERM)
        try:child.wait(timeout=35)
        except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
    os.close(fd)
