from pathlib import Path
import datetime,hashlib,json,subprocess
root=Path('/home/steven/Documents/Codex/2026-10-18/wo')
report_path=root/'outputs/indexd-full-recovery-verification.json'
report=json.loads(report_path.read_text())
private=root/'work/private/indexd-recovery'
files=[report['file'],report['auxiliaryGeoIP']['file']]
expected={report['file']:report['sha256'],report['auxiliaryGeoIP']['file']:report['auxiliaryGeoIP']['sha256']}
for name in files:
 assert hashlib.sha256((private/name).read_bytes()).hexdigest()==expected[name]
opts=['-o','BatchMode=yes','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(root/'work/ssh-%h-%p')]
dest='/var/lib/enclave-recovery/indexd-20261019-full'
for host,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 target='root@'+ip
 subprocess.run(['ssh',*opts,target,'install -d -m 0700 '+dest],check=True,timeout=30)
 for name in files:
  subprocess.run(['scp','-q',*opts,str(private/name),target+':'+dest+'/'+name+'.partial'],check=True,timeout=600)
  command='set -eu; chmod 0600 '+dest+'/'+name+'.partial; test "$(sha256sum '+dest+'/'+name+'.partial | cut -d\' \' -f1)" = '+expected[name]+'; mv '+dest+'/'+name+'.partial '+dest+'/'+name
  subprocess.run(['ssh',*opts,target,command],check=True,timeout=40)
 checks=subprocess.check_output(['ssh',*opts,target,'stat -c "%a %n" '+dest+' '+ ' '.join(dest+'/'+f for f in files)],text=True,timeout=30)
 assert checks.splitlines()[0].startswith('700 ') and all(l.startswith('600 ') for l in checks.splitlines()[1:])
 result={'host':host,'address':ip,'path':dest,'sha256':expected,'directoryMode':'0700','fileMode':'0600','decryptionKeyCopied':False,'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 report['replicas']=[r for r in report.get('replicas',[]) if r['host']!=host]+[result]
 report_path.write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'host':host,'verified':True}),flush=True)
