"""Finite user-systemd BindsTo/After qualification with inert dummy processes.

Controller128 + owner32 + two children32 + late child32 <=256MiB total.
Every unit CPU1/noSwap/finite runtime. No guest/kernel NBD or production work.
"""
from pathlib import Path
import hashlib,json,os,select,signal,socket,subprocess,sys,time,uuid

def start(pid):
 text=Path('/proc',str(pid),'stat').read_text();return text[text.rfind(')')+2:].split()[19]
def put(path,value):
 with path.open('x') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
def actor(root,role):
 if role=='owner':
  # A dependency cannot replay this consumed owner's startup.
  put(root/'consumed.json',{'pid':os.getpid(),'at':time.time_ns()})
 else:signal.signal(signal.SIGTERM,signal.SIG_IGN)
 put(root/(role+'.json'),{'pid':os.getpid(),'start':start(os.getpid()),'invocation':os.environ['INVOCATION_ID'],'cgroup':Path('/proc/self/cgroup').read_text().strip()})
 address=os.environ['NOTIFY_SOCKET'];address='\0'+address[1:] if address.startswith('@') else address
 with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as sock:
  sock.sendto(b'READY=1\nWATCHDOG=1',address)
  while True:
   time.sleep(.1)
   if role=='owner':sock.sendto(b'WATCHDOG=1',address)
def command(args):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=2)
 if r.returncode or len(r.stdout)+len(r.stderr)>16384:raise RuntimeError('Bounded fixture systemd command failed: '+r.stderr[:1000])
 return r.stdout
def show(unit):
 keys='Id,LoadState,ActiveState,SubState,MainPID,ControlPID,Job,InvocationID,ControlGroup,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec,BindsTo,After,Result,WatchdogUSec,WatchdogSignal,WatchdogTimestampMonotonic,TimeoutStopUSec,KillMode,Restart'
 return dict(line.split('=',1) for line in command(['/usr/bin/systemctl','--user','show',unit,'--property='+keys]).splitlines() if '=' in line)
