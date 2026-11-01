import subprocess,json,pathlib,time
assert pathlib.Path('/var/lib/cloud/data/instance-id').read_text().strip()=='rpc-owned-856ca36204b44e39816d6894807c8c6d'
print(json.dumps({'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'at':time.time()}))
for args in [ ['systemctl','show','enclave-rpc-el.service','enclave-rpc-cl.service','-p','ActiveState','-p','SubState','-p','MainPID','-p','ExecMainStatus','-p','MemoryCurrent','-p','MemoryPeak'], ['journalctl','-u','enclave-rpc-el.service','-u','enclave-rpc-cl.service','-n','35','--no-pager','-o','cat'], ['findmnt','-n','-o','TARGET,UUID,FSTYPE,OPTIONS','--target','/srv/enclave-l1-pair/data'] ]:
 r=subprocess.run(args,capture_output=True,text=True,timeout=3);print(json.dumps({'argv':args,'rc':r.returncode,'stdout':r.stdout[-24000:],'stderr':r.stderr[-2000:]}))
