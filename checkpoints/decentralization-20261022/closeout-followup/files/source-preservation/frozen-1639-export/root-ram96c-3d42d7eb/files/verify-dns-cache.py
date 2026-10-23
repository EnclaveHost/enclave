import importlib.util,pathlib,json,hashlib,datetime
s=importlib.util.spec_from_file_location('ipfs_fetch','work/windows-final-runtime-integration-20261023/candidate/wasm/ipfs_fetch.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=pathlib.Path('work/nucbox-ram96-20261023');proof=json.loads((p/'dns-artifact-proof.json').read_text());data=m.fetch_verified(proof['cid'],'http://134.199.235.187:8189',5000000,20)
assert len(data)==proof['bytes'] and hashlib.sha256(data).hexdigest()==proof['sha256']
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gateway':'http://134.199.235.187:8189','cid':proof['cid'],'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'verified':True}
(p/'cache-readback.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))
