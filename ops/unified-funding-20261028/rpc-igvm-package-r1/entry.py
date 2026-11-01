from pathlib import Path
import importlib.util,json,subprocess,resource
resource.setrlimit(resource.RLIMIT_FSIZE,(128<<20,128<<20))
subprocess.run(['/usr/bin/python3','-B','/src/test/rpc-server/test_rpc_igvm_build.py','-v'],check=True,timeout=15)
subprocess.run(['/usr/bin/python3','-B','/src/isolation/m3/build-rpc-igvm.py','--spec','/spec.json','--out','/output/firmware'],check=True,timeout=90)
p=Path('/output/firmware');r=json.loads((p/'build.json').read_text())
assert all(r[k] is False for k in ('platformAccepted','hardwareMeasured','vmgsCreated','guestBooted','rpcReady','deployed'))
print(json.dumps({'candidateAssembled':True,'firmware':r['firmware'],'vbsBootDigest':r['vbsBootDigest'],'activated':False}))
