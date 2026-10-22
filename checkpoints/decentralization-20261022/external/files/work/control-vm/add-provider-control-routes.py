from pathlib import Path
import subprocess,json,sys
script='''from pathlib import Path
import json,subprocess,os,shutil,time
p=Path('/etc/enclave-network/provider-pinned-8b37c37.json');backup=p.with_name(p.stem+'.before-control-routes.json');assert not backup.exists();x=json.loads(p.read_text())
for name in ['enclave.host','www.enclave.host','ipfs.enclave.host','api.enclave.host','mcp.enclave.host','get.enclave.host']:assert name not in x['localRoutes']
for name in ['enclave.host','www.enclave.host','ipfs.enclave.host']:x['localRoutes'][name]={'host':'127.0.0.1','tls':28443,'http':28080}
for name in ['api.enclave.host','mcp.enclave.host','get.enclave.host']:x['localRoutes'][name]={'host':'127.0.0.1','tls':30443,'http':30080}
shutil.copy2(p,backup);backup.chmod(0o600);temp=p.with_suffix('.control-next');temp.write_text(json.dumps(x,indent=2)+'\\n');temp.chmod(0o600);os.replace(temp,p)
try:
 subprocess.run(['systemctl','restart','enclave-network-provider'],check=True);time.sleep(2);subprocess.run(['systemctl','is-active','--quiet','enclave-network-provider'],check=True)
except:
 shutil.copy2(backup,p);subprocess.run(['systemctl','restart','enclave-network-provider']);raise
print(json.dumps({'newPlatformRoutes':6,'providerActive':True,'publicDNSChanged':False}))
'''
for h in sys.argv[1:]:
 r=subprocess.run(['ssh',h,'python3','-'],input=script,capture_output=True,text=True);assert r.returncode==0,r.stderr[-1000:];print(h+': '+r.stdout.strip(),flush=True)
