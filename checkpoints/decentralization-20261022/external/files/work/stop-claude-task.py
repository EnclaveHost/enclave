import sys,os,signal,json,datetime
from pathlib import Path
session,reason,out=sys.argv[1:]
parents={};matches=[]
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  args=(p/'cmdline').read_bytes().split(b'\0');parents[int(p.name)]=int((p/'stat').read_text().split(') ')[1].split()[1])
  if session.encode() in args and '--print'.encode() in args and 'claude' in Path(args[0].decode()).name:matches.append(int(p.name))
 except (OSError,ValueError,IndexError):pass
if len(matches)>1:raise SystemExit('ambiguous Claude session')
victims=set(matches)
while True:
 more={p for p,parent in parents.items() if parent in victims}-victims
 if not more:break
 victims|=more
for p in sorted(victims,reverse=True):
 try:os.kill(p,signal.SIGTERM)
 except ProcessLookupError:pass
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'session':session,'terminated':sorted(victims),'reason':reason};Path(out).write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
