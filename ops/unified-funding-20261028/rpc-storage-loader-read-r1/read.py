from pathlib import Path
import subprocess,json,os
p=Path('/home/controladmin/rpc-storage-client-package-20261031-r2/nbd')
r=subprocess.run([str(p/'lib/ld-linux-x86-64.so.2'),'--inhibit-cache','--library-path',str(p/'lib'),'--list',str(p/'nbd-client')],env={'PATH':'/usr/bin:/bin','LANG':'C'},capture_output=True,text=True,timeout=5)
assert len(r.stdout)<16384 and len(r.stderr)<4096
print(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr,'invocation':os.environ.get('INVOCATION_ID')}))
