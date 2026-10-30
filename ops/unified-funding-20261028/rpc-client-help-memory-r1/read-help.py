from pathlib import Path
import hashlib,json,subprocess,os,time,sys
p=Path(__file__).resolve().parent
root=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/payload-v2')
expected={'base':'9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f','reth':'8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250','lighthouse':'11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96'}
assert os.sched_getaffinity(0)=={1}
assert os.readlink('/proc/self/ns/net')!=sys.argv[1],'network namespace missing'
with (p/'ATTEMPT.json').open('x') as f:json.dump({'startedAt':time.time(),'action':'pinned help only; no datadir/client startup'},f)
rows=[]
for name,argv in [('base',['rpc','--help']),('reth',['node','--help']),('lighthouse',['bn','--help'])]:
 exe=root/'bin'/name
 with exe.open('rb') as f:before=hashlib.file_digest(f,'sha256').hexdigest()
 assert before==expected[name]
 with (p/(name+'.help.txt')).open('xb') as out:
  r=subprocess.run([str(exe),*argv],cwd=p,env={'PATH':'/usr/bin:/bin','LANG':'C','TERM':'dumb'},stdout=out,stderr=subprocess.STDOUT,timeout=20)
 size=(p/(name+'.help.txt')).stat().st_size
 assert size<=2*1024*1024
 with exe.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==before
 rows.append({'name':name,'sha256':before,'argv':argv,'rc':r.returncode,'outputBytes':size})
 assert r.returncode==0
with (p/'RESULT.json').open('x') as f:json.dump({'finishedAt':time.time(),'networkNamespace':True,'results':rows,'noDataDirSupplied':True,'noNodeStarted':True},f,indent=2)
print(json.dumps(rows))
