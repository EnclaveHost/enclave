import json, pathlib, shlex, subprocess
root=pathlib.Path.cwd(); out=root/'work/resume-after-checkpoint-20261022/production-run'; r=json.loads((out/'fresh-run.json').read_text()); rid=r['runId']; integrity=json.loads((root/f'outputs/storage-fresh-backup-{rid}-integrity.json').read_text()); assert integrity['pass'] and integrity['coupledAndResumed']
ssh=['ssh','-p','32422','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
p=subprocess.run(ssh+['sudo cat /var/lib/enclave-indexd/fresh-backup/'+rid+'.receipt.json'],capture_output=True,text=True,check=True,timeout=30); vm=json.loads(p.stdout);assert vm['outcome']=='complete' and vm['sourceResumed'] and vm['coupled']
command=shlex.join(['sudo','python3',r['vmRunner'],'remove','--run-id',rid,'--token',vm['token'],'--confirm','remove-plaintext'])
p=subprocess.run(ssh+[command],capture_output=True,text=True,timeout=60)
(out/'fresh-remove.out').write_text(p.stdout+p.stderr)
print(p.stdout);raise SystemExit(p.returncode)
