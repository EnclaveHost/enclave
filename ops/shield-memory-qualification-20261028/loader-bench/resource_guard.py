"""Read-only QEMU inventory and conservative canary resource accounting."""
import os
from pathlib import Path
import re
GIB=1<<30
MIB=1<<20

def memory_bytes(text):
    # QEMU -m defaults to MiB; reject complex/maxmem configurations.
    m=re.fullmatch(r'(\d+)([MG]?)',text)
    if not m: raise ValueError('unsupported QEMU RAM value')
    return int(m[1])*(GIB if m[2]=='G' else MIB)

def snapshot(proc='/proc', exclude_pid=None):
    result=[]
    for p in Path(proc).iterdir():
        if not p.name.isdigit() or int(p.name)==exclude_pid: continue
        try:
            cmd=(p/'cmdline').read_bytes().split(b'\0')
            if not cmd or b'qemu-system' not in cmd[0].split(b'/')[-1]: continue
            args=[x.decode() for x in cmd if x]
            if args.count('-m')!=1: raise ValueError('QEMU memory not explicit')
            mem=memory_bytes(args[args.index('-m')+1])
            st=(p/'stat').read_text()
            start=st[st.rindex(')')+2:].split()[19]
            cg=(p/'cgroup').read_text().strip()
            result.append(dict(pid=int(p.name),start=start,ram_bytes=mem,cgroup=cg))
        except FileNotFoundError:
            # Process races are rechecked immediately before/throughout boot.
            continue
    return sorted(result,key=lambda x:x['pid'])

def check(expected,current,pending):
    if current!=expected: raise ValueError('production QEMU inventory changed')
    nominal=sum(x['ram_bytes'] for x in current)
    if pending<nominal: raise ValueError('pending reserve below all existing guests nominal RAM')
    return nominal
