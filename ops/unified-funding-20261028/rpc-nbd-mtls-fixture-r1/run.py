from pathlib import Path
import os,json,time,hashlib
from capture_local import capture
p=Path(__file__).resolve().parent;assert os.sched_getaffinity(0)=={1}
with(p/'ATTEMPT.json').open('x')as f:json.dump({'at':time.time(),'inertLocalOnly':True},f)
base=['/usr/sbin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--cap-add','CAP_NET_ADMIN','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'nbd-client'),'/client','--ro-bind',str(p/'fixture.py'),'/fixture.py','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/empty','--chdir','/empty','--setenv','HOME','/empty','--setenv','PATH','/usr/bin:/usr/sbin','--setenv','LANG','C','/usr/bin/python3','-B','/fixture.py']
r=capture(base,75,limit=131072);(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');assert r['rc']==0 and not r['reason'] and not r['truncated']
