import json,subprocess,shlex,hashlib
from pathlib import Path
p=Path(__file__).resolve().parent
files={'correct.py':(p/'correct.py').read_text(),'fee-policy.json':(p/'fee-policy.json').read_text(),'quarantine_install_r2.py':(p.parent/'quarantine-install-state-link-r4/quarantine_install_r2.py').read_text()}
code='''import sys,json,pathlib,os,hashlib,subprocess,stat
v=json.load(sys.stdin);root=pathlib.Path('/var/lib/enclave-maintenance/funding-gas-envelope-20261029-r1')
assert not root.exists()
assert root.parent.is_dir() and not root.parent.is_symlink() and root.parent.stat().st_uid==0
root.mkdir(mode=0o700)
for n,s in v.items():
 assert n in ['correct.py','fee-policy.json','quarantine_install_r2.py']
 p=root/n
 with p.open('xb') as f:f.write(s.encode());f.flush();os.fsync(f.fileno())
 os.chmod(p,0o600)
r=subprocess.run(['/usr/bin/python3',str(root/'correct.py'),'--check'],capture_output=True,text=True,timeout=90)
(root/'preflight.out').write_text(r.stdout);(root/'preflight.err').write_text(r.stderr)
os.chmod(root/'preflight.out',0o600);os.chmod(root/'preflight.err',0o600)
print(r.stdout);print(r.stderr,file=sys.stderr);sys.exit(r.returncode)
'''
ssh=['ssh','-J','minipc','-o','HostKeyAlias=[127.0.0.1]:32423','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-o','ConnectTimeout=10','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159']
r=subprocess.run(ssh+['sudo -n /usr/bin/python3 -c '+shlex.quote(code)],input=json.dumps(files),capture_output=True,text=True,timeout=110)
(p/'stage-check.out').write_text(r.stdout);(p/'stage-check.err').write_text(r.stderr)
print(r.stdout);print(r.stderr);raise SystemExit(r.returncode)
