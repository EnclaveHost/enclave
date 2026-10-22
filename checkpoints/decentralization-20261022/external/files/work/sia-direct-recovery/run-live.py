import io,tarfile,json,subprocess,uuid,shlex,os
from pathlib import Path
plan=json.loads(Path('sia-direct-recovery/test-plan.json').read_text())
ssh=['ssh','-p32422','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
runid=uuid.uuid4().hex[:12];remote='/run/enclave-sia-recovery-'+runid;unit='enclave-sia-recovery-'+runid;binarydir='/home/storageadmin/recovery-lab/'+unit
runner='''import json,os,socket,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]);plan=json.loads((root/'plan.json').read_text())
blocked=[]
for ip in plan['blockedIPs']:
 try:
  s=socket.create_connection((ip,9982 if ip=='127.0.0.1' else 443),2);s.close()
 except OSError:blocked.append(ip)
 else:raise RuntimeError('network restriction failed for '+ip)
print(json.dumps({'blockedProbes':blocked}),flush=True)
env={k:v for k,v in os.environ.items() if k not in ['ENCLAVE_CONFIG','SIAS3_CONFIG','ENCLAVE_EGRESS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']}
env['SIA_RECOVERY_KEY_FILE']=str(root/'app.seed')
for n,item in enumerate(plan['samples']):
 p=subprocess.run([str(Path(os.environ['SIA_TEST_BINARY'])),'recovery','read',str(root/'snapshot.json'),plan['snapshotSha256'],'ipfs','pins/'+item['cid'],str(root/('restored-'+str(n))),item['sha256'],str(item['bytes'])],env=env,capture_output=True,text=True,timeout=610)
 (root/('read-'+str(n)+'.log')).write_text(p.stderr)
 if p.returncode:raise RuntimeError('read failed, code '+str(p.returncode)+'; protected diagnostics retained')
 report=json.loads(p.stdout);assert report['verified'] and report['bytes']==item['bytes'] and report['sha256']==item['sha256']
 report['cid']=item['cid'];print(json.dumps(report),flush=True)
 if n==0:
  refused=root/'must-not-appear'
  bad=subprocess.run([str(Path(os.environ['SIA_TEST_BINARY'])),'recovery','read',str(root/'snapshot.json'),plan['snapshotSha256'],'ipfs','pins/'+item['cid'],str(refused),'00'*32,str(item['bytes'])],env=env,capture_output=True,text=True,timeout=610)
  assert bad.returncode!=0 and 'recovered file digest or size mismatch' in bad.stderr and not refused.exists()
  assert not list(root.glob('.sia-recovery-*'))
  print(json.dumps({'wrongFileDigestRefused':True,'noPartialOutput':True}),flush=True)
'''
subprocess.run(ssh+['sudo -n install -d -m 0700 '+remote],check=True,capture_output=True)
archive=io.BytesIO()
files={'sia-s3':Path('enclave-apps-sia-recovery/sia-s3/target/x86_64-unknown-linux-gnu/release/sia-s3').read_bytes(),'snapshot.json':Path('private/sia-direct-recovery/snapshot-ip-pinned.json').read_bytes(),'app.seed':Path('private/sia-direct-recovery/app.seed').read_bytes(),'plan.json':json.dumps(plan).encode(),'run.py':runner.encode()}
with tarfile.open(fileobj=archive,mode='w:gz') as tar:
 for name,data in files.items():
  info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o700 if name=='sia-s3' else 0o600;tar.addfile(info,io.BytesIO(data))
subprocess.run(ssh+['sudo -n tar -xzf - -C '+remote],input=archive.getvalue(),check=True,capture_output=True)
subprocess.run(ssh+['sudo -n install -d -m 0700 '+binarydir+' && sudo -n install -m 0700 '+remote+'/sia-s3 '+binarydir+'/sia-s3'],check=True,capture_output=True)
# A live preflight proves localhost indexd is reachable outside the test cgroup.
pre=subprocess.run(ssh+['python3 -c '+shlex.quote("import socket; s=socket.create_connection(('127.0.0.1',9982),3);s.close();print('indexd reachable outside test')")],capture_output=True,text=True,check=True)
print(pre.stdout.strip(),flush=True)
cmd=['sudo','-n','systemd-run','--quiet','--wait','--pipe','--collect','--unit='+unit,'--setenv=SIA_TEST_BINARY='+binarydir+'/sia-s3','-p','IPAddressDeny=any','-p','IPAddressAllow='+' '.join(plan['hostIPs']),'-p','MemoryMax=512M','-p','CPUQuota=200%','-p','RuntimeMaxSec=900','-p','NoNewPrivileges=yes','/usr/bin/python3',remote+'/run.py',remote]
print(json.dumps({'unit':unit,'remoteDirectory':remote,'allowedHostIPs':len(plan['hostIPs']),'snapshotSha256':plan['snapshotSha256']}),flush=True)
meta=Path('sia-direct-recovery/live-handle.json');meta.write_text(json.dumps({'unit':unit,'remoteDirectory':remote,'binaryDirectory':binarydir})+'\n')
result=subprocess.run(ssh+[shlex.join(cmd)],capture_output=True,text=True,timeout=930)
Path('private/sia-direct-recovery/live-stdout.log').write_text(result.stdout);Path('private/sia-direct-recovery/live-stderr.log').write_text(result.stderr)
print(result.stdout,flush=True)
if result.returncode:
 print(json.dumps({'success':False,'exitCode':result.returncode,'remoteDirectory':remote,'binaryDirectory':binarydir}),flush=True)
 raise SystemExit(result.returncode)
subprocess.run(ssh+['sudo -n rm -rf -- '+remote+' '+binarydir],check=True,capture_output=True)
print(json.dumps({'success':True,'temporaryRemoteCredentialsRemoved':True}),flush=True)
