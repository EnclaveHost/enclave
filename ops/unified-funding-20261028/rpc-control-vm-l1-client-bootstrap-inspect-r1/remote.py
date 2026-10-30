import subprocess,json,pathlib
names=['enclavel1attachr1.slice','enclavel1trialr1.slice','enclavel1guardianr1.slice','enclave-rpc-l1-helper-r1.service','enclave-rpc-l1-watch-r1.service','enclave-rpc-l1-nbd-r1.service','enclave-rpc-l1-el-trial-r1.service','enclave-rpc-l1-cl-trial-r1.service','enclave-rpc-l1-bootstrap-r1.service']
out={}
for name in names:
 r=subprocess.run(['/usr/bin/systemctl','show',name,'--property=LoadState,ActiveState,MainPID,InvocationID,Transient,FragmentPath,DropInPaths,ControlGroup'],capture_output=True,text=True,timeout=3)
 out[name]={'rc':r.returncode,'properties':r.stdout,'stderr':r.stderr}
for p in ['/run/enclave-rpc-l1-client-r1','/var/lib/enclave-rpc-l1-client-r1','/srv/enclave-l1-pair','/sys/module/nbd','/run/systemd/system/enclavel1attachr1.slice','/run/systemd/system/enclavel1trialr1.slice','/run/systemd/system/enclavel1guardianr1.slice']:
 q=pathlib.Path(p);out[p]={'exists':q.exists()}
print(json.dumps(out))
