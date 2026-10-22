from pathlib import Path
import subprocess,json,hashlib,datetime
R=Path(__file__).resolve().parent;W=R.parent.parent;kh=W/'work/storage-vm/known_hosts';script=R/'metadata.sh'
assert hashlib.sha256(script.read_bytes()).hexdigest()=='71f1a6b46f7eb68f969ac5917d4b88a5f91af633ae76ff60e448788bfcb3b027'
fp=subprocess.run(['ssh-keygen','-lf',str(kh)],capture_output=True,text=True,timeout=10)
assert fp.returncode==0 and 'SHA256:BKbepXOEQ8GSvOKvyhVnKpdauQy0Awkq/Uq8je+LAOo' in fp.stdout,'storage host trust pin differs'
cmd=['ssh','-p','32422','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ConnectionAttempts=1','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(kh),'-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1','sudo -n timeout -k 5 45 bash -s']
with (R/'attempt.json').open('x') as f:json.dump({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'scriptSha':hashlib.sha256(script.read_bytes()).hexdigest()},f)
r=subprocess.run(cmd,input=script.read_bytes(),capture_output=True,timeout=60)
(R/'metadata.json').write_bytes(r.stdout);(R/'stderr.txt').write_bytes(r.stderr)
meta={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'bytes':len(r.stdout),'captureSha':hashlib.sha256(r.stdout).hexdigest(),'stderr':r.stderr.decode(errors='replace')[-800:]}
(R/'result.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta,indent=2))
raise SystemExit(r.returncode)
