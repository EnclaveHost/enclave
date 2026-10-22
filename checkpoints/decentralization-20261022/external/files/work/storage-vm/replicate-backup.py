from pathlib import Path
import subprocess,json,datetime
p=Path('outputs/storage-post-cutover-backup.json');report=json.loads(p.read_text());f=Path('work/private/indexd-recovery')/report['file'];dest='/var/lib/enclave-recovery/indexd-minipc-20261019';h=report['sha256']
for host in ['us-west','eu-central','ap-southeast','ca-east']:
 subprocess.run(['ssh','-o','BatchMode=yes',host,'install -d -m 0700 '+dest],check=True,capture_output=True)
 subprocess.run(['scp','-q',str(f),host+':'+dest+'/'+f.name+'.partial'],check=True,capture_output=True)
 command='set -eu; f='+dest+'/'+f.name+'.partial; chmod 600 "$f"; test "$(sha256sum "$f" | cut -d\' \' -f1)" = '+h+'; mv "$f" '+dest+'/'+f.name+'; stat -c "%a" '+dest+' '+dest+'/'+f.name
 r=subprocess.run(['ssh','-o','BatchMode=yes',host,command],check=True,capture_output=True,text=True);assert r.stdout.splitlines()==['700','600']
 report['replicas'].append({'host':host,'path':dest+'/'+f.name,'sha256Verified':True,'directoryMode':'0700','fileMode':'0600','decryptionKeyCopied':False,'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()});p.write_text(json.dumps(report,indent=2)+'\n');print(host+': encrypted backup verified',flush=True)
