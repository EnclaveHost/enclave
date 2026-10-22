import subprocess,sys
script='''from pathlib import Path
import subprocess,shutil,time,json
p=Path('/etc/enclave-bootstrap-tls');unit=Path('/etc/systemd/system/enclave-bootstrap-tls.service')
assert not (p/'Caddyfile.before-static').exists();shutil.copy2(p/'Caddyfile',p/'Caddyfile.before-static');shutil.copy2(unit,p/'service.before-static')
shutil.copy2(p/'Caddyfile.site-prepared',p/'Caddyfile');shutil.copy2(p/'service.site-prepared',unit)
try:
 subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','enclave-bootstrap-tls'],check=True);time.sleep(2);subprocess.run(['systemctl','is-active','--quiet','enclave-bootstrap-tls'],check=True)
 r=subprocess.run(['curl','--fail','--silent','--show-error','--resolve','enclave.host:28443:127.0.0.1','https://enclave.host:28443/index.html'],capture_output=True);assert r.returncode==0
 import hashlib
 assert hashlib.sha256(r.stdout).hexdigest()=='fe4bcf82935494e7a0e04a7387369a55e3baf13375073a6a24ac7d2e016cf62d'
except:
 shutil.copy2(p/'Caddyfile.before-static',p/'Caddyfile');shutil.copy2(p/'service.before-static',unit);subprocess.run(['systemctl','daemon-reload']);subprocess.run(['systemctl','restart','enclave-bootstrap-tls']);raise
print(json.dumps({'staticFrontActive':True,'publicProviderRoutesChanged':False,'websiteExactHashVerified':True}))
'''
r=subprocess.run(['ssh',sys.argv[1],'python3','-'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1500:];print(r.stdout)
