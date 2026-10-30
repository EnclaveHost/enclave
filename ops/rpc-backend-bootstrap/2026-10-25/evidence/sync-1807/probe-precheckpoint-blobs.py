#!/usr/bin/env python3
"""Bounded availability diagnostic only; deliberately NOT a readiness/coverage verdict."""
import sys,json,pathlib,datetime,hashlib,signal
ROOT=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
sys.path.insert(0,str(ROOT/'source/ops/rpc-backend-bootstrap/2026-10-25/coverage'))
from coverage_gate import Client,Kzg,kzg_to_versioned_hash
signal.alarm(120)
client=Client('http://127.0.0.1:28645','http://127.0.0.1:25052',5,30,4,8<<20)
kzg=Kzg(str(ROOT/'coverage-stage/kzgcheck/target/release/kzgcheck'),'00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb')
report={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'availability-diagnostic-only','coverageVerified':False,'authenticatedCanonicalHistory':False,'checkpointSlot':15508320,'samples':[]}
try:
 for start in [15505056,15506080,15508000]:
  record={'startSlot':start};report['samples'].append(record)
  for slot in range(start,start+4):
   status,doc=client.bn('/eth/v2/beacon/blocks/'+str(slot))
   if status==404:continue
   if status!=200:raise RuntimeError('block HTTP '+str(status))
   commitments=doc['data']['message']['body'].get('blob_kzg_commitments',[])
   if not commitments:continue
   status,blobs=client.bn('/eth/v1/beacon/blobs/'+str(slot))
   record.update(slot=slot,executionOptimistic=doc.get('execution_optimistic'),blockFinalized=doc.get('finalized'),commitments=len(commitments),blobHTTP=status)
   if status!=200:
    record['error']=blobs;break
   data=blobs.get('data',[])
   if len(data)!=len(commitments):raise RuntimeError('blob count mismatch')
   hashes=[]
   for blob,expected in zip(data,commitments):
    actual,error=kzg.commitment(blob)
    if error or actual!=expected:raise RuntimeError('KZG commitment mismatch '+str(error))
    hashes.append(kzg_to_versioned_hash(actual))
   record.update(blobCount=len(data),allKzgCommitmentsMatch=True,versionedHashes=hashes)
   break
  else:record['noBlobBearingBlockWithinBound']=True
 report['requests']=client.requests
finally:kzg.close()
path=pathlib.Path(sys.argv[1])
with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
print(json.dumps(report,indent=2))
