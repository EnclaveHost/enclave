from pathlib import Path
import shutil,subprocess,tempfile,json
root=Path(__file__).resolve().parents[1]
mutations=[
 ('owner','reclaim.mjs','lower(r.owner)===LIMIT.owner','true'),
 ('original-expiry','reclaim.mjs','Number(r.leaseUntil)===prior[id].leaseUntil','true'),
 ('guest-record','reclaim.mjs','g.recordSha256===RECORDS[id]','true'),
 ('fee-cap','reclaim.mjs','BigInt(r.lease.maxChargeWei)<=BigInt(LIMIT.maxChargeWei)','true'),
 ('receipt','reclaim.mjs','r.receiptVerified===true','true'),
 ('approval','reclaim.mjs','a.humanApproved===true','true'),
 ('quiescence','runtime-guard.mjs','<360000000n','<300000000n'),
]
for name,file,old,new in mutations:
 with tempfile.TemporaryDirectory(prefix='metal0-reclaim-mut-',dir=root.parent) as d:
  d=Path(d)
  for p in ['reclaim.mjs','guest-health.mjs','runtime-guard.mjs','test/reclaim.test.mjs']:
   q=d/p;q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/p,q)
  p=d/file;s=p.read_text();assert s.count(old)==1,(name,s.count(old));p.write_text(s.replace(old,new))
  r=subprocess.run(['node','--test',str(d/'test/reclaim.test.mjs')],capture_output=True,text=True,timeout=20)
  assert r.returncode==1 and 'ERR_ASSERTION' in r.stdout,(name,r.returncode,r.stdout[-2000:],r.stderr)
  print(json.dumps({'mutation':name,'detected':True}))
