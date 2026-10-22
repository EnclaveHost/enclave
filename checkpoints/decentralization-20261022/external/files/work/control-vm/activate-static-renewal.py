import subprocess
script='''from pathlib import Path
import shutil,subprocess,time,json
p=Path('/etc/enclave-bootstrap-tls');u=Path('/etc/systemd/system/enclave-bootstrap-tls.service');assert (p/'Caddyfile').read_bytes()==(p/'Caddyfile.before-renewal').read_bytes();assert u.read_bytes()==(p/'service.before-renewal').read_bytes()
shutil.copy2(p/'Caddyfile.renewal-prepared',p/'Caddyfile');shutil.copy2(p/'service.renewal-prepared',u)
try:
 subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','enclave-bootstrap-tls'],check=True);time.sleep(1)
 r=subprocess.run(['curl','-fsS','--max-time','8','--resolve','enclave.host:28443:127.0.0.1','https://enclave.host:28443/index.html'],capture_output=True);assert r.returncode==0
 import hashlib
 assert hashlib.sha256(r.stdout).hexdigest()=='fe4bcf82935494e7a0e04a7387369a55e3baf13375073a6a24ac7d2e016cf62d'
except:
 shutil.copy2(p/'Caddyfile.before-renewal',p/'Caddyfile');shutil.copy2(p/'service.before-renewal',u);subprocess.run(['systemctl','daemon-reload']);subprocess.run(['systemctl','restart','enclave-bootstrap-tls']);raise
print('Challenge forwarding active; website hash unchanged')
'''
for h in ['us-west','eu-central','ap-southeast','ca-east']:
 r=subprocess.run(['ssh',h,'python3','-'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1000:];print(h+': '+r.stdout.strip(),flush=True)
