import hashlib,json,pathlib,subprocess
root=pathlib.Path('/tmp/enclave-rpc-coverage-8ee67fe4e')
pins={'kzgcheck': '00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb', 'origin_extract.py': '6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c', 'coverage_gate.py': 'b4f6d639c3f9b12f73938d5993ce0897fe56dcbec1ada3123c4ad80d0ff3854b'}
for name,want in pins.items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==want,name+' digest mismatch'
r=subprocess.run([str(root/'kzgcheck'),'blob'],input='0x'+'00'*131072+'\n',text=True,capture_output=True,timeout=20,check=True)
assert r.stdout.strip()=='OK 0xc0'+'00'*47,r.stdout[:200]
for name in ['origin_extract.py','coverage_gate.py']:
 subprocess.run(['python3',str(root/name),'--help'],capture_output=True,timeout=10,check=True)
print(json.dumps({'pins':pins,'zeroBlobCommitment':'verified','pythonEntryPoints':'load','historicalCoverageChecked':False}))
