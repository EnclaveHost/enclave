from pathlib import Path
import subprocess,sys,json
host=sys.argv[1]
script='''from pathlib import Path
import subprocess,json,time
root=Path('/etc/enclave-dns-front');drop=Path('/etc/systemd/system/enclave-route-dns.service.d/90-dns-front.conf');unit=Path('/etc/systemd/system/enclave-dns-front.service')
assert not drop.exists() and not unit.exists()
drop.parent.mkdir(exist_ok=True);drop.write_bytes((root/'route-dropin.prepared').read_bytes());unit.write_bytes((root/'service.prepared').read_bytes())
try:
 subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','enclave-route-dns'],check=True)
 subprocess.run(['systemctl','start','enclave-dns-front'],check=True);time.sleep(4)
 for svc in ['enclave-route-dns','enclave-dns-front']:subprocess.run(['systemctl','is-active','--quiet',svc],check=True)
 # A valid SOA proves the public listener and its local backend are available.
 r=subprocess.run(['dig','@IP','app.enclave.host','SOA','+time=3','+tries=1','+short'],capture_output=True,text=True);assert r.returncode==0 and 'ns-us-west.enclave.host' in r.stdout,r.stdout
 subprocess.run(['systemctl','enable','enclave-dns-front'],check=True,stdout=subprocess.DEVNULL)
except:
 subprocess.run(['systemctl','stop','enclave-dns-front']);drop.unlink(missing_ok=True);unit.unlink(missing_ok=True);subprocess.run(['systemctl','daemon-reload']);subprocess.run(['systemctl','restart','enclave-route-dns']);raise
print(json.dumps({'active':True,'rollbackOnActivationFailure':True,'parentDelegationChanged':False}))
'''
ips={'us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'}
r=subprocess.run(['ssh',host,'python3','-'],input=script.replace('IP',ips[host]),text=True,capture_output=True);assert r.returncode==0,r.stderr[-2000:];print(host+': '+r.stdout.strip())
