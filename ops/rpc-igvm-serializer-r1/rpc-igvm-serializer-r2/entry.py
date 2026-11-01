from pathlib import Path
import hashlib,json,os,resource,shutil,subprocess,time
p=Path('/output');start=time.monotonic();resource.setrlimit(resource.RLIMIT_FSIZE,(256<<20,256<<20))
shutil.copytree('/frozen/igvm','/build/igvm',symlinks=True)
shutil.copytree('/frozen/openvmm','/build/openvmm',symlinks=True)
shutil.copyfile('/build/openvmm/Cargo.lock','/build/igvm/Cargo.lock')
rows=[]
def run(label,argv,cwd):
 with (p/(label+'.log')).open('x') as f:r=subprocess.run(argv,cwd=cwd,stdout=f,stderr=f,stdin=subprocess.DEVNULL,timeout=max(.01,600-(time.monotonic()-start)))
 rows.append({'phase':label,'exit':r.returncode,'elapsed':time.monotonic()-start});(p/'PHASES.json').write_text(json.dumps(rows,indent=2)+'\n');assert r.returncode==0,label
run('igvm-tests',['/tools/bin/cargo','test','--offline','-j','1','-p','igvm','--features','corim','--lib'],'/build/igvm')
run('generator-build',['/tools/bin/cargo','build','--offline','-j','1','-p','igvmfilegen','--profile','rpc-tool'],'/build/openvmm')
tool=Path('/output/target/rpc-tool/igvmfilegen')
assert tool.is_file() and tool.stat().st_size<128<<20
r={'phases':rows,'tool':{'bytes':tool.stat().st_size,'sha256':hashlib.file_digest(tool.open('rb'),'sha256').hexdigest()},'platformAccepted':False,'deployed':False}
(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
