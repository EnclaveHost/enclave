from pathlib import Path
import json,hashlib,subprocess,time,resource,importlib.util
resource.setrlimit(resource.RLIMIT_FSIZE,(128<<20,128<<20))
p=Path('/output');spec=json.loads(Path('/spec.json').read_text())
def verify():
 for n,b in spec.items():assert hashlib.file_digest(Path(b['path']).open('rb'),'sha256').hexdigest()==b['sha256'],n
verify()
resources={n:spec[n]['path'] for n in ('openhcl_boot','underhill_kernel','underhill_initrd','linux_kernel','linux_initrd')}
(p/'resources.json').write_text(json.dumps({'resources':resources})+'\n')
argv=[spec['igvmfilegen']['path'],'manifest','-m',spec['manifest']['path'],'-r',str(p/'resources.json'),'-o',str(p/'golden.bin')]
with (p/'intent.json').open('x') as f:json.dump({'argv':argv,'inputs':spec},f)
start=time.monotonic()
with (p/'compiler.log').open('x') as f:r=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=f,stderr=f,timeout=60)
assert r.returncode==0
verify()
h=hashlib.file_digest((p/'golden.bin').open('rb'),'sha256').hexdigest()
result={'firmwareSha256':h,'expectedSha256':'c7084346a908465404fdf6de332a76b3c2ca844101eb9e8071aa8a1468f197ec','exactBytes':h=='c7084346a908465404fdf6de332a76b3c2ca844101eb9e8071aa8a1468f197ec','elapsed':time.monotonic()-start,'deployed':False}
module=importlib.util.spec_from_file_location('build','/src/isolation/m3/build-rpc-igvm.py');m=importlib.util.module_from_spec(module);module.loader.exec_module(m)
result['header']=m.check_igvm(p/'golden.bin')
v=json.loads((p/'golden-vbs.json').read_text());result['vbsBootDigest']=v['series'][0]['reference']['vbs_boot_digest'].lower()
result['expectedVbsBootDigest']='6a3135a9378688805a36905c5e0f1443bb65031014618f390a6e3d6e2d90b86a'
(p/'EQUIVALENCE.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
assert result['exactBytes'] and result['vbsBootDigest']==result['expectedVbsBootDigest']
