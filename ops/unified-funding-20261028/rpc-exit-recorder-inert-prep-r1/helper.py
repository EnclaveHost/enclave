# Root-reviewed inert fixture helper; invoked only after separate admission.
from pathlib import Path
import hashlib,json,os,pwd,grp,stat,subprocess,sys,time,signal,shutil
ROOT=Path(__file__).resolve().parent
C=json.loads((ROOT/'config.json').read_text())
def sha(p):
 with Path(p).open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
def record(name,value):
 data=(json.dumps(value,sort_keys=True)+'\n').encode();assert len(data)<=131072
 f=ROOT/(name+'.pending');fd=os.open(f,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as s:s.write(data);s.flush();os.fsync(s.fileno())
 os.replace(f,ROOT/name)
def command(args,seconds=3):
 r=subprocess.run(args,capture_output=True,text=True,timeout=seconds)
 assert len(r.stdout)+len(r.stderr)<=32768,'command-output-limit'
 return r
def show(unit):
 names='Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,User,Group,Description,Transient,ExecMainPID,ExecMainStartTimestampMonotonic,Result,ExecMainCode,ExecMainStatus'
 r=command(['/usr/bin/systemctl','show',unit,'--property='+names,'--no-pager'])
 assert r.returncode in (0,1,4)
 return dict(line.split('=',1) for line in r.stdout.splitlines())
def proc(pid):
 q=Path('/proc')/str(pid);s=(q/'stat').read_text();v=s[s.rfind(')')+2:].split()
 return {'pid':pid,'startTicks':int(v[19]),'cgroup':(q/'cgroup').read_text().strip(),'exe':str((q/'exe').resolve(strict=True))}
def resources():
 assert Path('/proc/sys/kernel/random/boot_id').read_text().strip()==C['boot'],'boot-drift'
 available=next(int(l.split()[1])*1024 for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
 growth=0;services=[]
 for name,mib in C['serviceCapsMiB'].items():
  q=Path('/sys/fs/cgroup/system.slice')/name
  cap=int((q/'memory.max').read_text());current=int((q/'memory.current').read_text())
  assert cap==mib<<20,'service-cap-drift'
  growth+=max(0,cap-current);services.append({'unit':name,'cap':cap,'current':current})
 # Conservative: subtract full256MiB fixture even though its current usage is in MemAvailable.
 residual=available-growth-(C['aggregateMiB']<<20)
 assert residual>=C['osReserveMiB']<<20,'OS-residual-floor'
 return {'at':time.time(),'available':available,'serviceGrowth':growth,'fixtureReserved':C['aggregateMiB']<<20,'residual':residual,'services':services}
def idle_uid():
 for q in Path('/proc').iterdir():
  if not q.name.isdigit():continue
  try:uid=q.stat().st_uid
  except FileNotFoundError:continue
  assert uid!=997,'UID997-is-busy'
def own(unit,info):
 if info.get('LoadState')=='not-found':return
 assert info.get('Id')==unit and info.get('Transient')=='yes' and info.get('Description')==C['nonce']+' '+unit,'foreign-unit'
def dead(case,saved=None):
 info=show(case['unit']);own(case['unit'],info)
 assert info.get('LoadState')=='not-found' or info.get('MainPID')=='0' and info.get('ActiveState') in ('inactive','failed'),'unit-live'
 if saved:
  try:assert proc(saved['pid'])['startTicks']!=saved['startTicks'],'saved-main-live'
  except FileNotFoundError:pass
 q=Path('/sys/fs/cgroup/system.slice')/case['unit']
 if q.exists():
  if saved:assert [q.stat().st_dev,q.stat().st_ino]==saved['cgroupIdentity'],'cgroup-replaced'
  assert all(not f.read_text().strip() for f in q.rglob('cgroup.procs')),'descendant-live'
 return info
def publish_binding(case,value):
 q=Path(case['root'])/'exit-receipts';tmp=q/'.binding.pending'
 with tmp.open('xb') as f:f.write(json.dumps(value).encode());f.flush();os.fsync(f.fileno())
 os.chmod(tmp,0o600);os.link(tmp,q/'el-binding.json');tmp.unlink()
 fd=os.open(q,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def main():
 assert os.geteuid()==0 and os.sched_getaffinity(0)=={1}
 assert Path('/proc/self/cgroup').read_text().strip()=='0::/system.slice/'+C['helperUnit'],'helper-cgroup'
 q=Path('/sys/fs/cgroup/system.slice')/C['helperUnit']
 assert (q/'memory.max').read_text().strip()==str(128<<20) and (q/'memory.swap.max').read_text().strip()=='0'
 quota,period=(q/'cpu.max').read_text().split();assert quota!='max' and int(quota)<=int(period)
 for row in C['binaryPins']:
  f=Path(row['path']);st=f.stat()
  assert str(f.resolve())==row['realpath'] and st.st_size==row['bytes'] and st.st_uid==st.st_gid==0 and sha(f)==row['sha256'],'binary-drift'
 version=command(['/usr/bin/systemctl','--version']).stdout.splitlines()[0];assert version==C['systemdVersionLine']
 assert pwd.getpwnam('enclavel1el').pw_uid==997 and grp.getgrnam('enclavel1el').gr_gid==987 and grp.getgrnam('enclavel1jwt').gr_gid==50002
 idle_uid();record('resource-admission.json',resources())
 started=time.monotonic();results=[]
 for case in C['cases']:
  assert time.monotonic()-started<200,'fixture-budget'
  resources();idle_uid()
  for other in C['cases']:
   assert show(other['unit']).get('LoadState')=='not-found','fixture-unit-preexists-or-not-collected'
  record('intent.json',{'case':case['name'],'unit':case['unit'],'at':time.time()})
  r=Path(case['root']);pub=Path(case['public']);receipt=r/'exit-receipts/el-exit.json'
  argv=['/usr/bin/systemd-run','--quiet','--collect','--unit='+case['unit'],'--description='+C['nonce']+' '+case['unit'],
   '--property=Type=exec','--property=User=enclavel1el','--property=Group=enclavel1el','--property=SupplementaryGroups=enclavel1jwt',
   '--property=NoNewPrivileges=yes','--property=ProtectSystem=strict','--property=ProtectHome=yes','--property=PrivateTmp=yes',
   '--property=ReadWritePaths='+str(pub/'data')+' '+str(pub/'tmp')+' '+str(r/'exit-receipts'),
   '--property=UMask=0027','--property=MemoryMax=128M','--property=MemorySwapMax=0','--property=CPUQuota=100%',
   '--property=CPUAffinity=1','--property=TasksMax=512','--property=LimitNOFILE=65536','--property=OOMScoreAdjust=100','--property=KillMode=control-group',
   '--property=KillSignal=SIGINT','--property=TimeoutStopSec=45','--property=RuntimeMaxSec=10','--property=Restart=no',
   '--property=BindsTo='+C['helperUnit'],
   '--property=ExecStopPost=!/usr/bin/timeout --signal=TERM --kill-after=1 3 /usr/bin/python3 -I -B '+str(r/'exit-recorder.py')+' el',
   '/usr/bin/python3','-I','-B',str(Path(C['public'])/'inert-client.py'),case['name'],str(pub),str(r)]
  assert command(argv,5).returncode==0,'launch-refused'
  info=show(case['unit']);own(case['unit'],info);pid=int(info['MainPID']);assert pid>0
  ident=proc(pid);cg='/system.slice/'+case['unit'];assert ident['cgroup']=='0::'+cg and ident['exe']=='/usr/bin/python3.12'
  assert info['ExecMainPID']==str(pid) and info['ExecMainStartTimestampMonotonic'].isdecimal()
  cgs=Path('/sys/fs/cgroup'+cg).stat();ident['cgroupIdentity']=[cgs.st_dev,cgs.st_ino]
  q=Path('/sys/fs/cgroup'+cg);assert (q/'memory.max').read_text().strip()==str(128<<20) and (q/'memory.swap.max').read_text().strip()=='0'
  quota,period=(q/'cpu.max').read_text().split();assert quota!='max' and int(quota)<=int(period) and os.sched_getaffinity(pid)=={1}
  record('saved-'+case['name']+'.json',ident)
  binding={'boot':C['boot'],'nonce':C['nonce'],'unit':case['unit'],'invocation':info['InvocationID'],'pid':pid,'startTicks':ident['startTicks'],
   'mainStartMonotonic':info['ExecMainStartTimestampMonotonic'],'cgroup':cg,'cgroupIdentity':ident['cgroupIdentity'],
   'description':C['nonce']+' '+case['unit'],'user':'enclavel1el','recorderSha256':case['recorderSha256']}
  for name,f in [('rootIdentity',r),('receiptDirectoryIdentity',r/'exit-receipts'),('recorderIdentity',r/'exit-recorder.py')]:
   st=f.lstat();assert st.st_uid==st.st_gid==0;binding[name]=[st.st_dev,st.st_ino]
  if case['name']!='missingbinding':publish_binding(case,binding)
  sentinel=None
  if case['name']=='nooverwrite':
   with receipt.open('x') as f:json.dump({'sentinel':C['nonce']},f)
   receipt.chmod(0o600);sentinel=sha(receipt)
  (pub/'data/go').write_text('go')
  until=time.monotonic()+70
  while time.monotonic()<until:
   info=show(case['unit'])
   if info.get('LoadState')=='not-found':break
   own(case['unit'],info);resources();time.sleep(.25)
  assert show(case['unit']).get('LoadState')=='not-found','unit-not-GC'
  dead(case,ident)
  checks=json.loads((pub/'data/client-checks.json').read_text());assert all(checks.values()),'client-sandbox-probe'
  row={'case':case['name'],'identity':ident,'unitGC':True,'clientChecks':checks,'at':time.time()}
  if case['name']=='missingbinding':assert not receipt.exists();row['receiptMissingFailClosed']=True
  elif case['name']=='nooverwrite':assert sha(receipt)==sentinel;row['noOverwrite']=True
  else:
   st=receipt.lstat();assert stat.S_ISREG(st.st_mode) and st.st_uid==st.st_gid==0 and st.st_nlink==1 and st.st_size<=4096
   body=json.loads(receipt.read_text())
   for key in binding:
    if key in ('description','user'):continue
    assert body[key]==binding[key],'receipt-binding:'+key
   assert body['managerStopPostVerified'] is True
   expected={'clean':('success','1','0'),'exit7':('exit-code','1','7'),'timeout':('timeout','2','9')}[case['name']]
   assert (body['Result'],body['ExecMainCode'],body['ExecMainStatus'])==expected,'exit-result'
   row['receipt']=body;row['receiptSurvivedUnitGC']=True
  results.append(row);record('RESULT.json',{'complete':False,'cases':results})
 record('RESULT.json',{'complete':True,'cases':results,'nativeApplication':False,'namespaceVariantOnly':True})
def cleanup():
 assert os.sched_getaffinity(0)=={1}
 # Only exact nonce-description fixture units. Never stop an unrelated existing unit.
 errors=[];owned=[]
 for case in C['cases']:
  try:
   info=show(case['unit']);own(case['unit'],info)
   if info.get('LoadState')!='not-found':owned.append(case['unit'])
  except Exception as e:errors.append(case['name']+':ownership:'+type(e).__name__)
 if owned:
  try:
   r=command(['/usr/bin/systemctl','stop',*owned],60)
   if r.returncode not in (0,5):errors.append('stop:'+str(r.returncode))
  except Exception as e:errors.append('stop:'+type(e).__name__)
 for case in C['cases']:
  try:
   saved=ROOT/('saved-'+case['name']+'.json');dead(case,json.loads(saved.read_text()) if saved.exists() else None)
  except Exception as e:errors.append(case['name']+':death:'+type(e).__name__)
 if not errors:
  # Remove only dedicated inert public executable/data/tmp/probe files, no images/mounts.
  pub=Path(C['public'])
  if pub.exists():
   st=pub.lstat();assert [st.st_dev,st.st_ino]==C['publicIdentity'] and st.st_uid==0
   shutil.rmtree(pub)
 record('CLEANUP.json',{'ok':not errors,'errors':errors,'privateEvidenceRetained':str(ROOT),'publicFilesRemoved':not errors,'at':time.time()})
 assert not errors,'cleanup-unproven'
if __name__=='__main__':
 assert ROOT==Path('/run/enclave-rpc-recorder-fixture-r1') and os.geteuid()==0
 if sys.argv[1:] == ['main']:main()
 elif sys.argv[1:] == ['cleanup']:cleanup()
 else:raise SystemExit('fixed action required')
