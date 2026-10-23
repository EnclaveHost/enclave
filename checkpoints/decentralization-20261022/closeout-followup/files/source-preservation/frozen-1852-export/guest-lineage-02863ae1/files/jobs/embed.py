#!/usr/bin/env python3
# embed.py: hashes the kit inputs and checks whether 64 KiB windows from each appear verbatim in the production runtime.bin
import hashlib, sys
K='/home/steven/Documents/Codex/2026-10-18/wo/work/certificate-release-prep/image-kit/inputs/'
B=open('/home/steven/enclave-bench/nucbox-public-web-20261005/runtime.bin','rb').read()
print('runtime.bin', hashlib.sha256(B).hexdigest(), len(B))
for name in ['runtime-baseline.cpio.gz','kernel-vtpm.elf','openhcl-shield.cpio.gz']:
    x=open(K+name,'rb').read()
    hits=[]
    for frac in (0.1,0.5,0.9):
        o=int(len(x)*frac)&~0xfff; w=x[o:o+65536]
        hits.append(B.find(w))
    print(name, hashlib.sha256(x).hexdigest(), len(x), 'window offsets in runtime.bin:', hits)
    del x
