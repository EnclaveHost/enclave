from pathlib import Path
import subprocess,json,concurrent.futures
report=Path('outputs/control-recovery-backup.json');meta=json.loads(report.read_text());name='enclave-control-minipc-20261019.tar.zst.gpg';ips={'eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'}
cleanup='#!/bin/sh\nsystemctl stop enclave-control-backup-transfer.service\n'+''.join('ufw --force delete allow proto tcp from '+ip+' to 134.199.235.187 port 28192\n' for ip in ips.values())+'ufw --force delete deny proto tcp from any to 134.199.235.187 port 28192\n'
setup='''from pathlib import Path
import subprocess
p=Path('/root/enclave-control-backup-transfer-cleanup.sh');assert not p.exists();p.write_text(CLEANUP);p.chmod(0o700)
assert '28192' not in subprocess.check_output(['ufw','status'],text=True)
subprocess.run(['ufw','insert','1','deny','proto','tcp','from','any','to','134.199.235.187','port','28192'],check=True,capture_output=True)
for ip in IPS:subprocess.run(['ufw','insert','1','allow','proto','tcp','from',ip,'to','134.199.235.187','port','28192'],check=True,capture_output=True)
subprocess.run(['systemd-run','--unit=enclave-control-backup-transfer-cleanup','--on-active=20m',str(p)],check=True,capture_output=True)
subprocess.run(['systemd-run','--unit=enclave-control-backup-transfer','-p','NoNewPrivileges=yes','-p','ProtectSystem=strict','-p','PrivateTmp=yes','-p','MemoryMax=64M','/usr/bin/python3','-m','http.server','28192','--bind','134.199.235.187','--directory','/var/lib/enclave-recovery/control'],check=True,capture_output=True)
'''
r=subprocess.run(['ssh','us-west','python3','-'],input='CLEANUP='+repr(cleanup)+'\nIPS='+repr(list(ips.values()))+'\n'+setup,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1000:]
def one(region):
 script='''from pathlib import Path
import subprocess,hashlib,os
p=Path('/var/lib/enclave-recovery/control');p.mkdir(parents=True,exist_ok=True,mode=0o700);p.chmod(0o700)
temp=p/(NAME+'.transfer');subprocess.run(['curl','--fail','--silent','--show-error','--connect-timeout','15','--max-time','900','http://134.199.235.187:28192/'+NAME,'-o',str(temp)],check=True)
assert temp.stat().st_size==SIZE
assert hashlib.file_digest(temp.open('rb'),'sha256').hexdigest()==SHA
temp.chmod(0o600);os.replace(temp,p/NAME)
'''
 r=subprocess.run(['ssh',region,'python3','-'],input='NAME='+repr(name)+'\nSIZE='+repr(meta['archiveBytes'])+'\nSHA='+repr(meta['sha256'])+'\n'+script,text=True,capture_output=True);assert r.returncode==0,(region,r.stderr[-600:]);return region
try:
 with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
  for f in concurrent.futures.as_completed([pool.submit(one,r) for r in ips]):
   region=f.result();meta['providers'].append(region);report.write_text(json.dumps(meta,indent=2)+'\n');print(region+': encrypted control backup verified',flush=True)
finally:
 subprocess.run(['ssh','us-west','/root/enclave-control-backup-transfer-cleanup.sh\nsystemctl stop enclave-control-backup-transfer-cleanup.timer'],check=True,stdout=subprocess.DEVNULL)
private=Path('work/private/control-recovery');dec=subprocess.Popen(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(private/'passphrase'),'--decrypt',str(private/name)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
check=subprocess.run(['tar','--zstd','-tf','-'],stdin=dec.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE);dec.stdout.close();err=dec.stderr.read();rc=dec.wait();assert check.returncode==rc==0,(check.stderr[-400:],err[-400:]);meta['decryptAndArchiveIntegrityVerified']=True;report.write_text(json.dumps(meta,indent=2)+'\n');print('Control recovery archive integrity verified; temporary transfer service removed',flush=True)
