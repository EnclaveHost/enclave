"""One-shot scheduling courtesy: never stop an I/O worker or queue group."""
import os,json,signal,time,select,hashlib
from pathlib import Path
P=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
B=P.parent.parent/'outputs/rpc-production-final-20261025/base-multipart-production-20261026/batches-1773-run1'
record=json.loads((B/'run.lock').read_text()); pid=record['pid']
runner=P/'jobs/root-multipart-batches-1773.py'
assert hashlib.sha256(runner.read_bytes()).hexdigest()==record['runnerSha256']=='5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a'
fd=os.pidfd_open(pid)
def ident():
 raw=Path(f'/proc/{pid}/stat').read_text();fields=raw[raw.rfind(')')+2:].split()
 assert int(fields[19])==record['startTime']
 cmd=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
 assert str(runner).encode() in cmd and b'drive' in cmd and str(B).encode() in cmd
 assert fields[0] not in ('T','t','Z'),fields[0]
ident()
log=P/'logs/cmv-r6-tests.out'; result=P/'logs/cmv-r6-tests.rc'
assert not result.exists() and '[queue] START' not in log.read_text()
assert not (B/'STOP').exists()
r,w=os.pipe(); watchdog=os.fork()
if watchdog==0:
 os.close(w);os.setsid()
 try:
  select.select([r],[],[],900) # EOF on parent death or normal completion; bounded even if parent hangs
  try:signal.pidfd_send_signal(fd,signal.SIGCONT)
  except ProcessLookupError:pass
 finally:os._exit(0)
os.close(r)
try:
 ident()
 signal.pidfd_send_signal(fd,signal.SIGSTOP)
 print(json.dumps({'event':'scheduler-held','pid':pid,'startTime':record['startTime'],'at':time.time(),'watchdog':watchdog}),flush=True)
 def interrupted(sig,frame):raise InterruptedError(sig)
 for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,interrupted)
 end=time.monotonic()+840
 while time.monotonic()<end:
  if '[queue] START' in log.read_text():
   print(json.dumps({'event':'checker-admitted','at':time.time()}),flush=True);break
  if result.exists() or (B/'STOP').exists():
   print(json.dumps({'event':'early-exit','at':time.time()}),flush=True);break
  time.sleep(1)
 else:print(json.dumps({'event':'bounded-timeout','at':time.time()}),flush=True)
finally:
 try:signal.pidfd_send_signal(fd,signal.SIGCONT)
 except ProcessLookupError:pass
 os.close(w);os.waitpid(watchdog,0);os.close(fd)
 print(json.dumps({'event':'scheduler-resumed','pid':pid,'at':time.time()}),flush=True)
