from pathlib import Path
import json,hashlib,time,os
from capture_local import capture
p=Path(__file__).resolve().parent;b=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/payload-v2/bin/lighthouse')
h=hashlib.sha256()
with b.open('rb') as f:
 for block in iter(lambda:f.read(1048576),b''):h.update(block)
assert h.hexdigest()=='11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96'
assert os.sched_getaffinity(0)=={1}
base=['/usr/sbin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(b),'/lighthouse','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/empty','--chdir','/empty','--setenv','HOME','/empty','--setenv','PATH','/usr/bin','--setenv','LANG','C','--setenv','_RJEM_MALLOC_CONF']
profiles={'baseline':'confirm_conf:true,stats_print:true,stats_print_opts:mdablx','low-retention':'confirm_conf:true,abort_conf:true,narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0,background_thread:false,stats_print:true,stats_print_opts:mdablx'}
results={}
for name,conf in profiles.items():
 r=capture(base+[conf,'/lighthouse','--version'],15,limit=65536)
 (p/(name+'.json')).write_text(json.dumps(r,indent=2)+'\n');assert r['rc']==0 and not r['reason'] and not r['truncated'],name
 assert 'Lighthouse' in r['stdout'] and 'malloc_conf' in r['stderr'],name
 assert 'Invalid conf' not in r['stderr'] and 'invalid conf' not in r['stderr'],name
 results[name]={'rc':r['rc'],'seconds':r['elapsedSeconds'],'stdout':r['stdout'],'configuration':conf}
(p/'RESULT.json').write_text(json.dumps({'at':time.time(),'binarySha256':h.hexdigest(),'profiles':results,'networkNamespace':True,'databaseAvailable':False,'onlyVersion':True,'memoryFitProven':False},indent=2)+'\n')
