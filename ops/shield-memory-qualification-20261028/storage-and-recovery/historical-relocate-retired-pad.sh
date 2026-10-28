#!/bin/bash
# Archive relocation only. Never attach or reuse this retired pad in a guest.
set -euo pipefail
src=/home/steven/enclave-prod/retire-switch-preservation-20261028/pad.target
dir=/vm/enclave-volumes/rpc-retired-pad-preservation-20261028
export PAD_RELOCATE_SOURCE="$src" PAD_RELOCATE_DIR="$dir"
python3 - <<'PY'
import os, stat, subprocess, json
from pathlib import Path
s=Path(os.environ['PAD_RELOCATE_SOURCE']); d=Path(os.environ['PAD_RELOCATE_DIR'])
st=s.lstat()
assert stat.S_ISREG(st.st_mode) and st.st_ino==199101093 and st.st_nlink==1 and st.st_size==549755813888
assert subprocess.check_output(['findmnt','-no','SOURCE','-T','/vm'],text=True).strip()=='/dev/mapper/cryptvm'
assert subprocess.run(['fuser','-s',str(s)]).returncode==1, 'Source has an open user or inspection failed'
v=os.statvfs('/vm'); assert v.f_bavail*v.f_frsize >= st.st_size+(103<<30), 'Insufficient destination reserve'
d.mkdir(mode=0o700,exist_ok=False)
(d/'before.json').write_text(json.dumps({'source':str(s),'inode':st.st_ino,'device':st.st_dev,'size':st.st_size,'mtime_ns':st.st_mtime_ns,'ctime_ns':st.st_ctime_ns,'mode':stat.S_IMODE(st.st_mode),'links':st.st_nlink},indent=2)+'\n')
print('Preflight passed: single-link retired file, no open user, encrypted destination with reserve',flush=True)
PY
cp --reflink=never --sparse=always --preserve=mode,timestamps -- "$src" "$dir/pad.target.partial"
python3 - <<'PY'
from pathlib import Path
import os
p=Path(os.environ['PAD_RELOCATE_DIR'])/'pad.target.partial'
with p.open('rb') as f:os.fsync(f.fileno())
print('Copy complete and fsynced; full source and destination verification follows',flush=True)
PY
sha256sum -- "$src" > "$dir/source.sha256"
sha256sum -- "$dir/pad.target.partial" > "$dir/destination.sha256"
python3 - <<'PY'
from pathlib import Path
import os,json,subprocess
s=Path(os.environ['PAD_RELOCATE_SOURCE']);d=Path(os.environ['PAD_RELOCATE_DIR']);before=json.loads((d/'before.json').read_text())
st=s.lstat()
assert not s.is_symlink() and st.st_nlink==1
for k,actual in [('inode',st.st_ino),('device',st.st_dev),('size',st.st_size),('mtime_ns',st.st_mtime_ns),('ctime_ns',st.st_ctime_ns)]:assert before[k]==actual,k
assert subprocess.run(['fuser','-s',str(s)]).returncode==1
h=(d/'source.sha256').read_text().split()[0];assert h==(d/'destination.sha256').read_text().split()[0]
q=d/'pad.target';assert not q.exists();os.rename(d/'pad.target.partial',q)
def syncdir(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
syncdir(d)
record={'source':str(s),'destination':str(q),'sha256':h,'bytes':st.st_size,'purpose':'retired one-time pad archive; NEVER reuse in a guest','verified':True,'originalPathRetainedAsSymlink':True}
with (d/'RESULT.json').open('x') as f:json.dump(record,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
syncdir(d)
link=s.with_name('pad.target.relocated-link');assert not link.exists() and not link.is_symlink();os.symlink(q,link)
# Source is removed only by this atomic replacement after durable full readback verification.
os.replace(link,s);syncdir(s.parent)
print(json.dumps(record),flush=True)
PY
