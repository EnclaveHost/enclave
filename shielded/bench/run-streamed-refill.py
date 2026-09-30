#!/usr/bin/env python3
"""Bounded real-model matrix benchmark, not an inference throughput test."""
import argparse,json,subprocess,resource
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('build',type=Path);p.add_argument('model',type=Path)
p.add_argument('--reps',type=int,default=4);p.add_argument('--resume',action='store_true')
p.add_argument('--hash',choices=['openssl','openssl-direct'],default='openssl')
p.add_argument('--batches',nargs='+',type=int,default=[16,64,256,512]);a=p.parse_args()
cases=[(t,b) for t in ['blk.0.ffn_gate.weight','blk.0.ffn_down.weight','output.weight'] for b in a.batches]
out=a.build/('matrix-results.jsonl' if a.hash=='openssl' else 'direct-results.jsonl')
done=set()
if a.resume and out.exists():
    counts={}
    for line in out.read_text().splitlines():
        r=json.loads(line);key=(r['tensor'],r['batch']);counts[key]=counts.get(key,0)+1
    done={key for key,n in counts.items() if n>=a.reps}
def limit_memory():
    resource.setrlimit(resource.RLIMIT_AS,(6<<30,6<<30))
with out.open('a' if a.resume else 'w') as f:
    for tensor,b in cases:
        if (tensor,b) in done:continue
        print(f'{tensor} batch={b}',flush=True)
        subprocess.run(['nice','-n','10',str(a.build/'bench'),str(a.build),str(a.model),tensor,'paired',str(b),str(a.reps),a.hash],stdout=f,check=True,timeout=180,preexec_fn=limit_memory)
        f.flush()
print(out)
