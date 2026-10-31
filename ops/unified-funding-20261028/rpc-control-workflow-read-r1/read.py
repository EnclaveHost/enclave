import os,json,pathlib,subprocess,time,stat,hashlib
P=pathlib.Path
started=time.monotonic()
def call(argv):
 r=subprocess.run(argv,capture_output=True,text=True,timeout=3)
 if len(r.stdout)>32768 or len(r.stderr)>4096:raise ValueError('observation bound')
 return {'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
def metadata(path):
 try:
  s=path.lstat();return {'path':str(path),'uid':s.st_uid,'mode':oct(stat.S_IMODE(s.st_mode)),'bytes':s.st_size,'links':s.st_nlink,'symlink':stat.S_ISLNK(s.st_mode),'regular':stat.S_ISREG(s.st_mode),'directory':stat.S_ISDIR(s.st_mode)}
 except FileNotFoundError:return {'path':str(path),'missing':True}
uid=os.geteuid();home=P('/home/controladmin');ssh=home/'.ssh'
files=[]
if ssh.is_dir():
 for entry in ssh.iterdir():
  if len(files)>=32:raise ValueError('SSH directory bound')
  row=metadata(entry)
  if entry.name.endswith('.pub') and row['regular'] and row['bytes']<8192:
   row['publicSha256']=hashlib.sha256(entry.read_bytes()).hexdigest()
  files.append(row)
paths=[home,ssh,P('/run/user')/str(uid),P('/run/user')/str(uid)/'bus',home/'rpc-runtime-guest-1d39262eb55642cc80dd840352d449b2',home/'rpc-runtime-guest-1d39262eb55642cc80dd840352d449b2/PUBLIC-RESULT.json',home/'rpc-private-guest-8ee4452b174746c2b606b9b68f0fa623/8ee4452b174746c2b606b9b68f0fa623/PUBLIC.json']
mem={x.split(':')[0]:int(x.split()[1])*1024 for x in P('/proc/meminfo').read_text().splitlines()if x.split(':')[0]in('MemTotal','MemAvailable','SwapTotal','SwapFree')}
os.environ['XDG_RUNTIME_DIR']='/run/user/'+str(uid)
processes=[]
for entry in P('/proc').iterdir():
 if not entry.name.isdigit():continue
 try:
  row=(entry/'stat').read_text().rsplit(')',1)[1].split();processes.append({'pid':int(entry.name),'start':row[19],'comm':(entry/'comm').read_text().strip(),'rss':int(row[21])*os.sysconf('SC_PAGE_SIZE'),'uid':entry.stat().st_uid})
 except (FileNotFoundError,PermissionError,ProcessLookupError):pass
 if len(processes)>256:raise ValueError('process observation bound')
print(json.dumps({'atUtcNs':time.time_ns(),'uid':uid,'boot':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'invocation':os.environ.get('INVOCATION_ID'),'pid':os.getpid(),'memory':mem,'paths':[metadata(x)for x in paths],'sshFiles':files,'userManager':call(['/usr/bin/systemctl','--user','show','default.target','-p','ActiveState','-p','SubState']),'userJobs':call(['/usr/bin/systemctl','--user','list-jobs','--no-legend','--no-pager']),'jobs':call(['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager']),'routeWindows':call(['/usr/sbin/ip','-j','route','get','192.168.8.238']),'routeStorage':call(['/usr/sbin/ip','-j','route','get','192.168.8.249']),'addresses':call(['/usr/sbin/ip','-j','address','show']),'sshSha256':hashlib.file_digest(open('/usr/bin/ssh','rb'),'sha256').hexdigest(),'processes':processes,'elapsed':time.monotonic()-started,'privateKeyRead':False,'rpcWorkSubmitted':False,'readOnly':True}))
