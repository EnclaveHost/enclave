"""Prepared-only exact queue ancestry + resource gate; no work at import."""
from pathlib import Path
import hashlib,json,os,re,stat,subprocess,time
P=Path(__file__).resolve().parent
CG=Path('/sys/fs/cgroup')
def fail(s):raise SystemExit(s)
def sha(f):
 with Path(f).open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
def show(unit):
 fields=['Id','ControlGroup','InvocationID','MainPID','ActiveState','LoadState','Transient']
 out=subprocess.check_output(['/usr/bin/systemctl','--user','show',unit,'--no-pager',*[f'--property={v}' for v in fields]],text=True,timeout=5)
 if len(out)>8192:fail('manager output bound')
 d=dict(x.split('=',1) for x in out.splitlines())
 if d.get('Id')!=unit or d.get('LoadState')!='loaded' or d.get('ActiveState')!='active' or d.get('Transient')!='yes' or not re.fullmatch('[0-9a-f]{32}',d.get('InvocationID','')):fail('unit not exact active transient invocation')
 return d
def proc(pid):
 d=Path('/proc')/str(pid)
 s=(d/'stat').read_text();v=s[s.rfind(')')+2:].split()
 c=(d/'cgroup').read_text().strip()
 if not c.startswith('0::/') or '\n' in c:fail('unified cgroup required')
 ex=(d/'exe').resolve(strict=True);e=ex.stat()
 args=(d/'cmdline').read_bytes()
 if len(args)>16384:fail('argv bound')
 if d.stat().st_uid!=os.getuid():fail('process owner drift')
 result={'pid':pid,'ppid':int(v[1]),'startTicks':v[19],'cgroup':c[3:],'exe':str(ex),'exeDev':e.st_dev,'exeIno':e.st_ino}
 s2=(d/'stat').read_text();v2=s2[s2.rfind(')')+2:].split()
 if v2[19]!=result['startTicks'] or int(v2[1])!=result['ppid']:fail('process changed while reading')
 return result,args.split(b'\0')[:-1]
def cgpath(c):
 q=CG/c.lstrip('/')
 if not c.startswith('/') or q.resolve()!=q or '..' in Path(c).parts:fail('cgroup path mismatch')
 return q
def cgid(c):
 st=cgpath(c).stat();return [st.st_dev,st.st_ino]