def controller(root):
 if os.sched_getaffinity(0)!={1}:raise ValueError('CPU1 required')
 root.mkdir(mode=0o700);source=Path(__file__).resolve();pin=hashlib.sha256(source.read_bytes()).hexdigest();nonce=uuid.uuid4().hex
 units={r:'enclave-rpc-dependency-'+nonce+'-'+r+'.service' for r in ['owner','l1','base','late']}
 rows={};fds={};kills={};before={};commands={}
 def launch(role):
  unit=units[role]
  if show(unit)['LoadState']!='not-found':raise ValueError('New exclusive unit required')
  props=['Type=notify','NotifyAccess=main','KillMode=control-group','Restart=no','MemoryMax=32M','MemorySwapMax=0','CPUQuota=100%','TasksMax=4','LimitCORE=0','RuntimeMaxSec=12','TimeoutStartSec=3','TimeoutStopSec=1','UMask=0077','NoNewPrivileges=yes']
  if role=='owner':props+=['WatchdogSec=2','WatchdogSignal=SIGKILL']
  else:props+=['BindsTo='+units['owner'],'After='+units['owner']]
  argv=['/usr/bin/systemd-run','--user','--quiet','--no-block','--unit='+unit]+['--property='+v for v in props]+['/usr/bin/taskset','-c','1','/usr/bin/python3','-I','-B',str(source),'actor',str(root),role]
  commands[role]=argv;put(root/(role+'-command.json'),argv);command(argv)
 def bind(role):
  end=time.monotonic()+4
  while not (root/(role+'.json')).exists():
   if time.monotonic()>=end:raise TimeoutError('Dummy actor did not publish identity')
   time.sleep(.02)
  row=json.loads((root/(role+'.json')).read_text());fd=os.pidfd_open(row['pid']);fds[role]=fd;rows[role]=row
  if start(row['pid'])!=row['start']:raise ValueError('Dummy PID incarnation changed')
  while True:
   props=show(units[role])
   if props['ActiveState']=='active':break
   if time.monotonic()>=end:raise TimeoutError('Dummy actor not active')
   time.sleep(.02)
  if props['MainPID']!=str(row['pid']) or props['InvocationID']!=row['invocation'] or row['cgroup']!='0::'+props['ControlGroup']:raise ValueError('Exact active incarnation mismatch')
  if props['MemoryMax']!=str(32<<20) or props['MemorySwapMax']!='0' or props['CPUQuotaPerSecUSec']!='1s' or props['KillMode']!='control-group' or props['Restart']!='no':raise ValueError('Envelope differs')
  if role=='owner':
   if props['WatchdogUSec']!='2s' or props['WatchdogSignal']!='9' or int(props['WatchdogTimestampMonotonic'])<=0:raise ValueError('Watchdog not armed')
  elif units['owner'] not in props['BindsTo'].split() or units['owner'] not in props['After'].split():raise ValueError('Lifetime dependency absent')
  cg=Path('/sys/fs/cgroup'+props['ControlGroup']);st=cg.stat();kills[role]=(os.open(cg/'cgroup.kill',os.O_WRONLY|os.O_CLOEXEC),cg,(st.st_dev,st.st_ino));before[role]=props
 try:
  launch('owner');bind('owner')
  for role in ['l1','base']:launch(role);bind(role)
  if select.select(list(fds.values()),[],[],0)[0]:raise ValueError('Premature dummy exit')
  at=time.monotonic();signal.pidfd_send_signal(fds['owner'],signal.SIGSTOP)
  while len(select.select(list(fds.values()),[],[],.05)[0])!=3:
   if time.monotonic()-at>6:raise TimeoutError('Lifetime dependency failed to stop exact actors')
  elapsed=time.monotonic()-at;after={}
  for role in ['owner','l1','base']:
   end=time.monotonic()+2
   while True:
    row=show(units[role]);after[role]=row
    if row['MainPID']=='0' and row['ControlPID']=='0':break
    if time.monotonic()>=end:raise TimeoutError('Dummy unit cleanup incomplete')
    time.sleep(.02)
   _,cg,identity=kills[role]
   if cg.exists():
    st=cg.stat()
    if (st.st_dev,st.st_ino)!=identity or 'populated 0' not in (cg/'cgroup.events').read_text():raise ValueError('Dummy cgroup not empty')
  if after['owner']['Result']!='watchdog':raise ValueError('Owner did not die from watchdog')
  # A late dependent must not execute after a failed, consumed owner. systemd
  # may retry the owner's ExecStart through BindsTo; its exclusive intent fails.
  launch('late');end=time.monotonic()+5
  while True:
   late=show(units['late']);owner=show(units['owner'])
   if late['Job'] in ('','0') and owner['Job'] in ('','0') and late['ActiveState'] in ('inactive','failed') and owner['ActiveState'] in ('inactive','failed'):break
   if time.monotonic()>=end:raise TimeoutError('Late dependent did not settle')
   time.sleep(.025)
  if (root/'late.json').exists() or late['MainPID']!='0' or owner['MainPID']!='0':raise ValueError('Late work gate opened')
  if hashlib.sha256(source.read_bytes()).hexdigest()!=pin:raise ValueError('Fixture source changed')
  result={'allPass':True,'sourceSha256':pin,'before':before,'after':after,'late':late,'ownerAfterLate':owner,'exactThreePidfdsExited':True,'cgroupsEmptyOrRemoved':True,'secondsAfterOwnerFreeze':elapsed,'lateDependentNeverExecuted':True,'dummyOnly':True,'guestNativeCompositionQualified':False,'rpcReady':False}
  put(root/'RESULT.json',result);print(json.dumps(result),flush=True)
 finally:
  for fd,cg,identity in kills.values():
   try:os.write(fd,b'1')
   except OSError:pass
   os.close(fd)
  for fd in fds.values():os.close(fd)
if __name__=='__main__':
 if sys.argv[1]=='actor':actor(Path(sys.argv[2]),sys.argv[3])
 elif sys.argv[1]=='controller':controller(Path(sys.argv[2]))
 else:raise ValueError('Unknown fixture mode')
