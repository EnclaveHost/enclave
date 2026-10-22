from pathlib import Path
import subprocess,json,hashlib,datetime
R=Path(__file__).resolve().parent;W=R.parent.parent;kh=W/'work/storage-vm/known_hosts';script=R/'vm-preflight.sh'
assert hashlib.sha256(script.read_bytes()).hexdigest()=='ee359b5775f5fdfee2a09d2540d9654e31e8d61a8b6c285a187576e4daa1e45b'
fp=subprocess.run(['ssh-keygen','-lf',str(kh)],capture_output=True,text=True,timeout=10)
assert fp.returncode==0 and 'SHA256:BKbepXOEQ8GSvOKvyhVnKpdauQy0Awkq/Uq8je+LAOo' in fp.stdout,'storage host trust pin differs'
cmd=['ssh','-p','32422','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ConnectionAttempts=1','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(kh),'-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1','sudo -n timeout -k 10 330 bash -s']
with (R/'attempt.json').open('x') as f:json.dump({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'scriptSha':hashlib.sha256(script.read_bytes()).hexdigest()},f)
r=subprocess.run(cmd,input=script.read_bytes(),capture_output=True,timeout=380)
(R/'preflight.out').write_bytes(r.stdout);(R/'stderr.txt').write_bytes(r.stderr)
meta={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'bytes':len(r.stdout),'captureSha':hashlib.sha256(r.stdout).hexdigest(),'stderr':r.stderr.decode(errors='replace')[-800:]}
(R/'result.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta,indent=2))
raise SystemExit(r.returncode)