def boot():return Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def write_once(name,value):
 fd=os.open(P/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
def read_marker():
 fd=os.open(P/'outer-launch.json',os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd) as f:
  st=os.fstat(f.fileno())
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077 or st.st_nlink!=1 or st.st_size>8192:fail('invalid launch marker')
  return json.load(f)
def verify_inputs():
 prep=json.loads((P/'PREPARED.json').read_text())
 if prep['status']!='PREPARED_NOT_LAUNCHED':fail('wrong preparation status')
 for n,h in prep['hashes'].items():
  if sha(P/n)!=h:fail('package drift: '+n)
 for n,h in json.loads((P/'input-pins.json').read_text()).items():
  if sha(n)!=h:fail('external drift: '+n)
 for item in json.loads((P/'author-tool-pins.json').read_text())['tools']:
  if str(Path(item['path']).resolve())!=item['realpath'] or sha(item['path'])!=item['sha256']:fail('tool drift')
 return prep
def resources(c,required=False):
 q=cgpath(c)
 r={'cgroup':c,'identity':cgid(c),'memoryMax':(q/'memory.max').read_text().strip(),'swapMax':(q/'memory.swap.max').read_text().strip(),'affinity':sorted(os.sched_getaffinity(0)),'cpuHierarchy':[]}
 if r['memoryMax']!=str(1536<<20) or r['swapMax']!='0' or r['affinity']!=[1]:fail('actual memory/swap/affinity mismatch')
 t=q
 while True:
  f=t/'cpu.max'
  if f.exists():
   raw=f.read_text().strip();a,b=raw.split()
   if int(b)<=0 or (a!='max' and int(a)<=0):fail('invalid cpu.max')
   r['cpuHierarchy'].append({'cgroup':'/'+str(t.relative_to(CG)) if t!=CG else '/', 'cpuMax':raw})
  elif t!=CG:fail('missing enclosing CPU controller authority')
  if t==CG:break
  t=t.parent
 f=q/'cpuset.cpus.effective';r['effectiveCpus']=f.read_text().strip() if f.exists() else None
 if required:
  a,b=(q/'cpu.max').read_text().split()
  if a=='max' or int(a)>int(b) or r['effectiveCpus']!='1':fail('actual scope CPU/cpuset limit not applied')
 return r
def bootstrap():
 verify_inputs();cfg=json.loads((P/'queue-binding.json').read_text())
 a=json.loads((P/'root-author-approval.json').read_text())
 if a.get('preparedSha256')!=sha(P/'PREPARED.json') or a.get('launchAuthorized') is not True or a.get('queueScopeResourceMutationAuthorized') is not True or not 0<=time.time()-a.get('at',0)<=300:fail('fresh root approval for scoped resource mutation required')
 me,args=proc(os.getpid());u=show(cfg['outerUnit'])
 if u['MainPID']!=str(os.getpid()) or u['ControlGroup']!=me['cgroup'] or Path(me['cgroup']).name!=cfg['outerUnit']:fail('outer service identity mismatch')
 resources(me['cgroup'],True)
 marker={'preparedSha256':sha(P/'PREPARED.json'),'launchNonce':cfg['launchNonce'],'boot':boot(),'outer':u,'process':me,'cgroupIdentity':cgid(me['cgroup']),'at':time.time()}
 write_once('outer-launch.json',marker)
 cmd=['/usr/bin/python3',cfg['queue'],'--mib','1536','--log',str(P/'outer.guard.log'),'--','/usr/bin/taskset','-c','1','/usr/bin/node',cfg['guard'],'--max-rss-mib','1408','--floor-available-mib','27648','--log',str(P/'inner.guard.log'),'--','/usr/bin/python3','-B',str(P/'run.py')]
 os.execv(cmd[0],cmd)
def enforce_scope():
 cfg=json.loads((P/'queue-binding.json').read_text());m=read_marker()
 if m['preparedSha256']!=sha(P/'PREPARED.json') or m['launchNonce']!=cfg['launchNonce'] or m['boot']!=boot() or not 0<=time.time()-m['at']<=180:fail('stale or mismatched outer launch')
 outer=show(cfg['outerUnit']);op,oa=proc(m['process']['pid'])
 if outer!=m['outer'] or op!=m['process'] or cgid(op['cgroup'])!=m['cgroupIdentity'] or oa[:2]!=[b'/usr/bin/python3',cfg['queue'].encode()]:fail('queue must be exact exec-preserved outer MainPID')
 chain=[];pid=os.getpid()
 for _ in range(16):
  x,args=proc(pid);chain.append((x,args))
  if pid==op['pid']:break
  if x['ppid']<=1:fail('missing outer ancestry')
  pid=x['ppid']
 else:fail('ancestor bound')
 if chain[-1][0]!=op:fail('wrong outer ancestor')
 # Queue's actual systemd-run child must remain on our ancestry; suffix is insufficient.
 launches=[x for x,a in chain if x['exe']=='/usr/bin/systemd-run' and x['ppid']==op['pid'] and b'--user' in a and b'--scope' in a and cfg['guard'].encode() in a]
 if len(launches)!=1:fail('missing exact queue-created systemd-run ancestor')
 own=chain[0][0];scope=Path(own['cgroup']).name
 if not re.fullmatch(r'run-[A-Za-z0-9_-]+\.scope',scope):fail('unexpected queue scope name')
 u=show(scope)
 if u['ControlGroup']!=own['cgroup'] or u['ControlGroup']==outer['ControlGroup']:fail('scope manager/kernel mismatch')
 scoped=[(x,a) for x,a in chain if x['cgroup']==own['cgroup']]
 guards=[x for x,a in scoped if x['exe']=='/usr/bin/node' and cfg['guard'].encode() in a]
 if len(guards)!=2:fail('both pinned queue/inner guards must be actual scoped ancestors')
 if own['pid'] not in [int(x) for x in (cgpath(own['cgroup'])/'cgroup.procs').read_text().split()]:fail('self missing scope membership')
 before=resources(own['cgroup']);identity=cgid(own['cgroup'])
 # Only the exact already-bound own transient scope is targeted. No shared queue edit.
 subprocess.run(['/usr/bin/systemctl','--user','set-property','--runtime',scope,'CPUQuota=100%','AllowedCPUs=1'],check=True,timeout=5)
 if show(scope)!=u or show(cfg['outerUnit'])!=outer or cgid(own['cgroup'])!=identity:fail('manager incarnation changed during enforcement')
 for x,a in chain:
  if proc(x['pid'])[0]!=x:fail('ancestor incarnation changed during enforcement')
 after=resources(own['cgroup'],True)
 write_once('queue-scope-binding.json',{'boot':m['boot'],'launchNonce':m['launchNonce'],'outer':outer,'scope':u,'ancestors':[x for x,a in chain],'before':before,'after':after,'at':time.time(),'note':'CPU hierarchy is the actual scope ancestry; outer service is a sibling and is not CPU quota authority for this scope.'})
