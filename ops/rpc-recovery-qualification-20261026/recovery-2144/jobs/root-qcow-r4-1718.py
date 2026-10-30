from pathlib import Path
import shutil,hashlib
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025');s=p/'qcow-allocation-nbd-stage/r3';d=p/'qcow-allocation-nbd-stage/r4'
shutil.copytree(s,d,ignore=shutil.ignore_patterns('runs','__pycache__','*.pyc'))
for f in d.rglob('*'):
 if f.is_file() and f.name!='SHA256SUMS':
  f.chmod(0o644);t=f.read_text().replace('stage/r3','stage/r4').replace('alloc-r3','alloc-r4')
  if f.name=='tests.sh':t=t.replace('python3 -I -B $S/tests','python3 -I -B -u $S/tests')
  f.write_text(t)
(d/'SHA256SUMS').chmod(0o644)
files=sorted(f for f in d.rglob('*') if f.is_file() and f.name!='SHA256SUMS')
(d/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.relative_to(d)}\n' for f in files))
print('r3 actual five tests OK; wrapper false failure due buffered stdout after unittest OK. r4 only unbuffers fixture stdout and relabels paths.')
