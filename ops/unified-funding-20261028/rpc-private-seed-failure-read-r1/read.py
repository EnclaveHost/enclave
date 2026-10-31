from pathlib import Path
import json,subprocess,os,stat
root=Path('/home/controladmin/rpc-private-guest-8ee4452b174746c2b606b9b68f0fa623')
r=subprocess.run(['systemctl','show','enclave-rpc-private-guest-seed-r1-20261031.service','-p','ActiveState','-p','MainPID','-p','Result','-p','ExecMainStatus','-p','InvocationID','-p','MemoryPeak'],capture_output=True,text=True,timeout=4)
assert len(r.stdout)+len(r.stderr)<8192
out={'unit':r.stdout,'unitReadExit':r.returncode,'rootExists':root.exists(),'selectedFiles':{},'namespace':[]}
for parent in [root,root.parent,*root.parent.parents]:
 if parent.exists():
  st=parent.lstat();out['namespace'].append({'path':str(parent),'uid':st.st_uid,'mode':oct(stat.S_IMODE(st.st_mode)),'symlink':parent.is_symlink()})
for name in ['PUBLIC-RESULT.json','output/RESULT.json','output/seed.iso','schema.stdout','schema.stderr','8ee4452b174746c2b606b9b68f0fa623'+'/PUBLIC.json']:
 p=root/name
 out['selectedFiles'][name]={'exists':p.exists(),'bytes':p.stat().st_size if p.exists() else None}
# Only explicit public result; never read key/media/user-data or schema diagnostics.
p=root/'PUBLIC-RESULT.json'
if p.exists():
 assert p.stat().st_size<65536;out['publicResult']=json.loads(p.read_text())
out['invocation']=os.environ.get('INVOCATION_ID');print(json.dumps(out))
