from pathlib import Path
import hashlib,json,os,resource,shutil,subprocess,time
p=Path('/output');start=time.monotonic();resource.setrlimit(resource.RLIMIT_FSIZE,(256<<20,256<<20))
def verify():
 assert hashlib.file_digest(Path('/protoc').open('rb'),'sha256').hexdigest()=='507a3f321ae7df61982468712aa78531842ea88e3a3f6934bb9dcbd47881b921'
 pins=json.loads(Path('/pins.json').read_text());patch=json.loads(Path('/patch-pin.json').read_text())
 assert hashlib.sha256(Path('/current.patch').read_bytes()).hexdigest()==patch['sha256']
 for n,h in pins.items():assert hashlib.file_digest((Path('/frozen')/n).open('rb'),'sha256').hexdigest()==h,n
 return len(pins)
verify()
shutil.copytree('/frozen/igvm','/build/igvm',symlinks=True)
shutil.copytree('/frozen/openvmm','/build/openvmm',symlinks=True)
shutil.copyfile('/build/openvmm/Cargo.lock','/build/igvm/Cargo.lock')
shutil.copytree('/previous-target','/output/target',symlinks=True)
rows=[]
def run(label,argv,cwd):
 with (p/(label+'.log')).open('x') as f:r=subprocess.run(argv,cwd=cwd,stdout=f,stderr=f,stdin=subprocess.DEVNULL,timeout=max(.01,600-(time.monotonic()-start)))
 rows.append({'phase':label,'exit':r.returncode,'elapsed':time.monotonic()-start});(p/'PHASES.json').write_text(json.dumps(rows,indent=2)+'\n');assert r.returncode==0,label
run('generator-build',['/tools/bin/cargo','rustc','--offline','-j','1','-p','igvmfilegen','--profile','rpc-tool','--','-C','debug-assertions=no'],'/build/openvmm')
tool=Path('/output/target/rpc-tool/igvmfilegen')
assert tool.is_file() and tool.stat().st_size<128<<20
r={'sourcePins':verify(),'pinsUnchanged':True,'phases':rows,'tool':{'bytes':tool.stat().st_size,'sha256':hashlib.file_digest(tool.open('rb'),'sha256').hexdigest()},'platformAccepted':False,'deployed':False}
(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
