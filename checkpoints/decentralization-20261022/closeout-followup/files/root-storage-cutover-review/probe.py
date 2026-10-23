"""Pure offline preflight reproduction. Derived v28 receipts, no real backup/decryption claim."""
from pathlib import Path
import datetime, hashlib, importlib.util, json
here=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('cutover',here/'frozen-cutover.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
now=datetime.datetime(2026,10,23,6,0,tzinfo=datetime.timezone.utc)
base=json.loads((here/'base-public-receipt.json').read_text())
base.update(dbVersion=28,verifiedAt='2026-10-23T05:59:00Z',runId='derived-v28-fresh-verification')
rows=[]
for label,captured in [('missing-capture-time',None),('fresh-capture','2026-10-23T05:30:00Z'),('old-capture-reverified','2026-01-01T00:00:00Z')]:
 r=dict(base)
 if captured:r['capturedAt']=captured
 result=c.t1_preflight((here/'vm-state.txt').read_text(),r,now)
 rows.append({'case':label,'capturedAt':captured,'verifiedAt':r['verifiedAt'],**result})
assert all(r['verdict']=='GO' for r in rows), rows
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSha256':hashlib.sha256((here/'frozen-cutover.py').read_bytes()).hexdigest(),'finding':'Backup age is computed from verifiedAt; missing or old capturedAt passes. The existing archive verifier emits a new verifiedAt when rechecking an old archive and omits the authenticated manifest capturedAt.','cases':rows,'labels':['The receipt is a derived v28 test input based on a public v26 receipt. No actual v28 archive is claimed, modified, or decrypted.','The real frozen preflight function ran offline. This proves its acceptance logic, not a live data-loss event.'],'productionChanged':False,'required':'Expose capturedAt and source/run/archive binding from the verified archive manifest; enforce capture age separately from verification age. Keep a writer-stopped capture in the enrollment sequence and do not treat not-ready as proof that CAS enrollment has not occurred.'}
Path('outputs/decentralization-audit/storage-cutover-backup-freshness-review-20261023.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
