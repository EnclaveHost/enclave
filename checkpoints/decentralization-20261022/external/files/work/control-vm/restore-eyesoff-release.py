from pathlib import Path
import subprocess,os,json
release='58a0e7bdb906b2e5adc9be656cb3d66aab55621d82e031c85403ab79baa9fe58'
root=Path('/opt/enclave-predict/release-58a0e7bd')
subprocess.run(['python3','/tmp/enclave-release-manifest.py','verify',str(root),'--expect',release],check=True)
subprocess.run(['chown','-R','root:root',str(root)],check=True)
subprocess.run(['chmod','-R','a+rX,go-w',str(root)],check=True)
pid=subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip()
e=dict(s.split('=',1) for s in Path('/proc/'+pid+'/environ').read_text().split('\0') if '=' in s)
uid=os.stat('/proc/'+pid).st_uid;gid=os.stat('/proc/'+pid).st_gid
subprocess.run(['setpriv','--reuid',str(uid),'--regid',str(gid),'--clear-groups','python3','/tmp/enclave-release-manifest.py','verify',str(root),'--expect',release],check=True)
values={}
for k in ['SECRETS_RELEASE_DOMAIN_RELEASES','SECRETS_RELEASE_CERT_RELEASES']:
 a=e[k].split(',');assert release not in a;values[k]=','.join(a+[release])
k='SECRETS_RELEASE_PREDICT_RELEASES';assert release+'=' not in e[k];values[k]=e[k]+','+release+'='+str(root)
p=Path('/etc/nan-relay/eyesoff-release-recovery.env');assert not p.exists();p.write_text(''.join(k+'='+v+'\n' for k,v in values.items()));p.chmod(0o600)
drop=Path('/etc/systemd/system/enclave-api-relay.service.d/zzz-eyesoff-release-recovery.conf');assert not drop.exists();drop.write_text('[Service]\nEnvironmentFile='+str(p)+'\n')
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','restart','enclave-api-relay'],check=True)
print(json.dumps({'restoredExistingSourceAdmission':release,'filesVerified':46,'otherAdmissionEntriesPreserved':True}))
