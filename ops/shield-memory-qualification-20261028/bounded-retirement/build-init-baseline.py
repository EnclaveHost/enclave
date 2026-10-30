from pathlib import Path
import subprocess,os,hashlib,json,shutil
p=Path(__file__).parent;b=p/'init-baseline-build';b.mkdir(exist_ok=False)
s=Path('/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init/isolation/m2/dominit.c')
m=Path('/home/steven/.cache/enclave-isolation/musl-1.2.6');installed=Path('/home/steven/enclave-prod/release-af50d526/template/init')
def digest(f):
 with f.open('rb') as h:return hashlib.file_digest(h,'sha256').hexdigest()
cmd=['/usr/bin/gcc','-specs',str(m/'lib/musl-gcc.specs'),'-static','-O2','-o',str(b/'init'),str(s)]
env={k:v for k,v in os.environ.items() if k not in ['CPATH','C_INCLUDE_PATH','LIBRARY_PATH','GCC_EXEC_PREFIX','COMPILER_PATH']}
with (b/'build.log').open('w') as log:subprocess.run(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
a=digest(b/'init');i=digest(installed)
r={'command':cmd,'sourceSha256':digest(s),'muslSpecsSha256':digest(m/'lib/musl-gcc.specs'),'muslLibcSha256':digest(m/'lib/libc.a'),'builtSha256':a,'installedSha256':i,'exactMatch':a==i}
(b/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
