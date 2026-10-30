from pathlib import Path
import subprocess
p=Path(__file__).resolve().parent
with (p/'result.log').open('x') as log:
 r=subprocess.run(['node',str(p/'precheck.mjs')],stdout=log,stderr=subprocess.STDOUT,timeout=30)
 if r.returncode==0:r=subprocess.run(['node','--check',str(p/'generated.mjs')],stdout=log,stderr=subprocess.STDOUT,timeout=30)
(p/'result.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
