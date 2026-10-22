import subprocess,json,pathlib
services=['enclave-api-relay','enclave-dns','enclave-native-discovery','nan-wasm-gateway','enclave-policy-migration-bridge','enclave-provider-migration-mirror']
rows=[]
for s in services:
 result=subprocess.check_output(['systemctl','show',s,'-p','MainPID','--value'],text=True).strip()
 e={}
 if result!='0': e=dict(x.split('=',1) for x in pathlib.Path('/proc/'+result+'/environ').read_bytes().decode().split('\0') if '=' in x)
 shape={}
 for k,v in e.items():
  if k.endswith(('_FILE','_DIR','_PATH','_REPO','_WORK')) and v.startswith('/') and '\n' not in v: shape[k]=v
 rows.append({'service':s,'environmentKeys':sorted(e),'fileSettings':shape})
state=pathlib.Path('/var/lib/private/enclave-relay')
print(json.dumps({'services':rows,'stateEntries':[{'name':p.name,'directory':p.is_dir(),'bytes':p.stat().st_size if p.is_file() else None} for p in state.iterdir()]},indent=2))
