# Inert fixture client only. No network, native application, disk image or credentials.
import errno,json,os,signal,sys,time
from pathlib import Path
case,base,private=sys.argv[1:];p=Path(base)
assert os.getuid()==997 and os.getgid()==987 and os.sched_getaffinity(0)=={1}
checks={}
for name,path in [('privateRead',Path(private)/'exit-receipts/el-binding.json'),('privateWrite',Path(private)/'exit-receipts/client-forgery')]:
 try:
  if name=='privateRead':path.read_bytes()
  else:path.write_text('forbidden')
  checks[name]=False
 except OSError as e:checks[name]=e.errno in (errno.EACCES,errno.EPERM)
try:(p/'deny/probe').write_text('forbidden');checks['outsideWrite']=False
except OSError as e:checks['outsideWrite']=e.errno==errno.EROFS
for name in ('data','tmp'):
 (p/name/'probe').write_text('allowed');checks[name]=True
(p/'data/client-checks.json').write_text(json.dumps(checks))
if not all(checks.values()):raise SystemExit(97)
until=time.monotonic()+8
while not (p/'data/go').exists():
 if time.monotonic()>until:raise SystemExit(98)
 time.sleep(.05)
if case=='timeout':
 signal.signal(signal.SIGINT,signal.SIG_IGN)
 time.sleep(200)
raise SystemExit(7 if case=='exit7' else 0)
