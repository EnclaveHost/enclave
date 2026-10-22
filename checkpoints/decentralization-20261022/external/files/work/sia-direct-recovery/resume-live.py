import subprocess,json,shlex
from pathlib import Path
plan=json.loads(Path('sia-direct-recovery/test-plan.json').read_text());h=json.loads(Path('sia-direct-recovery/live-handle.json').read_text());remote=h['remoteDirectory'];unit=h['unit']+'-retry';binarydir='/home/storageadmin/recovery-lab/'+h['unit']
ssh=['ssh','-p32422','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
setup='''import pathlib,subprocess
root=pathlib.Path(%r);bindir=pathlib.Path(%r);bindir.mkdir(parents=True,exist_ok=False);bindir.chmod(0o700)
subprocess.run(['install','-m','0700',str(root/'sia-s3'),str(bindir/'sia-s3')],check=True)
p=root/'run.py';s=p.read_text();s=s.replace("str(root/'sia-s3')",repr(str(bindir/'sia-s3')));p.write_text(s)
'''%(remote,binarydir)
subprocess.run(ssh+['sudo -n python3 -'],input=setup,text=True,capture_output=True,check=True)
cmd=['sudo','-n','systemd-run','--quiet','--wait','--pipe','--collect','--unit='+unit,'-p','IPAddressDeny=any','-p','IPAddressAllow='+' '.join(plan['hostIPs']),'-p','MemoryMax=512M','-p','CPUQuota=200%','-p','RuntimeMaxSec=900','-p','NoNewPrivileges=yes','/usr/bin/python3',remote+'/run.py',remote]
h.update({'unit':unit,'binaryDirectory':binarydir});Path('sia-direct-recovery/live-handle.json').write_text(json.dumps(h)+'\n')
print(json.dumps(h),flush=True)
r=subprocess.run(ssh+[shlex.join(cmd)],capture_output=True,text=True,timeout=930)
Path('private/sia-direct-recovery/live-stdout.log').write_text(r.stdout);Path('private/sia-direct-recovery/live-stderr.log').write_text(r.stderr);print(r.stdout,flush=True)
if r.returncode:print(json.dumps({'success':False,'exitCode':r.returncode}),flush=True);raise SystemExit(r.returncode)
subprocess.run(ssh+['sudo -n rm -rf -- '+remote+' '+binarydir],check=True,capture_output=True)
print(json.dumps({'success':True,'temporaryRemoteCredentialsRemoved':True}),flush=True)
