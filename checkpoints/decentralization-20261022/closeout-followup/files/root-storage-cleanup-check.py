import subprocess,json,datetime,shlex
from pathlib import Path
remote = '''import os,json
p='/home/storageadmin/20261023T012337Z-efe2c21b-001-51c4f6'
files=[os.path.join(a,n) for a,d,ns in os.walk(p+'/restored') for n in ns]
print(json.dumps(dict(stagingAbsent=not os.path.exists(p+'/stage'),restoredFiles=len(files),restoredBytes=sum(os.stat(f).st_size for f in files),resultPresent=os.path.isfile(p+'/result.json'))))
'''
cmd=['ssh','-n','-p','32422','-oBatchMode=yes','-oConnectTimeout=8','-oUserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1','sudo -n python3 -c '+shlex.quote(remote)]
r=subprocess.run(cmd,capture_output=True,text=True,timeout=40)
if r.returncode: raise SystemExit('Read-only check failed; no receipt written')
v=json.loads(r.stdout)
v['checkedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
v['fullRecoveryVerified']=False
v['note']='Failed attempt staging removed after terminal-handle verification; restored data retained. Counts include any incomplete files and are not a verified inventory.'
Path('outputs/decentralization-audit/storage-failed-attempt-cleanup-20261023.json').write_text(json.dumps(v,indent=2)+'\n')
print(json.dumps(v))
