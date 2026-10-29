from pathlib import Path
import os,hashlib,json,subprocess
p=Path(__file__).resolve().parent;os.sched_setaffinity(0,{1})
m=json.loads((p/'build-input-pins.json').read_text())
def check():
 for n,h in m.items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
check();b=p/'build';c=p/'candidate';steps=[]
clang=['/usr/bin/clang-cl','/nologo','/c','/O1','/GS-','/Zl','/W4','/WX','/clang:-fno-builtin','/clang:-mno-stack-arg-probe','/D_WIN32_WINNT=0x0A00','/DUNICODE','/D_UNICODE','/I/usr/include/wine/windows','/I/usr/include/wine/msvcrt']
with (p/'build.log').open('x') as out:
 def run(args):
  steps.append(args);out.write(json.dumps(args)+'\n');out.flush()
  r=subprocess.run(args,stdout=out,stderr=subprocess.STDOUT,cwd=b,timeout=35)
  if r.returncode:raise subprocess.CalledProcessError(r.returncode,args)
 rc=0
 try:
  for name in ['no-crt','owned-job']:run(clang+['/Fo'+str(b/(name+'.obj')),str(c/(name+'.c'))])
  run(['/usr/bin/lld-link','/entry:entry','/subsystem:console','/nodefaultlib','/machine:x64','/dynamicbase','/nxcompat','/highentropyva','/out:'+str(b/'owned-job.exe'),str(b/'owned-job.obj'),str(b/'no-crt.obj'),'/usr/lib/wine/x86_64-windows/libkernel32.a'])
  pins={n:hashlib.sha256((b/n).read_bytes()).hexdigest() for n in ['owned-job.exe','job-probe.exe']}
  defs=['/DEXPECT_LAUNCHER_SHA256="'+pins['owned-job.exe']+'"','/DEXPECT_PROBE_SHA256="'+pins['job-probe.exe']+'"']
  run(clang+defs+['/Fo'+str(b/'admission-envelope.obj'),str(c/'admission-envelope.c')])
  run(['/usr/bin/lld-link','/entry:entry','/subsystem:console','/nodefaultlib','/machine:x64','/dynamicbase','/nxcompat','/highentropyva','/out:'+str(b/'admission-envelope.exe'),str(b/'admission-envelope.obj'),str(b/'no-crt.obj'),'/usr/lib/wine/x86_64-windows/libkernel32.a','/usr/lib/wine/x86_64-windows/libbcrypt.a'])
 except subprocess.CalledProcessError as e:rc=e.returncode
 except subprocess.TimeoutExpired:rc=124
check();(p/'build-steps.json').write_text(json.dumps(steps,indent=2)+'\n');(p/'build.rc').write_text(str(rc)+'\n')
a={}
for f in sorted(b.glob('*.exe')):
 a[f.name]={'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'bytes':f.stat().st_size,'executed':False,'nativeQualified':False,'reused':f.name=='job-probe.exe'}
 with (p/(f.stem+'-pe.txt')).open('x') as out:subprocess.run(['/usr/bin/llvm-readobj','--file-headers','--coff-imports',str(f)],stdout=out,stderr=subprocess.STDOUT,timeout=10,check=True)
(p/'artifacts.json').write_text(json.dumps(a,indent=2)+'\n')
raise SystemExit(rc)
