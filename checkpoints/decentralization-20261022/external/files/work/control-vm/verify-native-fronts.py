import subprocess,json,hashlib,datetime
from pathlib import Path
ips={'us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'}
def curl(url,*args):return subprocess.check_output(['curl','-fsS','--max-time','20',*args,url])
ca=curl('https://134.199.235.187/native/ca.pem');p=Path('work/control-vm/native-ca-public.pem');p.write_bytes(ca)
der=subprocess.check_output(['openssl','x509','-in',str(p),'-outform','DER']);assert hashlib.sha256(der).hexdigest()=='86bf2c486d9dea6ca6cafc6d5649f965121bd4d7ab0c7c8b8cbf88822641a62c'
results=[]
for region,ip in ips.items():
 assert curl('https://'+ip+'/recovery-health')==b'Enclave recovery ingress'
 native=json.loads(curl('https://'+ip+'/native/resolve?name=api.enclavehost.eth'));assert set(native['addresses'])==set(ips.values())
 assert curl('https://api.enclavehost.eth/recovery-health','--cacert',str(p),'--resolve','api.enclavehost.eth:443:'+ip)==b'Enclave recovery ingress'
 for name in ['enclave.host','www.enclave.host']:
  body=curl('https://'+name+'/','-L','--resolve',name+':443:'+ip,'--resolve','enclave.host:443:'+ip);assert hashlib.sha256(body).hexdigest()=='fe4bcf82935494e7a0e04a7387369a55e3baf13375073a6a24ac7d2e016cf62d'
 results.append({'region':region,'ip':ip,'publicIPCertificateValid':True,'nativeCertificateValidWithPinnedCA':True,'discoveryUsesFourProviders':True,'websiteHashVerified':True});print(region+': native and public TLS passed',flush=True)
Path('outputs/native-fronts-verification.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'providers':results,'caSha256':hashlib.sha256(der).hexdigest()},indent=2)+'\n')
