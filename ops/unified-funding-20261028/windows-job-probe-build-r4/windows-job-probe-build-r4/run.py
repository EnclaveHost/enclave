from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'build-input-pins.json').read_text())
for n,h in m.items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
with (p/'build.log').open('x') as out:
 r=subprocess.run(['clang-cl','/nologo','/c','/O1','/GS-','/Zl','/W4','/clang:-fno-builtin','/I/usr/include/wine/windows','/I/usr/include/wine/msvcrt','/Fo'+str(p/'job-probe.obj'),str(p/'job-probe.c')],cwd=p,stdout=out,stderr=subprocess.STDOUT,timeout=30)
 if r.returncode==0:r=subprocess.run(['lld-link','/entry:entry','/subsystem:console','/nodefaultlib','/machine:x64','/out:'+str(p/'job-probe.exe'),str(p/'job-probe.obj'),'/usr/lib/wine/x86_64-windows/libkernel32.a'],cwd=p,stdout=out,stderr=subprocess.STDOUT,timeout=30)
(p/'build.rc').write_text(str(r.returncode)+'\n')
if r.returncode==0:(p/'artifact.json').write_text(json.dumps({'sha256':hashlib.sha256((p/'job-probe.exe').read_bytes()).hexdigest(),'bytes':(p/'job-probe.exe').stat().st_size,'executed':False,'windowsQualified':False},indent=2)+'\n')
raise SystemExit(r.returncode)
